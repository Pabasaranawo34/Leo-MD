import {
  setDeviceQR,
  setDeviceStatus,
  setPairHandler,
} from "./web.js";
import {
  createSupabaseAuthState,
  deleteSupabaseAuthState,
  listPersistedDeviceIds,
} from "./supabase-auth.js";
import "dotenv/config";















import makeWASocket, {







  DisconnectReason,







  downloadContentFromMessage,














} from "@whiskeysockets/baileys";















import { Boom } from "@hapi/boom";







import qrcode from "qrcode-terminal";







import Groq, { toFile } from "groq-sdk";







import sharp from "sharp";







import pino from "pino";







import Database from "better-sqlite3";
import {
  flushDatabasePersistence,
  loadCloudOwner,
  restoreDatabaseFromSupabase,
  saveCloudOwner,
  startDatabasePersistence,
} from "./supabase-db-persistence.js";

import { spawn } from "node:child_process";

import { mkdir, readFile, writeFile, rm, readdir, readFile as readFileFromDisk, stat, unlink } from "node:fs/promises";

import path from "node:path";















// ============================================================







// CONFIG







// ============================================================















const GROQ_API_KEY = process.env.GROQ_API_KEY;







const POLLINATIONS_API_KEY =







  process.env.POLLINATIONS_API_KEY;















const OWNER_FILE = "./data/owner.json";

let OWNER_NUMBER =
  process.env.OWNER_NUMBER?.replace(/\D/g, "") || "";















if (!GROQ_API_KEY) {







  console.error("❌ GROQ_API_KEY is missing in .env");







  process.exit(1);







}






























const groq = new Groq({







  apiKey: GROQ_API_KEY,







});















const TEXT_MODEL = "openai/gpt-oss-20b";







const VISION_MODEL = "qwen/qwen3.8-27b";







const TRANSCRIPTION_MODEL =







  "whisper-large-v3-turbo";















// ============================================================
// DEPLOYMENT OWNER
// ============================================================

async function loadSavedOwner(): Promise<void> {
  if (OWNER_NUMBER) return;

  try {
    const cloudOwner = await loadCloudOwner();
    if (cloudOwner) {
      OWNER_NUMBER = cloudOwner.replace(/\D/g, "");
      return;
    }
  } catch (error) {
    console.error("⚠️ Could not load owner from Supabase:", error);
  }

  try {
    const raw = await readFile(OWNER_FILE, "utf8");
    const saved = JSON.parse(raw) as { ownerNumber?: string };
    OWNER_NUMBER = saved.ownerNumber?.replace(/\D/g, "") || "";

    if (OWNER_NUMBER) {
      await saveCloudOwner(OWNER_NUMBER);
    }
  } catch {}
}

async function saveOwner(number: string): Promise<void> {
  const normalized = number.replace(/\D/g, "");
  if (!normalized) return;
  OWNER_NUMBER = normalized;

  await mkdir("./data", { recursive: true });
  await writeFile(
    OWNER_FILE,
    JSON.stringify({ ownerNumber: normalized }, null, 2),
    "utf8"
  );

  try {
    await saveCloudOwner(normalized);
  } catch (error) {
    console.error("⚠️ Could not save owner to Supabase:", error);
  }
}

// ============================================================







// DATABASE







// ============================================================















const DB_PATH = "./data/leo.db";

await restoreDatabaseFromSupabase(DB_PATH);

const db = new Database(DB_PATH);















db.pragma("journal_mode = WAL");















db.exec(`







  CREATE TABLE IF NOT EXISTS settings (



    jid TEXT PRIMARY KEY,



    private_ai_enabled INTEGER NOT NULL DEFAULT 1,



    group_ai_enabled INTEGER NOT NULL DEFAULT 0,
    anti_link_enabled INTEGER NOT NULL DEFAULT 0,
    welcome_enabled INTEGER NOT NULL DEFAULT 0,
    goodbye_enabled INTEGER NOT NULL DEFAULT 0



  );







  CREATE TABLE IF NOT EXISTS global_settings (



    id INTEGER PRIMARY KEY CHECK (id = 1),



    private_ai_enabled INTEGER NOT NULL DEFAULT 1,



    group_ai_enabled INTEGER NOT NULL DEFAULT 0



  );







  INSERT OR IGNORE INTO global_settings



  (id, private_ai_enabled, group_ai_enabled)



  VALUES (1, 1, 0);







  CREATE TABLE IF NOT EXISTS messages (







    id INTEGER PRIMARY KEY AUTOINCREMENT,







    jid TEXT NOT NULL,







    role TEXT NOT NULL,







    content TEXT NOT NULL,







    created_at INTEGER NOT NULL







  );















  CREATE INDEX IF NOT EXISTS idx_messages_jid







  ON messages(jid);

  CREATE TABLE IF NOT EXISTS group_warnings (
    jid TEXT NOT NULL,
    user_jid TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (jid, user_jid)
  );







`);







// Add global auto-reaction setting to existing databases.



try {



  db.exec(`



    ALTER TABLE global_settings



    ADD COLUMN auto_react_enabled INTEGER NOT NULL DEFAULT 1



  `);



} catch {



  // Column already exists.



}







// Add global auto-reaction setting to existing databases.



try {



  db.exec(`



    ALTER TABLE global_settings



    ADD COLUMN auto_react_enabled INTEGER NOT NULL DEFAULT 1



  `);



} catch {



  // Column already exists.



}







// Add per-group anti-link setting to existing databases.
try {
  db.exec(`
    ALTER TABLE settings
    ADD COLUMN anti_link_enabled INTEGER NOT NULL DEFAULT 0
  `);
} catch {
  // Column already exists.
}

// Add per-group welcome/goodbye settings to existing databases.
try {
  db.exec(`ALTER TABLE settings ADD COLUMN welcome_enabled INTEGER NOT NULL DEFAULT 0`);
} catch {}

