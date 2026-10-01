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

/*
 * ------------------------------------------------------------
 * DEVICE WRITE QUEUES
 * ------------------------------------------------------------
 *
 * WhatsApp can update several Signal keys very quickly.
 * Supabase writes are therefore serialized per device.
 */

const writeQueues = new Map<string, Promise<void>>();

function queueDeviceWrite<T>(
  deviceId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = writeQueues.get(deviceId) ?? Promise.resolve();

  const next = previous
    .catch(() => {
      // Keep the queue alive even if the previous operation failed.
    })
    .then(operation);

  const cleanup = next.then(
    () => undefined,
    () => undefined
  );

  writeQueues.set(deviceId, cleanup);

  return next;
}

/*
 * ------------------------------------------------------------
 * JSON / BUFFER HELPERS
 * ------------------------------------------------------------
 */

function encode(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, BufferJSON.replacer)
  );
}

function decode<T>(value: unknown): T {
  return JSON.parse(
    JSON.stringify(value),
    BufferJSON.reviver
  ) as T;
}

/*
 * ------------------------------------------------------------
 * LOCAL AUTH MIGRATION
 * ------------------------------------------------------------
 */

async function readLocalAuthFile(
  localAuthPath: string,
  fileName: string
): Promise<unknown | null> {
  try {
    const filePath = path.join(
      localAuthPath,
      fileName
    );

    const raw = await readFile(
      filePath,
      "utf8"
    );

    return JSON.parse(
      raw,
      BufferJSON.reviver
    );
  } catch {
    return null;
  }
}

/*
 * ------------------------------------------------------------
 * SUPABASE READ
 * ------------------------------------------------------------
 */

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

  if (error) {
    throw error;
  }

  return data?.auth_value ?? null;
}

/*
 * ------------------------------------------------------------
 * SUPABASE WRITE
 * ------------------------------------------------------------
 */

