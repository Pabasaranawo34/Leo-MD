import "dotenv/config";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SECRET_KEY are required for cloud persistence."
  );
}

const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

const BUCKET = "leo-md-data";
const DATABASE_OBJECT = "database/leo.db";
const SNAPSHOT_PATH = "./data/.leo-cloud-backup.db";
const PERSIST_INTERVAL_MS = 60_000;

let persistenceRunning = false;
let persistenceTimer: NodeJS.Timeout | null = null;

async function ensureBucket(): Promise<void> {
  const { data, error } = await supabase.storage.getBucket(BUCKET);

  if (!error && data) return;

  const { error: createError } = await supabase.storage.createBucket(BUCKET, {
    public: false,
  });

  // Another process may have created it between getBucket() and createBucket().
  if (createError && !/already exists|duplicate/i.test(createError.message)) {
    throw createError;
  }
}

/**
 * Restore only when the local SQLite file does not already exist.
 * This prevents a developer's existing local database from being silently
 * replaced by an older cloud snapshot.
 */
export async function restoreDatabaseFromSupabase(
  databasePath: string
): Promise<void> {
  await mkdir(path.dirname(databasePath), { recursive: true });

  try {
    await readFile(databasePath);
    console.log("💾 Local SQLite database found; keeping local copy.");
    return;
  } catch {
    // No local database yet. Try the cloud snapshot.
  }

  await ensureBucket();

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(DATABASE_OBJECT);

  if (error) {
    // A brand-new deployment may not have a cloud database yet.
    if (/not found|object not found|404/i.test(error.message)) {
      console.log("☁️ No cloud SQLite snapshot yet; starting a new database.");
      return;
    }
    throw error;
  }

  if (!data) return;

  const bytes = Buffer.from(await data.arrayBuffer());
  const tempPath = `${databasePath}.restore-${Date.now()}`;
  await writeFile(tempPath, bytes);

  try {
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    await rm(databasePath, { force: true });
    await writeFile(databasePath, bytes);
    console.log(`☁️ Restored SQLite database from Supabase (${bytes.length} bytes).`);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function uploadDatabaseSnapshot(
  db: Database.Database,
  databasePath: string
): Promise<void> {
  if (persistenceRunning) return;
  persistenceRunning = true;

  const backupPath = `${SNAPSHOT_PATH}.${process.pid}`;

  try {
    await ensureBucket();
    await rm(backupPath, { force: true });

    // better-sqlite3's online backup creates a consistent SQLite snapshot
    // while the bot continues using the live database.
    await db.backup(backupPath);

    const bytes = await readFile(backupPath);
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(DATABASE_OBJECT, new Blob([bytes], { type: "application/x-sqlite3" }), {
        contentType: "application/x-sqlite3",
        upsert: true,
        cacheControl: "0",
      });

    if (error) throw error;

    console.log(`☁️ SQLite snapshot uploaded (${bytes.length} bytes).`);
  } catch (error) {
    console.error("❌ SQLite cloud snapshot failed:", error);
  } finally {
    await rm(backupPath, { force: true });
    persistenceRunning = false;
  }
}

export function startDatabasePersistence(
  db: Database.Database,
  databasePath: string
): void {
  if (persistenceTimer) return;

  // Upload the current database once immediately, then every minute.
  void uploadDatabaseSnapshot(db, databasePath);

  persistenceTimer = setInterval(() => {
    void uploadDatabaseSnapshot(db, databasePath);
  }, PERSIST_INTERVAL_MS);

  persistenceTimer.unref();

  console.log("☁️ SQLite cloud persistence: ENABLED (60s snapshots)");
}

export async function flushDatabasePersistence(
  db: Database.Database,
  databasePath: string
): Promise<void> {
  if (persistenceTimer) {
    clearInterval(persistenceTimer);
    persistenceTimer = null;
  }

  await uploadDatabaseSnapshot(db, databasePath);
}

export async function loadCloudOwner(): Promise<string | null> {
  const { data, error } = await supabase
    .from("leo_data")
    .select("value")
    .eq("key", "owner")
    .maybeSingle();

  if (error) throw error;

  const value = data?.value as { ownerNumber?: unknown } | null | undefined;
  return typeof value?.ownerNumber === "string" ? value.ownerNumber : null;
}

export async function saveCloudOwner(ownerNumber: string): Promise<void> {
  const { error } = await supabase.from("leo_data").upsert(
    {
      key: "owner",
      value: { ownerNumber },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (error) throw error;
}