try {
  db.exec(`ALTER TABLE settings ADD COLUMN goodbye_enabled INTEGER NOT NULL DEFAULT 0`);
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_personas (
    jid TEXT PRIMARY KEY,
    persona TEXT NOT NULL DEFAULT 'default'
  );
`);

console.log("💾 Database: READY");
startDatabasePersistence(db, DB_PATH);















// ============================================================







// DATABASE FUNCTIONS







// ============================================================















function ensureSettings(jid: string): void {







  const existing = db







    .prepare(







      `SELECT jid FROM settings WHERE jid = ?`







    )







    .get(jid);















  if (!existing) {







    db.prepare(







      `







      INSERT INTO settings







      (jid, private_ai_enabled, group_ai_enabled, anti_link_enabled)







      VALUES (?, 1, 0, 0)







      `







    ).run(jid);







  }







}















function getPrivateAI(jid: string): boolean {







  ensureSettings(jid);















  const row = db







    .prepare(







      `







      SELECT private_ai_enabled







      FROM settings







      WHERE jid = ?







      `







    )







    .get(jid) as







    | { private_ai_enabled: number }







    | undefined;















  return row?.private_ai_enabled === 1;







}















function setPrivateAI(







  jid: string,







  enabled: boolean







): void {







  ensureSettings(jid);















  db.prepare(







    `







    UPDATE settings







    SET private_ai_enabled = ?







    WHERE jid = ?







    `







  ).run(enabled ? 1 : 0, jid);







}















function getGroupAI(jid: string): boolean {







  ensureSettings(jid);















  const row = db







    .prepare(







      `







      SELECT group_ai_enabled







      FROM settings







      WHERE jid = ?







      `







    )







    .get(jid) as







    | { group_ai_enabled: number }







    | undefined;















  return row?.group_ai_enabled === 1;







}















function setGroupAI(







  jid: string,







  enabled: boolean







): void {







  ensureSettings(jid);















  db.prepare(







    `







    UPDATE settings







    SET group_ai_enabled = ?







    WHERE jid = ?







    `







  ).run(enabled ? 1 : 0, jid);







}


function getAntiLink(jid: string): boolean {
  ensureSettings(jid);

  const row = db
    .prepare(`
      SELECT anti_link_enabled
      FROM settings
      WHERE jid = ?
    `)
    .get(jid) as { anti_link_enabled: number } | undefined;

  return row?.anti_link_enabled === 1;
}

function setAntiLink(jid: string, enabled: boolean): void {
  ensureSettings(jid);

  db.prepare(`
    UPDATE settings
    SET anti_link_enabled = ?
    WHERE jid = ?
  `).run(enabled ? 1 : 0, jid);
}

function getWelcome(jid: string): boolean {
  ensureSettings(jid);
  const row = db.prepare(`SELECT welcome_enabled FROM settings WHERE jid = ?`).get(jid) as { welcome_enabled: number } | undefined;
  return row?.welcome_enabled === 1;
}

function setWelcome(jid: string, enabled: boolean): void {
  ensureSettings(jid);
  db.prepare(`UPDATE settings SET welcome_enabled = ? WHERE jid = ?`).run(enabled ? 1 : 0, jid);
}

function getGoodbye(jid: string): boolean {
  ensureSettings(jid);
  const row = db.prepare(`SELECT goodbye_enabled FROM settings WHERE jid = ?`).get(jid) as { goodbye_enabled: number } | undefined;
  return row?.goodbye_enabled === 1;
}

function setGoodbye(jid: string, enabled: boolean): void {
  ensureSettings(jid);
  db.prepare(`UPDATE settings SET goodbye_enabled = ? WHERE jid = ?`).run(enabled ? 1 : 0, jid);
}

function getWarningCount(jid: string, userJid: string): number {
  const row = db.prepare(`SELECT count FROM group_warnings WHERE jid = ? AND user_jid = ?`).get(jid, userJid) as { count: number } | undefined;
  return row?.count ?? 0;
}

function addWarning(jid: string, userJid: string): number {
  const next = getWarningCount(jid, userJid) + 1;
  db.prepare(`
    INSERT INTO group_warnings (jid, user_jid, count, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(jid, user_jid) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at
  `).run(jid, userJid, next, Date.now());
  return next;
}

function clearWarnings(jid: string, userJid: string): void {
  db.prepare(`DELETE FROM group_warnings WHERE jid = ? AND user_jid = ?`).run(jid, userJid);
}
















// ============================================================







function getGlobalPrivateAI(): boolean {



  const row = db



    .prepare(`



      SELECT private_ai_enabled



      FROM global_settings



      WHERE id = 1



    `)



    .get() as { private_ai_enabled: number } | undefined;







  return row?.private_ai_enabled === 1;



}







function setGlobalPrivateAI(enabled: boolean): void {



  db.prepare(`



    UPDATE global_settings



    SET private_ai_enabled = ?



    WHERE id = 1



  `).run(enabled ? 1 : 0);



}







function getGlobalGroupAI(): boolean {



  const row = db



    .prepare(`



      SELECT group_ai_enabled



      FROM global_settings



      WHERE id = 1



    `)



    .get() as { group_ai_enabled: number } | undefined;







  return row?.group_ai_enabled === 1;



}







function setGlobalGroupAI(enabled: boolean): void {



  db.prepare(`



    UPDATE global_settings



    SET group_ai_enabled = ?



    WHERE id = 1



  `).run(enabled ? 1 : 0);



}







function getGlobalAutoReact(): boolean {



  const row = db



    .prepare(`



      SELECT auto_react_enabled



      FROM global_settings



      WHERE id = 1



    `)



    .get() as { auto_react_enabled: number } | undefined;







  return row?.auto_react_enabled === 1;



}







function setGlobalAutoReact(enabled: boolean): void {



  db.prepare(`



    UPDATE global_settings



    SET auto_react_enabled = ?



    WHERE id = 1



  `).run(enabled ? 1 : 0);



}







// ============================================================







// MEMORY DATABASE







// ============================================================















type ChatMessage = {







  role: "user" | "assistant";







  content: string;







};















const MAX_MEMORY = 10;















function getMemory(







  jid: string







): ChatMessage[] {







  const rows = db







    .prepare(







      `







      SELECT role, content







      FROM messages







      WHERE jid = ?







      ORDER BY id DESC







      LIMIT ?







      `







    )







    .all(jid, MAX_MEMORY) as ChatMessage[];















  return rows.reverse();







}















function saveMessage(







  jid: string,







  role: "user" | "assistant",







  content: string







): void {







  db.prepare(







    `







    INSERT INTO messages







    (jid, role, content, created_at)







    VALUES (?, ?, ?, ?)







    `







  ).run(







    jid,







    role,







    content,







    Date.now()







  );







}















function clearMemory(







  jid: string







): void {







  db.prepare(







    `







    DELETE FROM messages







    WHERE jid = ?







    `







  ).run(jid);







}















function getMemoryCount(







  jid: string







): number {







  const row = db







    .prepare(







      `







      SELECT COUNT(*) as count







      FROM messages







      WHERE jid = ?







      `







    )







    .get(jid) as







    | { count: number }







    | undefined;















  return row?.count || 0;







}















// ============================================================







// HELPERS







// ============================================================















function isGroup(







  jid: string







): boolean {







  return jid.endsWith("@g.us");







}















function normalizeNumber(







  number: string







): string {







  return number.replace(/\D/g, "");







}















function getSenderNumber(







  msg: any







): string {







  const participant =







    msg.key.participant ||







    msg.key.remoteJid ||







    "";















  return normalizeNumber(







    participant.split("@")[0]







  );







}















function isOwner(







  msg: any







): boolean {







  // A message manually sent from the owner's/main WhatsApp



  // phone arrives at the linked device with fromMe=true.



  // Treat that as an owner message. Bot-generated messages



  // are filtered before this function is used.



  if (msg.key?.fromMe === true) {



    return true;



  }







  return (







    getSenderNumber(msg) ===







    OWNER_NUMBER







  );







}















// ============================================================



// BOT SENT MESSAGE TRACKER



// ============================================================







// Messages sent by Leo itself also arrive with fromMe=true.



// We track Leo's own message IDs so owner messages sent from



// the linked/main WhatsApp device can still be processed safely.



const botSentMessageIds = new Set<string>();







function markBotMessage(id: string | null | undefined): void {



  if (!id) return;







  botSentMessageIds.add(id);







  // Keep the tracker small.



  setTimeout(() => {



    botSentMessageIds.delete(id);



  }, 5 * 60 * 1000);



}







function isBotMessage(id: string | null | undefined): boolean {



  return !!id && botSentMessageIds.has(id);



}







function isPreformattedBotText(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith("╭") || value.startsWith("┌") || value.startsWith("╔");
}

function formatBotText(text: string): string {
  if (!text || isPreformattedBotText(text)) return text;
  const lines = text.trim().split("\n");
  const body = lines.map((line) => line ? `│ ${line}` : "│").join("\n");
  return `╭━━━〔 🤖 LEO MD 〕━━━╮\n┃\n${body}\n┃\n╰━━━━━━━━━━━━━━━━━━━━╯`;
}

async function sendBotMessage(
  sock: ReturnType<typeof makeWASocket>,
  jid: string,
  content: any
): Promise<any> {
  const outgoing = { ...content };
  if (typeof outgoing.text === "string") {
    outgoing.text = formatBotText(outgoing.text);
  }
  const sent = await sock.sendMessage(jid, outgoing);
  markBotMessage(sent?.key?.id);
  return sent;
}



function makeProgressBar(percent: number, width = 18): string {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((safe / 100) * width);
  return `▰`.repeat(filled) + `▱`.repeat(width - filled);
}

async function editBotProgress(sock: ReturnType<typeof makeWASocket>, jid: string, key: any, text: string): Promise<void> {
  if (!key) return;
  try {
    await sock.sendMessage(jid, { text: formatBotText(text), edit: key });
  } catch {}
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function sendMediaWithUploadProgress(sock: ReturnType<typeof makeWASocket>, jid: string, progressKey: any, mediaContent: any, sizeBytes: number): Promise<any> {
  let stopped = false;
  let frame = 0;
  const frames = [
    "▰▱▱▱▱▱▱▱▱▱", "▰▰▱▱▱▱▱▱▱▱", "▰▰▰▱▱▱▱▱▱▱",
    "▰▰▰▰▱▱▱▱▱▱", "▰▰▰▰▰▱▱▱▱▱", "▰▰▰▰▰▰▱▱▱▱",
    "▰▰▰▰▰▰▰▱▱▱", "▰▰▰▰▰▰▰▰▱▱"
  ];
  const timer = setInterval(() => {
    if (stopped) return;
    frame = (frame + 1) % frames.length;
    void editBotProgress(sock, jid, progressKey, `☁️ *UPLOADING TO WHATSAPP*\n\n${frames[frame]}\n\n📦 File size: ${formatBytes(sizeBytes)}\n⏳ WhatsApp is uploading your media...`);
  }, 1600);
  try {
    return await sendBotMessage(sock, jid, mediaContent);
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}


const AUTO_REACTIONS = ["❤️", "👍", "🔥", "😂", "✨", "🤖", "💯"];







function randomReaction(): string {



  return AUTO_REACTIONS[Math.floor(Math.random() * AUTO_REACTIONS.length)];



}







// ============================================================







// GROUP ADMIN







// ============================================================















async function isGroupAdmin(







  sock: ReturnType<typeof makeWASocket>,







  jid: string,







  participant: string







): Promise<boolean> {







  try {







    const metadata =







      await sock.groupMetadata(jid);















    const member =







      metadata.participants.find(







        (p) => p.id === participant







      );















    if (!member) {







      return false;







    }















    return (







      member.admin === "admin" ||







      member.admin === "superadmin"







    );







  } catch {







    return false;







  }







}


async function isBotGroupAdmin(
  sock: ReturnType<typeof makeWASocket>,
  jid: string
): Promise<boolean> {
  try {
    const botId = sock.user?.id;
    if (!botId) return false;

    const botNumber = botId.split(":")[0].split("@")[0];
    const botJid = `${botNumber}@s.whatsapp.net`;

    return await isGroupAdmin(sock, jid, botJid);
  } catch {
    return false;
  }
}

function containsLink(text: string): boolean {
  const linkPattern =
    /(?:https?:\/\/|www\.)[^\s]+|(?:chat\.whatsapp\.com|wa\.me|t\.me|youtu\.be|youtube\.com|instagram\.com|facebook\.com|fb\.watch|tiktok\.com|x\.com|twitter\.com)\/[^\s]*/i;

  return linkPattern.test(text);
}
















// ============================================================







// MENTIONED USERS







// ============================================================















function getMentionedUsers(







  msg: any







): string[] {







  const mentioned =







    msg.message?.extendedTextMessage







      ?.contextInfo?.mentionedJid || [];















  if (mentioned.length > 0) {







    return mentioned;







  }















  const text =







    msg.message?.extendedTextMessage?.text ||







    msg.message?.conversation ||







    "";















  const numbers =







    text.match(/@(\d{8,15})/g);















  if (!numbers) {







    return [];







  }















  return numbers.map(







    (n: string) =>







      `${n.replace("@", "")}@s.whatsapp.net`







  );







}















// ============================================================







// ============================================================
// ADVANCED AI PERSONAS
// ============================================================

type PersonaConfig = {
  label: string;
  prompt: string;
};

const PERSONAS: Record<string, PersonaConfig> = {
  default: {
    label: "Default",
    prompt: "You are Leo, a helpful, friendly and accurate WhatsApp AI assistant. Keep answers clear and useful.",
  },
  friendly: {
    label: "Friendly",
    prompt: "Be warm, friendly and conversational. Explain things simply and naturally.",
  },
  professional: {
    label: "Professional",
    prompt: "Respond professionally and clearly. Use structured answers when useful and avoid unnecessary filler.",
  },
  coder: {
    label: "Coder",
    prompt: "Act as an expert software developer. Give practical, correct code, explain important steps, and preserve the user's requested stack.",
  },
  teacher: {
    label: "Teacher",
    prompt: "Teach step by step using simple explanations and examples. Adapt the explanation to a beginner unless the user asks for advanced detail.",
  },
  translator: {
    label: "Translator",
    prompt: "Focus on accurate natural translation while preserving meaning, tone and context. If a target language is specified, use it.",
  },
  creative: {
    label: "Creative",
    prompt: "Be imaginative and creative while following the user's constraints. For creative writing, produce polished original content.",
  },
};

function getPersona(jid: string): string {
  const row = db.prepare(`SELECT persona FROM ai_personas WHERE jid = ?`).get(jid) as { persona: string } | undefined;
  return row?.persona && PERSONAS[row.persona] ? row.persona : "default";
}

function setPersona(jid: string, persona: string): void {
  const safePersona = PERSONAS[persona] ? persona : "default";
  db.prepare(`
    INSERT INTO ai_personas (jid, persona) VALUES (?, ?)
    ON CONFLICT(jid) DO UPDATE SET persona = excluded.persona
  `).run(jid, safePersona);
}

function buildAdvancedSystemPrompt(jid: string): string {
  const persona = PERSONAS[getPersona(jid)] || PERSONAS.default;
  return [
    persona.prompt,
    "You are running inside WhatsApp as Leo MD.",
    "Do not claim to have performed real-world actions or accessed information you do not actually have.",
    "If the user asks for code, make it directly usable and clearly formatted.",
    "If the user asks for Sinhala, respond naturally in Sinhala unless another language is requested.",
    "Keep responses concise enough for WhatsApp unless the user asks for detail.",
  ].join(" ");
}

// TEXT AI







// ============================================================















async function askAI(







  jid: string,







  userText: string







): Promise<string> {







  const history =







    getMemory(jid);















  const messages = [







    {







      role: "system" as const,







      content: buildAdvancedSystemPrompt(jid),







    },







    ...history,







    {







      role: "user" as const,







      content: userText,







    },







  ];















  const completion =







    await groq.chat.completions.create({







      model: TEXT_MODEL,







      messages,







      temperature: 0.7,







      max_tokens: 1000,







    });















  const answer =







    completion.choices[0]?.message?.content?.trim() ||







    "Sorry bro, I couldn't generate a response.";















  saveMessage(







    jid,







    "user",







    userText







  );















  saveMessage(







    jid,







    "assistant",







    answer







  );















  // Keep only the latest 10 messages







  db.prepare(







    `







    DELETE FROM messages







    WHERE jid = ?







    AND id NOT IN (







      SELECT id







      FROM messages







      WHERE jid = ?







      ORDER BY id DESC







      LIMIT ?







    )







    `







  ).run(







    jid,







    jid,







    MAX_MEMORY







  );















  return answer;







}















// ============================================================







// VOICE AI







// ============================================================















async function transcribeVoice(







  buffer: Buffer







): Promise<string> {







  const file = await toFile(







    buffer,







    "voice.ogg",







    {







      type: "audio/ogg",







    }







  );















  const transcription =







    await groq.audio.transcriptions.create({







      file,







      model: TRANSCRIPTION_MODEL,







    });















  return (







    transcription.text?.trim() ||







    ""







  );







}















// ============================================================







// IMAGE DOWNLOAD







// ============================================================















async function downloadImage(







  message: any







): Promise<Buffer> {







  const stream =







    await downloadContentFromMessage(







      message,







      "image"







    );















  const chunks: Buffer[] = [];















  for await (const chunk of stream) {







    chunks.push(







      Buffer.from(chunk)







    );







  }















  return Buffer.concat(chunks);







}















// ============================================================







// IMAGE AI







// ============================================================















async function askImageAI(







  imageBuffer: Buffer,







  prompt: string







): Promise<string> {







  const base64 =







    imageBuffer.toString("base64");















  const dataUrl =







    `data:image/jpeg;base64,${base64}`;















  const completion =







    await groq.chat.completions.create({







      model: VISION_MODEL,







      messages: [







        {







          role: "system",







          content:







            "You are Leo AI, a helpful image understanding assistant. Answer naturally and concisely.",







        },







        {







          role: "user",







          content: [







            {







              type: "text",







              text: prompt,







            },







            {







              type: "image_url",







              image_url: {







                url: dataUrl,







              },







            },







          ],







        },







      ],







      max_tokens: 1000,







    });















  return (







    completion.choices[0]?.message?.content?.trim() ||







    "I couldn't understand this image."







  );







}















// ============================================================







// AI IMAGE GENERATION







// ============================================================















async function generateImage(







  prompt: string







): Promise<Buffer> {







  if (!POLLINATIONS_API_KEY) {







    throw new Error(







      "POLLINATIONS_API_KEY is missing in .env"







    );







  }















  const url =







    `https://gen.pollinations.ai/image/${encodeURIComponent(







      prompt







    )}?model=flux&width=1024&height=1024`;















  const response =







    await fetch(url, {







      headers: {







        Authorization:







          `Bearer ${POLLINATIONS_API_KEY}`,







      },







    });















  if (!response.ok) {







    const errorText =







      await response.text();















    throw new Error(







      `Pollinations API ${response.status}: ${errorText}`







    );







  }















  const arrayBuffer =







    await response.arrayBuffer();















  return Buffer.from(







    arrayBuffer







  );







}















// ============================================================







// IMAGE TOOLS
// ============================================================

async function enhanceImage(imageBuffer: Buffer): Promise<Buffer> {
  return sharp(imageBuffer)
    .rotate()
    .normalize()
    .sharpen({ sigma: 0.8, m1: 0.7, m2: 2 })
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
}

async function upscaleImage(imageBuffer: Buffer): Promise<Buffer> {
  const meta = await sharp(imageBuffer).metadata();
  const width = Math.min((meta.width || 512) * 2, 2048);
  const height = Math.min((meta.height || 512) * 2, 2048);
  return sharp(imageBuffer)
    .rotate()
    .resize(width, height, { fit: "inside", withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .sharpen()
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
}

// STICKER







// ============================================================















async function createSticker(







  imageBuffer: Buffer







): Promise<Buffer> {







  return await sharp(imageBuffer)







    .resize(512, 512, {







      fit: "contain",







      background: {







        r: 0,







        g: 0,







        b: 0,







        alpha: 0,







      },







    })







    .webp({







      quality: 90,







    })







    .toBuffer();







}















// ============================================================







// ============================================================
// MULTI-DEVICE MANAGER
// ============================================================

type DeviceStatus = "starting" | "online" | "offline";
type DeviceInfo = { id: string; status: DeviceStatus; startedAt: number; phone?: string };
const deviceSessions = new Map<string, DeviceInfo>();
const deviceSockets = new Map<string, ReturnType<typeof makeWASocket>>();

function getNextDeviceId(): string {
  let number = 1;
  while (deviceSessions.has(`device-${number}`)) number++;
  return `device-${number}`;
}

function getDeviceAuthPath(deviceId: string): string {
  return deviceId === "device-1" ? "./auth_info" : path.join("./auth_info", deviceId);
}

function getDeviceListText(): string {
  if (deviceSessions.size === 0) return "📱 No Leo devices are running.";
  const devices = [...deviceSessions.values()]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((device, index) => {
      const status = device.status === "online" ? "🟢 ONLINE" : device.status === "starting" ? "🟡 STARTING" : "🔴 OFFLINE";
      const phone = device.phone ? `\n┃ 📞 ${device.phone}` : "";
      return `┃ ${index + 1}️⃣ ${device.id}\n┃    ${status}${phone}`;
    }).join("\n┃\n");
  return `╭━━━〔 📱 LEO DEVICES 〕━━━╮\n┃\n${devices}\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯`;
}

function getDeviceStatusText(deviceId: string): string {
  const device = deviceSessions.get(deviceId);
  if (!device) return `❌ ${deviceId} is not running.`;
  const status = device.status === "online" ? "🟢 ONLINE" : device.status === "starting" ? "🟡 STARTING" : "🔴 OFFLINE";
  const phone = device.phone ? `\n📞 WhatsApp: ${device.phone}` : "";
  return `📱 ${device.id}\n\nStatus: ${status}${phone}\n🕐 Started: ${new Date(device.startedAt).toLocaleString()}`;
}

async function removeDevice(deviceId: string): Promise<void> {
  if (deviceId === "device-1") throw new Error("device-1 is the main Leo device and cannot be removed with this command.");
  const socket = deviceSockets.get(deviceId);
  if (socket) { try { socket.ws?.close(); } catch {} }
  deviceSockets.delete(deviceId);
  deviceSessions.delete(deviceId);
  await deleteSupabaseAuthState(deviceId);
  await rm(getDeviceAuthPath(deviceId), { recursive: true, force: true });
}

// START BOT







// ============================================================















async function startBot(deviceId: string = "device-1") {

  // Prevent duplicate WhatsApp sockets for the same device.
  if (deviceSockets.has(deviceId)) {
    console.log(`⚠️ [${deviceId}] Socket already exists. Skipping duplicate start.`);
    return;
  }







  const {
    state,
    saveCreds,
  } = await createSupabaseAuthState(
    deviceId,
    getDeviceAuthPath(deviceId)
  );















  const logger = pino({







    level: "silent",







  });















  deviceSessions.set(deviceId, { id: deviceId, status: "starting", startedAt: Date.now() });

  const sock =







    makeWASocket({







      auth: state,







      printQRInTerminal: false,







      logger,







    });

  deviceSockets.set(deviceId, sock);















  // ==========================================================







  // AUTH







  // ==========================================================















  sock.ev.on(







    "creds.update",







    saveCreds







  );















  // ==========================================================







  // CONNECTION







  // ==========================================================















  sock.ev.on(







    "connection.update",







    (update) => {







      const {







        connection,







        lastDisconnect,







        qr,







      } = update;















      if (qr) {
        console.log(`📱 [${deviceId}] Scan this QR code:`);

        qrcode.generate(qr, {
          small: true,
        });

        setDeviceQR(qr, deviceId);
        setDeviceStatus("waiting_for_pairing", deviceId);
      }


      if (connection === "open") {
        setDeviceStatus("online", deviceId);

        const loggedInNumber = sock.user?.id?.split(":")[0]?.replace(/\D/g, "") || "";

        // The first/main paired WhatsApp account becomes the owner when
        // OWNER_NUMBER is not supplied. This makes public deployment easy.
        if (deviceId === "device-1" && !OWNER_NUMBER && loggedInNumber) {
          void saveOwner(loggedInNumber).then(() => {
            console.log(`👑 Owner automatically set to ${OWNER_NUMBER}`);
          }).catch((error) => {
            console.error("❌ Could not save automatic owner:", error);
          });
        }

        const deviceInfo = deviceSessions.get(deviceId);
        if (deviceInfo) {
          deviceInfo.status = "online";
          deviceInfo.phone = sock.user?.id?.split(":")[0] || undefined;
        }

        console.log("");







        console.log(







          "================================="







        );







        console.log(







          `🤖 LEO MD BOT ONLINE — ${deviceId}`







        );







        console.log(







          "================================="







        );







        console.log(







          "🤖 Groq AI: READY"







        );







        console.log(







          "🧠 Persistent Memory: READY"







        );







        console.log(







          "🎤 Voice AI: READY"







        );







        console.log(







          "🖼️ Image AI: READY"







        );







        console.log(







          "🎨 Image Generation: READY"







        );







        console.log(







          "🎨 Sticker Maker: READY"







        );







        console.log(







          "👑 Owner System: READY"







        );







        console.log(







          "🛡️ Group Admin Tools: READY"







        );







        console.log(







          "👤 Private AI: READY"







        );







        console.log(







          "👥 Group AI: READY"







        );







        console.log(







          "================================="







        );







      }















      if (connection === "close") {

        const error = lastDisconnect?.error as any;
        const statusCode =
          error?.output?.statusCode ??
          error?.statusCode ??
          error?.data?.statusCode ??
          0;

        const reasonName =
          Object.entries(DisconnectReason).find(
            ([, value]) => value === statusCode
          )?.[0] ?? "unknown";

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        const deviceInfo = deviceSessions.get(deviceId);
        if (deviceInfo) deviceInfo.status = "offline";

        deviceSockets.delete(deviceId);
        setDeviceStatus("offline", deviceId);

        console.error("");
        console.error("=================================");
        console.error(`❌ [${deviceId}] WhatsApp disconnected`);
        console.error(`📛 Status code: ${statusCode}`);
        console.error(`📛 Reason: ${reasonName}`);
        console.error(`📛 Error: ${error?.message ?? "Unknown error"}`);
        console.error("=================================");

        if (shouldReconnect) {
          console.log(`🔄 [${deviceId}] Reconnecting in 5 seconds...`);

          setTimeout(() => {
            if (deviceSockets.has(deviceId)) return;

            void startBot(deviceId).catch((error) => {
              console.error(`❌ [${deviceId}] RECONNECT ERROR:`, error);
            });
          }, 5000);
        } else {
          console.log(
            `❌ [${deviceId}] Logged out. The Supabase session must be removed before pairing again.`
          );
        }
      }







    }







  );















  // ==========================================================







  // MESSAGES







  // ==========================================================

  // ==========================================================
  // GROUP PARTICIPANTS — WELCOME / GOODBYE
  // ==========================================================
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const { id: groupJid, participants, action } = update;
      if (!groupJid || !participants?.length || !isGroup(groupJid)) return;

      if (action === "add" && getWelcome(groupJid)) {
        const mentions = participants.map((user) => user.id);
        const lines = participants.map((user) => {
          const userJid = user.id;
          return `👋 Welcome @${userJid.split("@")[0]}!`;
        });
        await sendBotMessage(sock, groupJid, {
          text: `🎉 *WELCOME TO THE GROUP!*\n\n${lines.join("\n")}\n\n🤖 Enjoy your stay with Leo MD!`,
          mentions,
        });
      }

      if (action === "remove" && getGoodbye(groupJid)) {
        const mentions = participants.map((user) => user.id);
        const lines = participants.map((user) => {
          const userJid = user.id;
          return `👋 Goodbye @${userJid.split("@")[0]}!`;
        });
        await sendBotMessage(sock, groupJid, {
          text: `🚪 *GOODBYE*\n\n${lines.join("\n")}\n\nThanks for being part of the group!`,
          mentions,
        });
      }
    } catch (error) {
      console.error("❌ GROUP PARTICIPANT EVENT ERROR:", error);
    }
  });

  // ==========================================================
  // MESSAGES
  // ==========================================================
















  sock.ev.on(







    "messages.upsert",







    async ({ messages }) => {







      try {







        const msg = messages[0];















        if (!msg?.message) {







          return;







        }















        // Allow messages sent manually from the owner's/main linked



        // WhatsApp device. Ignore only messages that Leo itself sent.



        if (msg.key.fromMe && isBotMessage(msg.key.id)) {



          return;



        }















        const jid =







          msg.key.remoteJid;















        if (!jid) {







          return;







        }















        if (







          jid === "status@broadcast"







        ) {







          return;







        }















        ensureSettings(jid);















        const group =







          isGroup(jid);















        const messageContent =







          msg.message;















        const text =







          messageContent.conversation ||







          messageContent.extendedTextMessage







            ?.text ||







          "";















        const commandText =







          text.trim();

        // ====================================================
        // GLOBAL AUTO REACTION - COMMANDS ONLY



        // ====================================================







        // React only to messages that are commands (start with ".").



        // Normal messages are never auto-reacted to.



        if (



          getGlobalAutoReact() &&



          commandText.startsWith(".")



        ) {



          try {



            await sendBotMessage(sock, jid, {



              react: {



                text: randomReaction(),



                key: msg.key,



              },



            });



          } catch (error) {



            console.error("❌ AUTO REACT ERROR:", error);



          }



        }















        // ====================================================







        // ====================================================
        // ANTI-LINK GROUP CONTROL
        // ====================================================
        if (
          group &&
          (
            commandText.toLowerCase() === ".antilink on" ||
            commandText.toLowerCase() === ".antilink off" ||
            commandText.toLowerCase() === ".antilink status"
          )
        ) {
          const sender =
            msg.key.participant ||
            "";

          const admin = await isGroupAdmin(
            sock,
            jid,
            sender
          );

          if (!admin) {
            await sendBotMessage(sock, jid, {
              text: "❌ Only group admins can change Anti-Link settings."
            });
            return;
          }

          const option =
            commandText.split(/\s+/)[1]?.toLowerCase();

          if (option === "on") {
            setAntiLink(jid, true);
            await sendBotMessage(sock, jid, {
              text:
                "🔗 *ANTI-LINK ENABLED* ✅\n\n" +
                "🚫 Links sent by members will be removed.\n" +
                "👑 Group admins are exempt."
            });
            return;
          }

          if (option === "off") {
            setAntiLink(jid, false);
            await sendBotMessage(sock, jid, {
              text:
                "🔗 *ANTI-LINK DISABLED* 🔕\n\n" +
                "Members can send links again."
            });
            return;
          }

          const enabled = getAntiLink(jid);
          await sendBotMessage(sock, jid, {
            text:
              `🔗 *ANTI-LINK STATUS*\n\n` +
              `Status: ${enabled ? "ON ✅" : "OFF 🔕"}\n` +
              `👑 Admins: Exempt`
          });
          return;
        }

        // ====================================================
        // ANTI-LINK MESSAGE PROTECTION
        // ====================================================
        if (
          group &&
          !commandText.startsWith(".") &&
          containsLink(commandText) &&
          getAntiLink(jid)
        ) {
          const sender =
            msg.key.participant ||
            msg.key.remoteJid ||
            "";

          const senderIsAdmin = await isGroupAdmin(
            sock,
            jid,
            sender
          );

          if (!senderIsAdmin) {
            const botIsAdmin = await isBotGroupAdmin(
              sock,
              jid
            );

            if (!botIsAdmin) {
              await sendBotMessage(sock, jid, {
                text:
                  "⚠️ *ANTI-LINK IS ON*\n\n" +
                  "I detected a link, but Leo needs to be a group admin to remove messages."
              });
              return;
            }

            try {
              await sock.sendMessage(jid, {
                delete: msg.key
              } as any);

              await sendBotMessage(sock, jid, {
                text:
                  "🔗 *LINK REMOVED* 🚫\n\n" +
                  "Links are not allowed in this group.\n" +
                  "👑 Group admins are exempt."
              });
            } catch (error) {
              console.error("❌ ANTI-LINK ERROR:", error);
              await sendBotMessage(sock, jid, {
                text:
                  "❌ I detected a link but couldn't remove the message.\n" +
                  "Make sure Leo is a group admin."
              });
            }

            return;
          }
        }

        // ====================================================
        // MULTI-DEVICE COMMANDS
        // ====================================================
        const deviceCommand = commandText.toLowerCase();

        if (deviceCommand === ".devices" || deviceCommand === ".device list" || deviceCommand === ".device status" || deviceCommand === ".device status all") {
          if (!isOwner(msg)) {
            await sendBotMessage(sock, jid, { text: "❌ Owner only command." });
            return;
          }
          await sendBotMessage(sock, jid, { text: getDeviceListText() });
          return;
        }

        if (deviceCommand.startsWith(".device status ")) {
          if (!isOwner(msg)) {
            await sendBotMessage(sock, jid, { text: "❌ Owner only command." });
            return;
          }
          const deviceId = commandText.split(/\s+/)[2]?.toLowerCase();
          await sendBotMessage(sock, jid, { text: deviceId ? getDeviceStatusText(deviceId) : "Usage: .device status device-2" });
          return;
        }

        if (deviceCommand === ".device add") {
          if (!isOwner(msg)) {
            await sendBotMessage(sock, jid, { text: "❌ Owner only command." });
            return;
          }
          const newDeviceId = getNextDeviceId();
          await sendBotMessage(sock, jid, { text: `📱 Starting ${newDeviceId}...\n\n🔐 A QR code will appear in the terminal.\nScan it with the WhatsApp account you want to connect.` });
          void startBot(newDeviceId).catch((error) => {
            const deviceInfo = deviceSessions.get(newDeviceId);
            if (deviceInfo) deviceInfo.status = "offline";
            console.error(`❌ ${newDeviceId} START ERROR:`, error);
          });
          return;
        }

        if (deviceCommand.startsWith(".device remove ")) {
          if (!isOwner(msg)) {
            await sendBotMessage(sock, jid, { text: "❌ Owner only command." });
            return;
          }
          const deviceId = commandText.split(/\s+/)[2]?.toLowerCase();
          if (!deviceId) {
            await sendBotMessage(sock, jid, { text: "Usage: .device remove device-2" });
            return;
          }
          try {
            await removeDevice(deviceId);
            await sendBotMessage(sock, jid, { text: `🗑️ ${deviceId} removed successfully.\n\nIts saved WhatsApp session has been deleted.` });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to remove device.";
            await sendBotMessage(sock, jid, { text: `❌ ${message}` });
          }
          return;
        }

// OWNER







        // ====================================================















        if (







          commandText.toLowerCase() ===







          ".owner"







        ) {







          await sendBotMessage(sock, 







            jid,







            {







              text:







                `👑 *Leo MD Owner*\n\nOwner: @${OWNER_NUMBER}`,







              mentions: [







                `${OWNER_NUMBER}@s.whatsapp.net`,







              ],







            }







          );















          return;







        }















        // ====================================================







        // BROADCAST







        // ====================================================















        if (







          commandText







            .toLowerCase()







            .startsWith(".broadcast")







        ) {







          if (!isOwner(msg)) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "❌ Owner only command.",







              }







            );















            return;







          }















          const broadcastText =







            commandText







              .slice(10)







              .trim();















          if (!broadcastText) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "📢 Usage:\n.broadcast <message>",







              }







            );















            return;







          }















          await sendBotMessage(sock, 







            jid,







            {







              text:







                "📢 Broadcast request received.\n\n⚠️ Mass broadcasting is not enabled yet.",







            }







          );















          console.log(







            "📢 Broadcast requested:"







          );







          console.log(







            broadcastText







          );















          return;







        }















        // ====================================================







        // RESTART







        // ====================================================















        if (







          commandText.toLowerCase() ===







          ".restart"







        ) {







          if (!isOwner(msg)) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "❌ Owner only command.",







              }







            );















            return;







          }















          await sendBotMessage(sock, 







            jid,







            {







              text:







                "🔄 Restarting Leo MD Bot...",







            }







          );















          setTimeout(() => {







            process.exit(0);







          }, 1500);















          return;







        }















        // ====================================================







        // SHUTDOWN







        // ====================================================















        if (







          commandText.toLowerCase() ===







          ".shutdown"







        ) {







          if (!isOwner(msg)) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "❌ Owner only command.",







              }







            );















            return;







          }















          await sendBotMessage(sock, 







            jid,







            {







              text:







                "🛑 Leo MD Bot is shutting down...",







            }







          );















          setTimeout(() => {







            process.exit(0);







          }, 1500);















          return;







        }















        // ====================================================







        // IMAGE







        // ====================================================















        if (







          messageContent.imageMessage







        ) {







          const imageMessage =







            messageContent.imageMessage;















          const caption =







            imageMessage.caption?.trim() ||







            "";















          // --------------------------------------------------







          // IMAGE TOOLS
          // --------------------------------------------------

          if (caption.toLowerCase() === ".caption" || caption.toLowerCase() === ".describe") {
            try {
              const imageBuffer = await downloadImage(imageMessage);
              const answer = await askImageAI(imageBuffer, "Write a natural, concise caption for this image. Describe the main subject and mood. Do not invent details.");
              await sendBotMessage(sock, jid, { text: `🏷️ *IMAGE CAPTION*\n\n${answer}` });
            } catch (error) {
              console.error("❌ CAPTION ERROR:", error);
              await sendBotMessage(sock, jid, { text: "❌ I couldn't create a caption for that image bro." });
            }
            return;
          }

          if (caption.toLowerCase() === ".enhance" || caption.toLowerCase() === ".hd") {
            try {
              await sendBotMessage(sock, jid, { text: "✨ Enhancing your image bro..." });
              const imageBuffer = await downloadImage(imageMessage);
              const enhanced = await enhanceImage(imageBuffer);
              await sendBotMessage(sock, jid, { image: enhanced, caption: "✨ *Leo Image Enhance*\n\nImage enhanced and cleaned up." });
            } catch (error) {
              console.error("❌ ENHANCE ERROR:", error);
              await sendBotMessage(sock, jid, { text: "❌ Image enhancement failed bro." });
            }
            return;
          }

          if (caption.toLowerCase() === ".upscale" || caption.toLowerCase() === ".2x") {
            try {
              await sendBotMessage(sock, jid, { text: "🔍 Upscaling your image bro..." });
              const imageBuffer = await downloadImage(imageMessage);
              const upscaled = await upscaleImage(imageBuffer);
              await sendBotMessage(sock, jid, { image: upscaled, caption: "🔍 *Leo 2× Upscale*\n\nImage upscaled with high-quality resizing." });
            } catch (error) {
              console.error("❌ UPSCALE ERROR:", error);
              await sendBotMessage(sock, jid, { text: "❌ Image upscaling failed bro." });
            }
            return;
          }

          // STICKER







          // --------------------------------------------------















          if (







            caption.toLowerCase() ===







              ".sticker" ||







            caption.toLowerCase() ===







              ".s"







          ) {







            try {







              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "🎨 Creating your sticker bro...",







                }







              );















              const imageBuffer =







                await downloadImage(







                  imageMessage







                );















              const sticker =







                await createSticker(







                  imageBuffer







                );















              await sendBotMessage(sock, 







                jid,







                {







                  sticker,







                }







              );







            } catch (error) {







              console.error(







                "❌ STICKER ERROR:",







                error







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "❌ Sticker creation failed bro.",







                }







              );







            }















            return;







          }















          // --------------------------------------------------







          // IMAGE AI







          // --------------------------------------------------















          const autoAllowed =



            group



              ? getGlobalGroupAI()



              : getGlobalPrivateAI();















          if (!autoAllowed) {







            return;







          }















          const imageBuffer =







            await downloadImage(







              imageMessage







            );















          const prompt =







            caption ||







            "Describe this image and tell me what you see.";















          const answer =







            await askImageAI(







              imageBuffer,







              prompt







            );















          await sendBotMessage(sock, 







            jid,







            {







              text: answer,







            }







          );















          return;







        }















        // ====================================================







        // VOICE







        // ====================================================















        if (







          messageContent.audioMessage







        ) {







          const autoAllowed =



            group



              ? getGlobalGroupAI()



              : getGlobalPrivateAI();















          if (!autoAllowed) {







            return;







          }















          const audioMessage =







            messageContent.audioMessage;















          const stream =







            await downloadContentFromMessage(







              audioMessage,







              "audio"







            );















          const chunks: Buffer[] = [];















          for await (const chunk of stream) {







            chunks.push(







              Buffer.from(chunk)







            );







          }















          const audioBuffer =







            Buffer.concat(chunks);















          const transcript =







            await transcribeVoice(







              audioBuffer







            );















          if (!transcript) {







            return;







          }















          console.log(







            `🎤 Voice: ${transcript}`







          );















          const answer =







            await askAI(







              jid,







              transcript







            );















          await sendBotMessage(sock, 







            jid,







            {







              text: answer,







            }







          );















          return;







        }















        // ====================================================







        // NO TEXT







        // ====================================================















        if (!commandText) {







          return;







        }















        // ====================================================







        // ====================================================
        // GROUP MANAGEMENT 2.0
        // ====================================================
        const lowerCommand = commandText.toLowerCase();
        const groupManagementCommand =
          lowerCommand === ".tagall" || lowerCommand.startsWith(".tagall ") ||
          lowerCommand === ".hidetag" || lowerCommand.startsWith(".hidetag ") ||
          lowerCommand === ".warn" || lowerCommand.startsWith(".warn ") ||
          lowerCommand === ".warnings" || lowerCommand.startsWith(".warnings ") ||
          lowerCommand === ".unwarn" || lowerCommand.startsWith(".unwarn ") ||
          lowerCommand === ".mute" || lowerCommand === ".unmute" ||
          lowerCommand.startsWith(".welcome") || lowerCommand.startsWith(".goodbye");

        if (group && groupManagementCommand) {
          const sender = msg.key.participant || msg.key.remoteJid || "";
          const admin = await isGroupAdmin(sock, jid, sender);
          if (!admin) {
            await sendBotMessage(sock, jid, { text: "❌ Only group admins can use this command." });
            return;
          }

          if (lowerCommand === ".tagall" || lowerCommand.startsWith(".tagall ") || lowerCommand === ".hidetag" || lowerCommand.startsWith(".hidetag ")) {
            const metadata = await sock.groupMetadata(jid);
            const mentions = metadata.participants.map((p) => p.id);
            const prefix = lowerCommand.startsWith(".hidetag") ? ".hidetag" : ".tagall";
            const message = commandText.slice(prefix.length).trim() || "📢 Attention everyone!";
            await sendBotMessage(sock, jid, {
              text: `${message}\n\n${mentions.map((u) => `@${u.split("@")[0]}`).join(" ")}`,
              mentions,
            });
            return;
          }

          if (lowerCommand.startsWith(".welcome")) {
            const option = lowerCommand.split(/\s+/)[1];
            if (option === "on") setWelcome(jid, true);
            else if (option === "off") setWelcome(jid, false);
            else if (option !== "status") {
              await sendBotMessage(sock, jid, { text: "Usage:\n.welcome on\n.welcome off\n.welcome status" });
              return;
            }
            await sendBotMessage(sock, jid, { text: `👋 *WELCOME SYSTEM*\n\nStatus: ${getWelcome(jid) ? "ON ✅" : "OFF 🔕"}` });
            return;
          }

          if (lowerCommand.startsWith(".goodbye")) {
            const option = lowerCommand.split(/\s+/)[1];
            if (option === "on") setGoodbye(jid, true);
            else if (option === "off") setGoodbye(jid, false);
            else if (option !== "status") {
              await sendBotMessage(sock, jid, { text: "Usage:\n.goodbye on\n.goodbye off\n.goodbye status" });
              return;
            }
            await sendBotMessage(sock, jid, { text: `🚪 *GOODBYE SYSTEM*\n\nStatus: ${getGoodbye(jid) ? "ON ✅" : "OFF 🔕"}` });
            return;
          }

          if (lowerCommand === ".mute" || lowerCommand === ".unmute") {
            if (!(await isBotGroupAdmin(sock, jid))) {
              await sendBotMessage(sock, jid, { text: "❌ Leo must be a group admin to mute/unmute the group." });
              return;
            }
            try {
              const mute = lowerCommand === ".mute";
              await sock.groupSettingUpdate(jid, mute ? "announcement" : "not_announcement");
              await sendBotMessage(sock, jid, {
                text: mute ? "🔇 *GROUP MUTED*\n\nOnly admins can send messages now." : "🔊 *GROUP UNMUTED*\n\nAll members can send messages again.",
              });
            } catch (error) {
              console.error("❌ MUTE/UNMUTE ERROR:", error);
              await sendBotMessage(sock, jid, { text: "❌ I couldn't change the group's messaging setting. Make sure Leo is an admin." });
            }
            return;
          }

          if (lowerCommand === ".warn" || lowerCommand.startsWith(".warn ")) {
            const targets = getMentionedUsers(msg);
            if (!targets.length) {
              await sendBotMessage(sock, jid, { text: "⚠️ Usage:\n.warn @user [reason]" });
              return;
            }
            const target = targets[0];
            if (await isGroupAdmin(sock, jid, target)) {
              await sendBotMessage(sock, jid, { text: "❌ Admins cannot be warned by this command." });
              return;
            }
            const count = addWarning(jid, target);
            const reason = commandText.replace(/^\.warn\s+/i, "").replace(/@\d+/g, "").trim();
            const reasonText = reason ? `\n📝 Reason: ${reason}` : "";
            if (count >= 3) {
              if (await isBotGroupAdmin(sock, jid)) {
                try {
                  await sock.groupParticipantsUpdate(jid, [target], "remove");
                  clearWarnings(jid, target);
                  await sendBotMessage(sock, jid, { text: `🚨 *3 WARNINGS REACHED*\n\n👤 @${target.split("@")[0]} was removed from the group.${reasonText}`, mentions: [target] });
                } catch (error) {
                  console.error("❌ AUTO-KICK ERROR:", error);
                  await sendBotMessage(sock, jid, { text: `⚠️ @${target.split("@")[0]} reached 3/3 warnings, but Leo couldn't remove them.`, mentions: [target] });
                }
              } else {
                await sendBotMessage(sock, jid, { text: `🚨 @${target.split("@")[0]} reached 3/3 warnings.\n❌ Leo needs admin permission to remove them.`, mentions: [target] });
              }
            } else {
              await sendBotMessage(sock, jid, { text: `⚠️ *WARNING ISSUED*\n\n👤 @${target.split("@")[0]}\n📊 Warnings: ${count}/3${reasonText}`, mentions: [target] });
            }
            return;
          }

          if (lowerCommand === ".warnings" || lowerCommand.startsWith(".warnings ")) {
            const targets = getMentionedUsers(msg);
            if (!targets.length) {
              await sendBotMessage(sock, jid, { text: "📊 Usage:\n.warnings @user" });
              return;
            }
            const target = targets[0];
            const count = getWarningCount(jid, target);
            await sendBotMessage(sock, jid, { text: `⚠️ *WARNING STATUS*\n\n👤 @${target.split("@")[0]}\n📊 Warnings: ${count}/3`, mentions: [target] });
            return;
          }

          if (lowerCommand === ".unwarn" || lowerCommand.startsWith(".unwarn ")) {
            const targets = getMentionedUsers(msg);
            if (!targets.length) {
              await sendBotMessage(sock, jid, { text: "🧹 Usage:\n.unwarn @user" });
              return;
            }
            clearWarnings(jid, targets[0]);
            await sendBotMessage(sock, jid, { text: `🧹 Warnings cleared for @${targets[0].split("@")[0]}.`, mentions: [targets[0]] });
            return;
          }
        }

        // GROUP ADMIN COMMANDS







        // ====================================================















        if (







          group &&







          (







            commandText







              .toLowerCase()







              .startsWith(".kick") ||







            commandText







              .toLowerCase()







              .startsWith(".add") ||







            commandText







              .toLowerCase()







              .startsWith(".promote") ||







            commandText







              .toLowerCase()







              .startsWith(".demote")







          )







        ) {







          const sender =







            msg.key.participant ||







            "";















          const admin =







            await isGroupAdmin(







              sock,







              jid,







              sender







            );















          if (!admin) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "❌ Only group admins can use this command.",







              }







            );















            return;







          }















          const lower =







            commandText.toLowerCase();















          // --------------------------------------------------







          // KICK







          // --------------------------------------------------















          if (







            lower.startsWith(".kick")







          ) {







            const targets =







              getMentionedUsers(msg);















            if (







              targets.length === 0







            ) {







              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "👢 Usage:\n.kick @user",







                }







              );















              return;







            }















            try {







              await sock.groupParticipantsUpdate(







                jid,







                targets,







                "remove"







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "👢 User removed from the group.",







                }







              );







            } catch (error) {







              console.error(







                "❌ KICK ERROR:",







                error







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "❌ I couldn't remove that user. Make sure Leo is a group admin.",







                }







              );







            }















            return;







          }















          // --------------------------------------------------







          // ADD







          // --------------------------------------------------















          if (







            lower.startsWith(".add")







          ) {







            const number =







              commandText







                .slice(4)







                .trim()







                .replace(/\D/g, "");















            if (







              number.length < 8







            ) {







              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "➕ Usage:\n.add 947xxxxxxxx",







                }







              );















              return;







            }















            const target =







              `${number}@s.whatsapp.net`;















            try {







              await sock.groupParticipantsUpdate(







                jid,







                [target],







                "add"







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    `➕ Add request sent for ${number}.`,







                }







              );







            } catch (error) {







              console.error(







                "❌ ADD ERROR:",







                error







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "❌ I couldn't add that number.",







                }







              );







            }















            return;







          }















          // --------------------------------------------------







          // PROMOTE







          // --------------------------------------------------















          if (







            lower.startsWith(".promote")







          ) {







            const targets =







              getMentionedUsers(msg);















            if (







              targets.length === 0







            ) {







              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "⬆️ Usage:\n.promote @user",







                }







              );















              return;







            }















            try {







              await sock.groupParticipantsUpdate(







                jid,







                targets,







                "promote"







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "⬆️ User promoted to admin.",







                }







              );







            } catch (error) {







              console.error(







                "❌ PROMOTE ERROR:",







                error







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "❌ I couldn't promote that user.",







                }







              );







            }















            return;







          }















          // --------------------------------------------------







          // DEMOTE







          // --------------------------------------------------















          if (







            lower.startsWith(".demote")







          ) {







            const targets =







              getMentionedUsers(msg);















            if (







              targets.length === 0







            ) {







              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "⬇️ Usage:\n.demote @user",







                }







              );















              return;







            }















            try {







              await sock.groupParticipantsUpdate(







                jid,







                targets,







                "demote"







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "⬇️ User demoted.",







                }







              );







            } catch (error) {







              console.error(







                "❌ DEMOTE ERROR:",







                error







              );















              await sendBotMessage(sock, 







                jid,







                {







                  text:







                    "❌ I couldn't demote that user.",







                }







              );







            }















            return;







          }







        }















        // ====================================================







        // PING







        // ====================================================















        if (







          commandText.toLowerCase() ===







          ".ping"







        ) {







          await sendBotMessage(sock, 







            jid,







            {







              text:







                "🏓 *PONG — LEO MD IS ONLINE*\n\n🟢 WhatsApp connection: ACTIVE\n⚡ AI Engine: READY\n🧠 Memory: READY\n📱 Device: " + deviceId + "\n⏱️ Uptime: " + formatUptime(process.uptime()),







            }







          );















          return;







        }















        // ====================================================



        // ABOUT / CREATOR



        // ====================================================







        if (commandText.toLowerCase() === ".about") {



          const about = `
╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃       🤖 *LEO MD BOT*       ┃
┃   *WhatsApp AI Assistant*   ┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯

✨ *PRODUCT*
│ Leo MD — Smart WhatsApp Assistant

🧠 *INTELLIGENCE*
│ Groq AI • Voice AI • Vision AI
│ Image Generation • Persistent Memory

🛠️ *TECHNOLOGY*
│ Node.js + TypeScript
│ WhatsApp Multi-Device

👨‍💻 *CREATOR*
│ S.P.B.Pabsara Nawodya

⚡ *STYLE*
│ Fast • Smart • Friendly • Reliable

╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯
`;







          await sendBotMessage(sock, jid, {



            text: about,



          });







          return;



        }















        // ====================================================







        // MENU







        // ====================================================















        // ====================================================
        // V2 USER PROFILE SYSTEM
        // ====================================================

        if (

          commandText.toLowerCase() === ".menu"

        ) {

          const menu = `
╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃       🤖 *LEO MD BOT*       ┃
┃   ⚡ *Fast • Smart • Pro*   ┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯

👋 *WELCOME TO LEO*
│ Your all-in-one WhatsApp AI assistant.

╭─〔 🧠 AI & CHAT 〕─╮
│ 🤖 .ai <message>
│ 🎭 .persona <name>
│ 🌍 .translate <lang> <text>
│ 📝 .summarize <text>
│ ✍️ .fix <text>
│ 💻 .code <request>
│ 🧠 .memory
│ 🧹 .clear
│ 🎤 Voice message → AI
╰────────────────────╯

╭─〔 🎨 CREATIVE STUDIO 〕─╮
│ 👁️ Image + caption → Vision AI
│ 🏷️ .caption on image
│ ✨ .enhance on image
│ 🔍 .upscale on image
│ 🖼️ .imagine <prompt>
│ 🧩 .sticker / .s
╰─────────────────────────╯

╭─〔 🎵 MUSIC & DOWNLOADS 〕─╮
│ 🎵 .song <name> → MP3
│ 📄 .songdoc <name> → File
│ 🔎 .songsearch <name>
│ 🎧 .play <name>
│ 🎵 .audio <URL>
│ 🎬 .video <URL>
│ 📦 .dl <URL>
╰──────────────────────────╯

╭─〔 🛡️ GROUP TOOLS 〕─╮
│ 👢 .kick @user
│ ➕ .add 947xxxxxxxx
│ ⬆️ .promote @user
│ ⬇️ .demote @user
│ 🔗 .antilink on/off/status
│ 👋 .welcome on/off/status
│ 🚪 .goodbye on/off/status
│ 📢 .tagall <message>
│ 🙈 .hidetag <message>
│ ⚠️ .warn @user
│ 📊 .warnings @user
│ 🧹 .unwarn @user
│ 🔇 .mute / .unmute
╰────────────────────────╯

╭─〔 👑 OWNER PANEL 〕─╮
│ 👤 .owner
│ 📢 .broadcast <message>
│ 🔄 .restart
│ 🛑 .shutdown
╰────────────────────╯

╭─〔 ⚙️ CONTROL CENTER 〕─╮
│ 👤 .privateai on/off/status
│ 👥 .groupai on/off/status
│ ⚡ .autoreact on/off/status
│ 📱 .devices
│ 📱 .device add
╰────────────────────────╯

╭─〔 💚 BOT STATUS 〕─╮
│ 💚 .alive / .online / .status
│ 🏓 .ping
│ ℹ️ .about
╰────────────────────╯

📌 *QUICK EXAMPLES*
> .ai hello bro
> .song Shape of You
> .audio https://youtu.be/...
> .imagine a cinematic sunset

🔒 *50 MB max • public URLs only*

👨‍💻 *CREATOR*
*S.P.B.Pabsara Nawodya*

✨ *Leo MD — Made for WhatsApp*
`;



          try {

            const { readFile } = await import("node:fs/promises");

            const menuImage = await readFile("./assets/menu.png");



            await sendBotMessage(sock, jid, {

              image: menuImage,

              caption: menu,

            });

          } catch {

            await sendBotMessage(sock, jid, {

              text: menu,

            });

          }



          return;

        }





        // PRIVATE AI (GLOBAL OWNER CONTROL)







        if (



          commandText



            .toLowerCase()



            .startsWith(".privateai")



        ) {



          if (!isOwner(msg)) {



            await sendBotMessage(sock, jid, {



              text: "❌ Only the owner can change Private AI settings.",



            });



            return;



          }







          const option = commandText.split(/\s+/)[1]?.toLowerCase();







          if (option === "on") {



            setGlobalPrivateAI(true);



            await sendBotMessage(sock, jid, {



              text: "👤 Private AI is now ON globally ✅\n\n🌍 All private conversations are enabled.",



            });



            return;



          }







          if (option === "off") {



            setGlobalPrivateAI(false);



            await sendBotMessage(sock, jid, {



              text: "👤 Private AI is now OFF globally 🔕\n\n🌍 All private conversations are disabled.",



            });



            return;



          }







          if (option === "status") {



            const enabled = getGlobalPrivateAI();



            await sendBotMessage(sock, jid, {



              text: `👤 Global Private AI: ${enabled ? "ON ✅" : "OFF 🔕"}\n🌍 Applies to all private chats.`,



            });



            return;



          }







          await sendBotMessage(sock, jid, {



            text: "Usage:\n.privateai on\n.privateai off\n.privateai status",



          });



          return;



        }







