import "dotenv/config";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SECRET_KEY are required for cloud WhatsApp auth."
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

type AuthRow = {
  device_id: string;
  auth_type: string;
  auth_key: string;
  auth_value: unknown;
  updated_at?: string;
};

function encode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

async function readLocalAuthFile(
  localAuthPath: string,
  fileName: string
): Promise<unknown | null> {
  try {
    const filePath = path.join(localAuthPath, fileName);
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw, BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function readCloudRow(
  deviceId: string,
  authType: string,
  authKey: string
): Promise<unknown | null> {
  const { data, error } = await supabase
    .from("leo_auth")
    .select("auth_value")
    .eq("device_id", deviceId)
    .eq("auth_type", authType)
    .eq("auth_key", authKey)
    .maybeSingle();

  if (error) throw error;
  return data?.auth_value ?? null;
}

async function writeCloudRows(rows: AuthRow[]): Promise<void> {
  if (rows.length === 0) return;

  const { error } = await supabase.from("leo_auth").upsert(rows, {
    onConflict: "device_id,auth_type,auth_key",
  });

  if (error) throw error;
}

async function deleteCloudRows(
  deviceId: string,
  authType: string,
  authKeys: string[]
): Promise<void> {
  if (authKeys.length === 0) return;

  const { error } = await supabase
    .from("leo_auth")
    .delete()
    .eq("device_id", deviceId)
    .eq("auth_type", authType)
    .in("auth_key", authKeys);

  if (error) throw error;
}

/**
 * Supabase-backed replacement for Baileys useMultiFileAuthState.
 *
 * The local auth directory is used only as a one-time migration source.
 * Once a row exists in Supabase, the cloud copy is authoritative.
 */
export async function createSupabaseAuthState(
  deviceId: string,
  localAuthPath: string
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  let creds = decode<AuthenticationCreds>(
    await readCloudRow(deviceId, "creds", "creds")
  );

  if (!creds) {
    const localCreds = await readLocalAuthFile(localAuthPath, "creds.json");

    if (localCreds) {
      creds = localCreds as AuthenticationCreds;
      await writeCloudRows([
        {
          device_id: deviceId,
          auth_type: "creds",
          auth_key: "creds",
          auth_value: encode(creds),
        },
      ]);
      console.log(`☁️ [${deviceId}] Imported local WhatsApp credentials into Supabase.`);
    } else {
      creds = initAuthCreds();
    }
  }

  const keys: AuthenticationState["keys"] = {
    get: async (type, ids) => {
      const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
      const authKeys = ids.map((id) => `${type}:${id}`);

      const { data: rows, error } = await supabase
        .from("leo_auth")
        .select("auth_key, auth_value")
        .eq("device_id", deviceId)
        .eq("auth_type", "key")
        .in("auth_key", authKeys);

      if (error) throw error;

      const rowMap = new Map(
        (rows ?? []).map((row) => [row.auth_key, row.auth_value])
      );

      await Promise.all(
        ids.map(async (id) => {
          const authKey = `${type}:${id}`;
          let value = rowMap.get(authKey) ?? null;

          // One-time migration from the existing local Baileys auth folder.
          if (value == null) {
            value = await readLocalAuthFile(
              localAuthPath,
              `${type}-${id}.json`
            );

            if (value != null) {
              await writeCloudRows([
                {
                  device_id: deviceId,
                  auth_type: "key",
                  auth_key: authKey,
                  auth_value: encode(value),
                },
              ]);
            }
          }

          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }

          data[id] = value as SignalDataTypeMap[typeof type];
        })
      );

      return data;
    },

    set: async (data) => {
      const rows: AuthRow[] = [];
      const deletes = new Map<string, string[]>();

      for (const category in data) {
        const categoryData = data[category as keyof SignalDataTypeMap];
        if (!categoryData) continue;

        for (const id in categoryData) {
          const value = categoryData[id];
          const authKey = `${category}:${id}`;

          if (value) {
            rows.push({
              device_id: deviceId,
              auth_type: "key",
              auth_key: authKey,
              auth_value: encode(value),
            });
          } else {
            const list = deletes.get(category) ?? [];
            list.push(authKey);
            deletes.set(category, list);
          }
        }
      }

      await writeCloudRows(rows);

      for (const authKeys of deletes.values()) {
        await deleteCloudRows(deviceId, "key", authKeys);
      }
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await writeCloudRows([
        {
          device_id: deviceId,
          auth_type: "creds",
          auth_key: "creds",
          auth_value: encode(creds),
        },
      ]);
    },
  };
}

export async function listPersistedDeviceIds(): Promise<string[]> {
  const ids = new Set<string>();

  const { data, error } = await supabase
    .from("leo_auth")
    .select("device_id")
    .eq("auth_type", "creds");

  if (error) throw error;

  for (const row of data ?? []) {
    if (typeof row.device_id === "string" && /^device-\d+$/.test(row.device_id)) {
      ids.add(row.device_id);
    }
  }

  return [...ids].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

export async function deleteSupabaseAuthState(deviceId: string): Promise<void> {
  const { error } = await supabase
    .from("leo_auth")
    .delete()
    .eq("device_id", deviceId);

  if (error) throw error;
}