async function writeCloudRows(
  deviceId: string,
  rows: AuthRow[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await queueDeviceWrite(
    deviceId,
    async () => {
      const { error } = await supabase
        .from("leo_auth")
        .upsert(rows, {
          onConflict:
            "device_id,auth_type,auth_key",
        });

      if (error) {
        throw error;
      }
    }
  );
}

/*
 * ------------------------------------------------------------
 * SUPABASE DELETE
 * ------------------------------------------------------------
 */

async function deleteCloudRows(
  deviceId: string,
  authType: string,
  authKeys: string[]
): Promise<void> {
  if (authKeys.length === 0) {
    return;
  }

  await queueDeviceWrite(
    deviceId,
    async () => {
      const { error } = await supabase
        .from("leo_auth")
        .delete()
        .eq("device_id", deviceId)
        .eq("auth_type", authType)
        .in("auth_key", authKeys);

      if (error) {
        throw error;
      }
    }
  );
}

/*
 * ------------------------------------------------------------
 * CREATE SUPABASE AUTH STATE
 * ------------------------------------------------------------
 */

export async function createSupabaseAuthState(
  deviceId: string,
  localAuthPath: string
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  /*
   * ----------------------------------------------------------
   * LOAD CREDS
   * ----------------------------------------------------------
   */

  let creds = decode<AuthenticationCreds>(
    await readCloudRow(
      deviceId,
      "creds",
      "creds"
    )
  );

  /*
   * If cloud credentials don't exist, try the old
   * local auth_info directory once.
   */

  if (!creds) {
    const localCreds =
      await readLocalAuthFile(
        localAuthPath,
        "creds.json"
      );

    if (localCreds) {
      creds =
        localCreds as AuthenticationCreds;

      await writeCloudRows(
        deviceId,
        [
          {
            device_id: deviceId,
            auth_type: "creds",
            auth_key: "creds",
            auth_value: encode(creds),
          },
        ]
      );

      console.log(
        `☁️ [${deviceId}] Imported local WhatsApp credentials into Supabase.`
      );
    } else {
      creds = initAuthCreds();
    }
  }

  /*
   * ----------------------------------------------------------
   * SIGNAL KEYS
   * ----------------------------------------------------------
   */

  const keys: AuthenticationState["keys"] = {
    get: async (type, ids) => {
      const result: {
        [_: string]:
          SignalDataTypeMap[typeof type];
      } = {};

      if (ids.length === 0) {
        return result;
      }

      const authKeys = ids.map(
        (id) => `${type}:${id}`
      );

      const {
        data: rows,
        error,
      } = await supabase
        .from("leo_auth")
        .select(
          "auth_key, auth_value"
        )
        .eq(
          "device_id",
          deviceId
        )
        .eq(
          "auth_type",
          "key"
        )
        .in(
          "auth_key",
          authKeys
        );

      if (error) {
        throw error;
      }

      const rowMap = new Map(
        (rows ?? []).map(
          (row) => [
            row.auth_key,
            row.auth_value,
          ]
        )
      );

      /*
       * Read keys.
       *
       * Missing keys are migrated from the
       * old local Baileys auth directory.
       */

      const cloudRowsToWrite: AuthRow[] = [];

      for (const id of ids) {
        const authKey =
          `${type}:${id}`;

        let value =
          rowMap.get(authKey) ??
          null;

        if (value == null) {
          value =
            await readLocalAuthFile(
              localAuthPath,
              `${type}-${id}.json`
            );

          if (value != null) {
            cloudRowsToWrite.push({
              device_id: deviceId,
              auth_type: "key",
              auth_key: authKey,
              auth_value: encode(value),
            });
          }
        }

        /*
         * Baileys expects AppStateSyncKeyData
         * objects to be converted back to proto.
         */

        if (
          type ===
            "app-state-sync-key" &&
          value
        ) {
          value =
            proto.Message
              .AppStateSyncKeyData
              .fromObject(
                value as object
              );
        }

        result[id] =
          value as SignalDataTypeMap[
            typeof type
          ];
      }

      if (
        cloudRowsToWrite.length > 0
      ) {
        await writeCloudRows(
          deviceId,
          cloudRowsToWrite
        );
      }

      return result;
    },

    set: async (data) => {
      const rows: AuthRow[] = [];

      const deletes =
        new Map<
          string,
          string[]
        >();

      for (
        const category in data
      ) {
        const categoryData =
          data[
            category as keyof SignalDataTypeMap
          ];

        if (!categoryData) {
          continue;
        }

        for (
          const id in categoryData
        ) {
          const value =
            categoryData[id];

          const authKey =
            `${category}:${id}`;

          if (value) {
            rows.push({
              device_id:
                deviceId,
              auth_type:
                "key",
              auth_key:
                authKey,
              auth_value:
                encode(value),
            });
          } else {
            const list =
              deletes.get(
                category
              ) ?? [];

            list.push(
              authKey
            );

            deletes.set(
              category,
              list
            );
          }
        }
      }

      /*
       * Write all changed keys first.
       */

      await writeCloudRows(
        deviceId,
        rows
      );

      /*
       * Then remove deleted keys.
       */

      for (
        const [
          category,
          authKeys,
        ] of deletes
      ) {
        await deleteCloudRows(
          deviceId,
          "key",
          authKeys
        );
      }
    },
  };

  /*
   * ----------------------------------------------------------
   * SAVE CREDS
   * ----------------------------------------------------------
   */

  const saveCreds =
    async (): Promise<void> => {
      await writeCloudRows(
        deviceId,
        [
          {
            device_id:
              deviceId,
            auth_type:
              "creds",
            auth_key:
              "creds",
            auth_value:
              encode(creds),
          },
        ]
      );
    };

  return {
    state: {
      creds,
      keys,
    },

    saveCreds,
  };
}

/*
 * ------------------------------------------------------------
 * LIST DEVICES STORED IN SUPABASE
 * ------------------------------------------------------------
 */

export async function listPersistedDeviceIds(): Promise<
  string[]
> {
  const ids =
    new Set<string>();

  const {
    data,
    error,
  } = await supabase
    .from("leo_auth")
    .select("device_id")
    .eq(
      "auth_type",
      "creds"
    );

  if (error) {
    throw error;
  }

  for (
    const row of data ?? []
  ) {
    if (
      typeof row.device_id ===
        "string" &&
      /^device-\d+$/.test(
        row.device_id
      )
    ) {
      ids.add(
        row.device_id
      );
    }
  }

  return [
    ...ids,
  ].sort(
    (a, b) =>
      a.localeCompare(
        b,
        undefined,
        {
          numeric: true,
        }
      )
  );
}

/*
 * ------------------------------------------------------------
 * DELETE DEVICE AUTH
 * ------------------------------------------------------------
 */

export async function deleteSupabaseAuthState(
  deviceId: string
): Promise<void> {
  await queueDeviceWrite(
    deviceId,
    async () => {
      const {
        error,
      } = await supabase
        .from("leo_auth")
        .delete()
        .eq(
          "device_id",
          deviceId
        );

      if (error) {
        throw error;
      }
    }
  );

  writeQueues.delete(
    deviceId
  );
}