// GROUP AI (GLOBAL OWNER CONTROL)







        if (



          commandText



            .toLowerCase()



            .startsWith(".groupai")



        ) {



          if (!isOwner(msg)) {



            await sendBotMessage(sock, jid, {



              text: "❌ Only the owner can change Group AI settings.",



            });



            return;



          }







          const option = commandText.split(/\s+/)[1]?.toLowerCase();







          if (option === "on") {



            setGlobalGroupAI(true);



            await sendBotMessage(sock, jid, {



              text: "👥 Group AI is now ON globally ✅\n\n🌍 All groups are enabled.",



            });



            return;



          }







          if (option === "off") {



            setGlobalGroupAI(false);



            await sendBotMessage(sock, jid, {



              text: "👥 Group AI is now OFF globally 🔕\n\n🌍 All groups are disabled.",



            });



            return;



          }







          if (option === "status") {



            const enabled = getGlobalGroupAI();



            await sendBotMessage(sock, jid, {



              text: `👥 Global Group AI: ${enabled ? "ON ✅" : "OFF 🔕"}\n🌍 Applies to all groups.`,



            });



            return;



          }







          await sendBotMessage(sock, jid, {



            text: "Usage:\n.groupai on\n.groupai off\n.groupai status",



          });



          return;



        }







        // ====================================================



        // AUTO REACT (GLOBAL OWNER CONTROL)



        // ====================================================







        if (



          commandText



            .toLowerCase()



            .startsWith(".autoreact")



        ) {



          if (!isOwner(msg)) {



            await sendBotMessage(sock, jid, {



              text: "❌ Only the owner can change Auto React settings.",



            });



            return;



          }







          const option = commandText.split(/\s+/)[1]?.toLowerCase();







          if (option === "on") {



            setGlobalAutoReact(true);



            await sendBotMessage(sock, jid, {



              text: "💫 Auto React is now ON globally ✅\n\n🌍 Leo will react only to commands.",



            });



            return;



          }







          if (option === "off") {



            setGlobalAutoReact(false);



            await sendBotMessage(sock, jid, {



              text: "💫 Auto React is now OFF globally 🔕\n\n🌍 Leo will stop automatic reactions.",



            });



            return;



          }







          if (option === "status") {



            const enabled = getGlobalAutoReact();



            await sendBotMessage(sock, jid, {



              text: `💫 Global Auto React: ${enabled ? "ON ✅" : "OFF 🔕"}\n🌍 Applies to all chats.`,



            });



            return;



          }







          await sendBotMessage(sock, jid, {



            text: "Usage:\n.autoreact on\n.autoreact off\n.autoreact status",



          });



          return;



        }









