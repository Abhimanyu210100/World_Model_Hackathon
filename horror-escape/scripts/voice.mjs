// Voice pass: Gemini TTS performs every narrated line from script.json plus
// looping vocal "beds" (breathing, humming, moaning, whispers) used as room
// ambience. Output: public/voice/*.wav + manifest.json.
//
//   npm run voice            # skips clips that already exist
//   npm run voice -- --force # re-record everything

import { GoogleGenAI } from "@google/genai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv("development", join(root, ".."), "");
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing from ../.env.local");

const TTS_MODEL = env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const FORCE = process.argv.includes("--force");
const OUT = join(root, "public", "voice");
mkdirSync(OUT, { recursive: true });

const scriptPath = join(root, "public", "generated", "script.json");
if (!existsSync(scriptPath)) throw new Error("Run `npm run generate` first");
const script = JSON.parse(readFileSync(scriptPath, "utf8"));

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// Prebuilt Gemini voices cast by role.
// Style goes in a leading bracket tag: prose directions ("Perform this as…")
// get read aloud by the TTS model, and it rejects system instructions.
const CAST = {
  narrator: { voice: "Algenib", style: "slow, low, gravelly horror narrator, close to the mic, dread-filled" },
  whisper: { voice: "Enceladus", style: "breathy, unhinged whisper right beside your ear" },
  whisper2: { voice: "Achernar", style: "soft, cold ghostly whisper from inside the walls" },
  entity: { voice: "Algenib", style: "inhuman guttural shriek, full force" },
  child: { voice: "Leda", style: "small child, eerily calm, humming softly and off-key" },
  moaner: { voice: "Gacrux", style: "distant, suffering, low moan through old walls" },
  banshee: { voice: "Kore", style: "piercing, terrified, ear-splitting horror-movie scream at full force" },
};

// [id, role, text]
const lines = [
  ["intro", "narrator", `${script.title}. [pause] ${script.intro}`],
  ...script.rooms.map((r) => [`room_${r.id}`, "narrator", `${r.name}. [pause] ${r.entry_line}`]),
  ...script.rooms.flatMap((r) => r.search_fail_lines.map((l, i) => [`search_${r.id}_${i}`, "narrator", l])),
  ["key_found", "narrator", `[sharp intake of breath] ${script.key_found_line} [pause] [whispers] It knows.`],
  ["door_locked", "narrator", script.locked_door_line],
  ["win", "narrator", `${script.win_line} [pause] [whispers] Come back soon.`],
  ["lose", "narrator", script.lose_line],
  ...script.whispers.map((w, i) => [`whisper_${i}`, "whisper", `[whispers] ${w}`]),
  ["warning", "whisper", "[whispers urgently] You should never turn your back... towards open hallways."],
  ["scare_0", "entity", "[screams] GET OUT!"],
  ["scare_1", "entity", "[shrieks] FOUND YOU!"],
  ["scare_2", "entity", "[snarls] BEHIND YOU!"],
  ["scare_3", "entity", "[screams] AAAAAHHHHHHH!"],
  ["shriek_0", "banshee", "[blood-curdling shriek] AAAAAAAAAAAAHHHHHHHHHHHH!"],
  ["shriek_1", "entity", "[demonic roaring scream] RAAAAAAAAAAAAAHHHHHHHHHHH!"],
];

// Looping ambience beds, ~20-30s each.
const beds = [
  ["bed_breathing", "whisper", "[breathing slowly and raggedly] ... [long shaky exhale] ... [breathing] ... [wet, rattling inhale] ... [breathing] ... [long exhale] ... [breathing] ... [quiet rattling inhale] ... [breathing]"],
  ["bed_lullaby", "child", "[humming] Hmm hmm hmmm, hmm hmm hmmm... [humming] Hush now, don't you cry... [humming] hmm hmm hmmm... [humming] Mama's in the walls tonight... [humming] hmm hmm hmmm, hmm hmm hmmm..."],
  ["bed_moans", "moaner", "[moaning] Ohhhhhhh... [pause] ... [moaning] Mmmmmhhhhh... [pause] ... [groaning] Uhhhhhhhh... [pause] ... [moaning] Ohhhhhhh..."],
  ["bed_whispers_a", "whisper", "[whispers] she's here... [pause] she's here... [whispers] don't look... [pause] [whispers] it's under the floor... [whispers] she's here... [pause] [whispers] count the doors... [whispers] don't look..."],
  ["bed_whispers_b", "whisper2", "[whispers] come down... [pause] [whispers] come down to us... [pause] [whispers] it's so cold... [whispers] stay... [pause] stay with us... [whispers] come down..."],
];

// --- WAV helpers: trim near-silent head/tail so clips hit on cue.
function trimWav(buf) {
  const dataIdx = buf.indexOf("data");
  const header = buf.subarray(0, dataIdx + 8);
  const pcm = buf.subarray(dataIdx + 8);
  const n = pcm.length >> 1;
  const sr = header.readUInt32LE(24);
  const win = Math.floor(sr / 50);
  const loud = (i) => {
    let s = 0;
    for (let j = i; j < Math.min(n, i + win); j++) s += Math.abs(pcm.readInt16LE(j * 2));
    return s / win > 300;
  };
  let a = 0;
  while (a < n && !loud(a)) a += win;
  let b = n - win;
  while (b > a && !loud(b)) b -= win;
  a = Math.max(0, a - win * 2);
  b = Math.min(n, b + win * 8);
  const out = Buffer.from(pcm.subarray(a * 2, b * 2));
  const h = Buffer.from(header);
  h.writeUInt32LE(36 + out.length, 4);
  h.writeUInt32LE(out.length, dataIdx + 4);
  return Buffer.concat([h, out]);
}

async function record(id, role, text, attempt = 1) {
  const file = `${id}.wav`;
  const path = join(OUT, file);
  if (existsSync(path) && !FORCE) return [id, file];
  const { voice, style } = CAST[role];
  try {
    const res = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: `[${style}] ${text}`,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error(`no audio (${res.text ?? JSON.stringify(res.promptFeedback)})`);
    let wav = Buffer.from(part.inlineData.data, "base64");
    if (wav.subarray(0, 4).toString() === "RIFF") wav = trimWav(wav);
    writeFileSync(path, wav);
    console.log(`[voice] ${file}`);
    return [id, file];
  } catch (err) {
    if (attempt >= 4) {
      console.error(`[voice] ${file} FAILED: ${err.message}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
    return record(id, role, text, attempt + 1);
  }
}

// Small worker pool to stay under rate limits.
const jobs = [...lines, ...beds];
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      results.push(await record(...job));
    }
  }),
);

const manifest = Object.fromEntries(results.filter(Boolean));
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[done] ${Object.keys(manifest).length}/${jobs.length} clips in public/voice/`);