// ============================================================

// ============================================================
// SONG SEARCH + ALIVE HELPERS
// ============================================================

type SongResult = { title: string; url: string; duration: string };

function runYtDlpCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { shell: false, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("yt-dlp was not found in PATH. Restart VS Code after installing yt-dlp."));
      else reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim().slice(-1800) || `yt-dlp exited with code ${code ?? "unknown"}`));
    });
  });
}

async function searchSongs(query: string, limit = 5): Promise<SongResult[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];
  const count = Math.max(1, Math.min(limit, 5));
  const output = await runYtDlpCapture([
    "--no-playlist", "--flat-playlist", "--skip-download", "--no-warnings",
    "--print", "%(title)s|||%(webpage_url)s|||%(duration_string)s",
    "--playlist-end", String(count), `ytsearch${count}:${cleanQuery}`,
  ]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [title, url, duration = "Unknown"] = line.split("|||");
    return { title: title || "Unknown title", url: url || "", duration: duration || "Unknown" };
  }).filter((item) => /^https?:\/\//i.test(item.url));
}

function formatUptime(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

async function getAliveImage(): Promise<Buffer | null> {
  for (const file of ["./assets/logo.png", "./assets/leo-logo.png", "./assets/menu.png"]) {
    try { return await readFile(file); } catch { /* try next */ }
  }
  return null;
}

// MEDIA DOWNLOADER (yt-dlp + FFmpeg)

// ============================================================



type DownloadType = "audio" | "video";



type DownloadedMedia = {

  buffer: Buffer;

  filename: string;

};



const DOWNLOAD_DIR = path.resolve("./downloads");

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;



function runYtDlp(args: string[], onProgress?: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { shell: false, windowsHide: true });
    let stderr = "";
    let stdout = "";
    let lastPercent = -1;
    let lastUpdateAt = 0;

    const handleOutput = (chunk: Buffer | string) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const match = line.match(/download:\s*([0-9]+(?:\.[0-9]+)?)%/i);
        if (!match) continue;
        const percent = Math.max(0, Math.min(100, Number(match[1])));
        const now = Date.now();
        if (percent >= 100 || percent - lastPercent >= 1 || now - lastUpdateAt >= 1800) {
          lastPercent = percent;
          lastUpdateAt = now;
          onProgress?.(percent);
        }
      }
    };

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); handleOutput(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); handleOutput(chunk); });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("yt-dlp was not found in PATH. Restart VS Code after installing yt-dlp."));
      else reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) { onProgress?.(100); resolve(); }
      else reject(new Error(stderr.trim().slice(-1800) || stdout.trim().slice(-1800) || `yt-dlp exited with code ${code ?? "unknown"}`));
    });
  });
}


async function downloadMedia(

  url: string,

  type: DownloadType,
  onProgress?: (percent: number) => void

): Promise<DownloadedMedia> {

  let parsedUrl: URL;



  try {

    parsedUrl = new URL(url);

  } catch {

    throw new Error("Invalid URL. Please send a full http\:// or https\:// URL.");

  }



  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {

    throw new Error("Only http\:// and https\:// URLs are supported.");

  }



  await mkdir(DOWNLOAD_DIR, { recursive: true });



  const jobId = `leo_${Date.now()}_${Math.random()

    .toString(36)

    .slice(2, 10)}`;



  const outputTemplate = path.join(

    DOWNLOAD_DIR,

    `${jobId}.%(ext)s`

  );



  const commonArgs = [

    "--no-playlist",

    "--newline",

    "--progress-template",

    "download:%(progress._percent_str)s",

    "--no-warnings",

    "--restrict-filenames",

    "--max-filesize",

    "50M",

  ];



  const args =

    type === "audio"

      ? [

          ...commonArgs,

          "-x",

          "--audio-format",

          "mp3",

          "--audio-quality",

          "192K",

          "-o",

          outputTemplate,

          url,

        ]

      : [

          ...commonArgs,

          "-f",

          "bv*+ba/b",

          "--merge-output-format",

          "mp4",

          "-o",

          outputTemplate,

          url,

        ];



  try {

    await runYtDlp(args, onProgress);



    const files = await readdir(DOWNLOAD_DIR);



    const candidates = files

      .filter((file) => file.startsWith(jobId + "."))

      .map((file) => path.join(DOWNLOAD_DIR, file));



    if (candidates.length === 0) {

      throw new Error("yt-dlp finished, but no media file was created.");

    }



    const preferredExtension = type === "audio" ? ".mp3" : ".mp4";

    const preferred = candidates.find((file) =>

      file.toLowerCase().endsWith(preferredExtension)

    );



    const filePath = preferred ?? candidates[0];

    const info = await stat(filePath);



    if (info.size > MAX_DOWNLOAD_BYTES) {

      throw new Error("The downloaded file is larger than the 50 MB limit.");

    }



    const buffer = await readFileFromDisk(filePath);



    return {

      buffer,

      filename: path.basename(filePath),

    };

  } finally {

    try {

      const files = await readdir(DOWNLOAD_DIR);



      await Promise.all(

        files

          .filter((file) => file.startsWith(jobId + "."))

          .map((file) =>

            unlink(path.join(DOWNLOAD_DIR, file)).catch(() => undefined)

          )

      );

    } catch {

      // Ignore cleanup errors.

    }

  }

}





// ====================================================

        async function downloadSong(query: string, onProgress?: (percent: number) => void): Promise<DownloadedMedia & { title: string; url: string; duration: string }> {
  const results = await searchSongs(query, 1);
  const first = results[0];
  if (!first) throw new Error("No song was found for that search.");
  const media = await downloadMedia(first.url, "audio", onProgress);
  return { ...media, title: first.title, url: first.url, duration: first.duration };
}

// ====================================================
        // SONG SEARCH / MUSIC DOWNLOADER
        // ====================================================

        if (
          commandText.toLowerCase().startsWith(".songsearch") ||
          commandText.toLowerCase().startsWith(".songdoc") ||
          commandText.toLowerCase().startsWith(".song") ||
          commandText.toLowerCase().startsWith(".play") ||
          commandText.toLowerCase().startsWith(".music")
        ) {
          const lowerCommand = commandText.toLowerCase();
          let commandName = ".song";
          let mode: "search" | "audio" | "document" = "audio";
          if (lowerCommand.startsWith(".songsearch")) { commandName = ".songsearch"; mode = "search"; }
          else if (lowerCommand.startsWith(".songdoc")) { commandName = ".songdoc"; mode = "document"; }
          else if (lowerCommand.startsWith(".play")) commandName = ".play";
          else if (lowerCommand.startsWith(".music")) commandName = ".music";
          const query = commandText.slice(commandName.length).trim();
          if (!query) {
            await sendBotMessage(sock, jid, { text: mode === "search" ? "🔎 Usage: .songsearch <song name>" : mode === "document" ? "📄 Usage: .songdoc <song name>" : "🎵 Usage: .song <song name>\nExample: .song Shape of You" });
            return;
          }
          try {
            const progressMessage = await sendBotMessage(sock, jid, {
              text: mode === "search"
                ? `🔎 *SEARCHING MUSIC*\n\n🎵 Query: ${query}\n⏳ Finding the best matches...`
                : `🎵 *PREPARING YOUR MUSIC*\n\n🎧 ${query}\n\n⬇️ Download: 0%\n${makeProgressBar(0)}\n⏳ Starting...`
            });

            if (mode === "search") {
              const results = await searchSongs(query, 5);
              if (!results.length) {
                await editBotProgress(sock, jid, progressMessage?.key, "❌ *NO MUSIC FOUND*\n\nTry another song name or artist.");
                return;
              }
              const resultText = results.map((song, index) => `*${index + 1}.* ${song.title}\n   ⏱️ ${song.duration}\n   🔗 ${song.url}`).join("\n\n");
              await editBotProgress(sock, jid, progressMessage?.key, `╭━━━〔 🎵 SONG SEARCH 〕━━━╮\n┃\n${resultText}\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n💡 Use .song <song name> to get the MP3.`);
              return;
            }

            const media = await downloadSong(query, (percent) => {
              void editBotProgress(sock, jid, progressMessage?.key, `🎵 *DOWNLOADING MUSIC*\n\n${makeProgressBar(percent)}  *${Math.round(percent)}%*\n\n📦 Downloading MP3...`);
            });

            await editBotProgress(sock, jid, progressMessage?.key, `✅ *DOWNLOAD COMPLETE*\n\n🎧 ${media.title}\n⏱️ ${media.duration}\n📦 ${formatBytes(media.buffer.length)}\n\n☁️ Preparing WhatsApp upload...`);

            const safeTitle = media.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
            const fileName = `${safeTitle}.mp3`;
            const content = mode === "document"
              ? { document: media.buffer, mimetype: "audio/mpeg", fileName, caption: `╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮\n┃        🎵 *LEO MD MUSIC*        ┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n🎧 *${media.title}*\n⏱️ Duration: ${media.duration}\n📁 Format: MP3\n\n👨‍💻 S.P.B.Pabsara Nawodya\n✨ Leo MD — Made for WhatsApp` }
              : { audio: media.buffer, mimetype: "audio/mpeg", fileName, ptt: false };

            await sendMediaWithUploadProgress(sock, jid, progressMessage?.key, content, media.buffer.length);
            await editBotProgress(sock, jid, progressMessage?.key, `╭━━━〔 ✅ UPLOAD COMPLETE 〕━━━╮\n┃\n┃ 🎵 *${media.title}*\n┃ 📦 ${formatBytes(media.buffer.length)}\n┃ 📁 MP3\n┃\n┃ ☁️ Sent successfully to WhatsApp\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`);
          } catch (error) {
            console.error("❌ SONG ERROR:", error);
            const message = error instanceof Error ? error.message : String(error);
            await sendBotMessage(sock, jid, { text: `❌ *MUSIC DOWNLOAD FAILED*\n\n${message.slice(0, 1800)}\n\nℹ️ Please use public media you are authorized to download.` });
          }
          return;
        }

        // ====================================================
        // ALIVE / BOT STATUS
        // ====================================================

        if (commandText.toLowerCase() === ".alive" || commandText.toLowerCase() === ".online" || commandText.toLowerCase() === ".status") {
          const deviceInfo = deviceSessions.get(deviceId);
          const startedAt = deviceInfo?.startedAt ?? Date.now();
          const phone = sock.user?.id?.split(":")[0] || deviceInfo?.phone || "Unknown";
          const image = await getAliveImage();
          const caption = `╭━━━〔 🤖 LEO MD ALIVE 〕━━━╮\n┃\n┃ 🟢 *ONLINE & RUNNING*\n┃ ⚡ Status: Ready\n┃ 📱 Device: ${deviceId}\n┃ 📞 Number: ${phone}\n┃ ⏱️ Uptime: ${formatUptime(process.uptime())}\n┃ 🕐 Started: ${new Date(startedAt).toLocaleString()}\n┃\n┃ 👨‍💻 *OWNER*\n┃ S.P.B.Pabsara Nawodya\n┃ 📱 ${OWNER_NUMBER || "Not configured"}\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━╯\n\n✨ *Leo MD — Fast • Smart • Friendly*`;
          if (image) await sendBotMessage(sock, jid, { image, caption });
          else await sendBotMessage(sock, jid, { text: caption });
          return;
        }

// MEDIA DOWNLOADER

        // ====================================================



        if (

          commandText.toLowerCase().startsWith(".audio") ||

          commandText.toLowerCase().startsWith(".mp3") ||

          commandText.toLowerCase().startsWith(".video") ||

          commandText.toLowerCase().startsWith(".dl")

        ) {

          const lowerCommand = commandText.toLowerCase();

          let type: "audio" | "video" = "video";

          let commandName = ".dl";



          if (lowerCommand.startsWith(".audio")) {

            type = "audio";

            commandName = ".audio";

          } else if (lowerCommand.startsWith(".mp3")) {

            type = "audio";

            commandName = ".mp3";

          } else if (lowerCommand.startsWith(".video")) {

            type = "video";

            commandName = ".video";

          }



          const url = commandText.slice(commandName.length).trim();



          if (!url) {

            await sendBotMessage(sock, jid, {

              text:

                type === "audio"

                  ? `🎵 Usage:\n${commandName} <YouTube/Facebook/TikTok/etc URL>`

                  : `🎬 Usage:\n${commandName} <YouTube/Facebook/TikTok/etc URL>`,

            });

            return;

          }



          await sendBotMessage(sock, jid, {

            text:

              type === "audio"

                ? "🎵 *AUDIO DOWNLOAD STARTED*\n\n⏳ Processing your media..."

                : "🎬 *VIDEO DOWNLOAD STARTED*\n\n⏳ Processing your media...",

          });



          try {
            const progressMessage = await sendBotMessage(sock, jid, {
              text: type === "audio"
                ? `🎵 *AUDIO DOWNLOAD*\n\n⬇️ Download: 0%\n${makeProgressBar(0)}\n⏳ Starting download...`
                : `🎬 *VIDEO DOWNLOAD*\n\n⬇️ Download: 0%\n${makeProgressBar(0)}\n⏳ Starting download...`
            });

            const media = await downloadMedia(url, type, (percent) => {
              void editBotProgress(sock, jid, progressMessage?.key, `${type === "audio" ? "🎵" : "🎬"} *DOWNLOADING MEDIA*\n\n${makeProgressBar(percent)}  *${Math.round(percent)}%*\n\n📥 Downloading from source...`);
            });

            await editBotProgress(sock, jid, progressMessage?.key, `✅ *DOWNLOAD COMPLETE*\n\n📦 ${formatBytes(media.buffer.length)} ready\n\n☁️ Preparing WhatsApp upload...`);

            const content = type === "audio"
              ? { audio: media.buffer, mimetype: "audio/mpeg", fileName: media.filename, ptt: false }
              : { video: media.buffer, mimetype: "video/mp4", fileName: media.filename, caption: "╭━━━〔 🎬 LEO MD DOWNLOADER 〕━━━╮\n┃\n┃ ⚡ Fast • Smart • Reliable\n┃ 📦 Public media • 50 MB max\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯" };

            await sendMediaWithUploadProgress(sock, jid, progressMessage?.key, content, media.buffer.length);
            await editBotProgress(sock, jid, progressMessage?.key, `╭━━━〔 ✅ UPLOAD COMPLETE 〕━━━╮\n┃\n┃ 📁 ${media.filename}\n┃ 📦 ${formatBytes(media.buffer.length)}\n┃\n┃ ☁️ Sent successfully to WhatsApp\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`);
          } catch (error) {

            console.error("❌ MEDIA DOWNLOAD ERROR:", error);



            const message =

              error instanceof Error ? error.message : String(error);



            await sendBotMessage(sock, jid, {

              text:

                `❌ Download failed bro.\n\n${message.slice(0, 1800)}\n\n` +

                "ℹ️ Use public media URLs you are authorized to download.",

            });

          }



          return;

        }



        // ====================================================



        // IMAGINE



        // ====================================================



        // ====================================================















        if (







          commandText







            .toLowerCase()







            .startsWith(".imagine")







        ) {







          const prompt =







            commandText







              .slice(8)







              .trim();















          if (!prompt) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "🎨 Usage:\n.imagine <your prompt>",







              }







            );















            return;































          }















          await sendBotMessage(sock, 







            jid,







            {







              text:







                "🎨 Generating your image bro... ⏳",







            }







          );















          try {







            const image =







              await generateImage(







                prompt







              );















            await sendBotMessage(sock, 







              jid,







              {







                image,







                caption:







                  `🎨 *Leo AI Image*\n\n${prompt}`,







              }







            );







          } catch (error) {







            console.error(







              "❌ IMAGE GENERATION ERROR:",







              error







            );















            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "❌ Image generation failed bro.",







              }







            );







          }















          return;







        }















        // ====================================================







        // ADVANCED AI COMMANDS
        // ====================================================

        if (lowerCommand.startsWith(".persona")) {
          const option = commandText.split(/\s+/)[1]?.toLowerCase();
          if (!option || option === "list") {
            await sendBotMessage(sock, jid, { text: `🎭 *LEO AI PERSONAS*\n\n${Object.keys(PERSONAS).map((name) => `• ${name}`).join("\n")}\n\nUse: .persona <name>` });
            return;
          }
          if (!PERSONAS[option]) { await sendBotMessage(sock, jid, { text: "❌ Unknown persona. Use `.persona list`." }); return; }
          setPersona(jid, option);
          await sendBotMessage(sock, jid, { text: `🎭 AI persona changed to *${option}* ✅` });
          return;
        }

        if (lowerCommand.startsWith(".translate ")) {
          const input = commandText.slice(11).trim();
          const match = input.match(/^(\S+)\s+([\s\S]+)$/);
          if (!match) { await sendBotMessage(sock, jid, { text: "🌍 Usage: .translate <language> <text>" }); return; }
          const answer = await askAI(jid, `Translate the following text into ${match[1]}. Return only the translation.\n\n${match[2]}`);
          await sendBotMessage(sock, jid, { text: answer }); return;
        }

        if (lowerCommand.startsWith(".summarize ")) {
          const input = commandText.slice(11).trim();
          if (!input) { await sendBotMessage(sock, jid, { text: "📝 Usage: .summarize <text>" }); return; }
          const answer = await askAI(jid, `Summarize this text into clear bullet points. Keep important facts and do not invent information.\n\n${input}`);
          await sendBotMessage(sock, jid, { text: answer }); return;
        }

        if (lowerCommand.startsWith(".fix ")) {
          const input = commandText.slice(5).trim();
          if (!input) { await sendBotMessage(sock, jid, { text: "✍️ Usage: .fix <text>" }); return; }
          const answer = await askAI(jid, `Fix the grammar and spelling. Preserve the original meaning and return only the corrected text.\n\n${input}`);
          await sendBotMessage(sock, jid, { text: answer }); return;
        }

        if (lowerCommand.startsWith(".code ")) {
          const input = commandText.slice(6).trim();
          if (!input) { await sendBotMessage(sock, jid, { text: "💻 Usage: .code <request>" }); return; }
          const answer = await askAI(jid, `Act as an expert developer. Solve this request with complete usable code when appropriate and concise setup steps.\n\n${input}`);
          await sendBotMessage(sock, jid, { text: answer }); return;
        }

        // MEMORY







        // ====================================================















        if (







          commandText.toLowerCase() ===







          ".memory"







        ) {







          const count =







            getMemoryCount(jid);















          await sendBotMessage(sock, 







            jid,







            {







              text:







                `🧠 Persistent Memory: ${count}/${MAX_MEMORY} messages\n💾 Stored in SQLite database.`,







            }







          );















          return;







        }















        // ====================================================







        // CLEAR







        // ====================================================















        if (







          commandText.toLowerCase() ===







          ".clear"







        ) {







          clearMemory(jid);















          await sendBotMessage(sock, 







            jid,







            {







              text:







                "🧹 Memory cleared bro!\n💾 Database updated.",







            }







          );















          return;







        }















        // ====================================================







        // .AI







        // ====================================================















        if (







          commandText







            .toLowerCase()







            .startsWith(".ai ")







        ) {







          const prompt =







            commandText







              .slice(4)







              .trim();















          if (!prompt) {







            await sendBotMessage(sock, 







              jid,







              {







                text:







                  "🤖 Usage:\n.ai <message>",







              }







            );















            return;







          }















          const answer =







            await askAI(







              jid,







              prompt







            );















          await sendBotMessage(sock, 







            jid,







            {







              text: answer,







            }







          );















          return;







        }















        // ====================================================







        // AUTOMATIC AI







        // ====================================================















        const autoAllowed =



            group



              ? getGlobalGroupAI()



              : getGlobalPrivateAI();















        if (!autoAllowed) {







          return;







        }















        if (group) {







          return;







        }















        const answer =







          await askAI(







            jid,







            commandText







          );















        await sendBotMessage(sock, 







          jid,







          {







            text: answer,







          }







        );







      } catch (error) {







        console.error(







          "❌ MESSAGE ERROR:",







          error







        );







      }







    }







  );







}















// ============================================================
// BROWSER PAIRING
// ============================================================

setPairHandler(async () => {
  const newDeviceId = getNextDeviceId();

  if (deviceSessions.has(newDeviceId)) {
    throw new Error(`${newDeviceId} is already running.`);
  }

  setDeviceStatus("starting", newDeviceId);

  void startBot(newDeviceId).catch((error) => {
    const deviceInfo = deviceSessions.get(newDeviceId);
    if (deviceInfo) deviceInfo.status = "offline";

    setDeviceStatus("offline", newDeviceId);

    console.error(`❌ ${newDeviceId} BROWSER PAIR ERROR:`, error);
  });

  return newDeviceId;
});

// ============================================================
// START ALL SAVED DEVICES
// ============================================================

async function startAllDevices(): Promise<void> {
  const deviceIds = new Set<string>(["device-1"]);

  try {
    for (const deviceId of await listPersistedDeviceIds()) {
      deviceIds.add(deviceId);
    }
  } catch (error) {
    console.error("❌ Could not load saved devices from Supabase:", error);
  }

  for (const deviceId of [...deviceIds].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )) {
    void startBot(deviceId).catch((error) => {
      const deviceInfo = deviceSessions.get(deviceId);
      if (deviceInfo) deviceInfo.status = "offline";
      console.error(`❌ ${deviceId} START ERROR:`, error);
    });
  }
}

// ============================================================







// START







// ============================================================















process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received. Saving Leo MD data to Supabase...");
  await flushDatabasePersistence(db, DB_PATH);
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("🛑 SIGINT received. Saving Leo MD data to Supabase...");
  await flushDatabasePersistence(db, DB_PATH);
  process.exit(0);
});

loadSavedOwner().then(() => startAllDevices()).catch(







  (error) => {







    console.error(







      "❌ BOT START ERROR:",







      error







    );







  }







);
