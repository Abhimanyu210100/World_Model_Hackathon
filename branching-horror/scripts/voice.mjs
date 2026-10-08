// Records the narrator with Gemini TTS: one clip per shot in src/story.json
// (n_<scene>_<shot>) plus the intro. Room beds, shrieks and the warning whisper are shared with
// horror-escape and copied into public/voice as-is.
//
//   npm run voice            # skips clips that already exist
//   npm run voice -- --force # re-record everything

import { GoogleGenAI } from "@google/genai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv("development", join(root, ".."), "");
const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const TTS_MODEL = env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const FORCE = process.argv.includes("--force");
const OUT = join(root, "public", "voice");
const story = JSON.parse(readFileSync(join(root, "src", "story.json"), "utf8"));

// Style goes in a leading bracket tag: prose directions get read aloud.
// The leading tag is a performance cue, but the model sometimes ad-libs or
// reads it aloud, so every take is checked against the script and retried
// with the next cue.
const NARRATOR = {
  voice: "Algenib",
  styles: ["slow, low, gravelly horror narrator, dread-filled", "ominous", "speaking slowly, with quiet dread"],
};
const CHECK_MODEL = "gemini-3.8-flash";

// Keep inner apostrophes ("doesn't") but drop quote marks around words.
const words = (t) =>
  t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);

/** Words in common (longest common subsequence) between what was heard and the script. */
function common(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

/** The TTS model sometimes ad-libs; transcribe each take and compare it to the script. */
async function matchesScript(wav, text) {
  const r = await ai.models.generateContent({
    model: CHECK_MODEL,
    contents: [
      { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
      { text: "Transcribe the speech verbatim. Output only the words spoken." },
    ],
  });
  const heard = r.text ?? "";
  const h = words(heard);
  const t = words(text.replace(/\[[^\]]*\]/g, ""));
  const c = common(h, t);
  const extra = h.length - c; // ad-libs, or the cue read aloud
  const missing = t.length - c;
  const ok = extra <= Math.max(1, t.length * 0.06) && missing <= Math.max(1, t.length * 0.1);
  return { ok, score: c / Math.max(h.length, t.length), heard: `${heard} [+${extra} -${missing}]` };
}

const lines = [
  ["intro", `${story.title}. [pause] ${story.intro}`],
  ...Object.entries(story.nodes).flatMap(([id, n]) => n.shots.map((s, i) => [`n_${id}_${i}`, s.narration])),
];

async function record(id, text, attempt = 1) {
  const path = join(OUT, `${id}.wav`);
  if (existsSync(path) && !FORCE) return id;
  try {
    const res = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: `[${NARRATOR.styles[(attempt - 1) % NARRATOR.styles.length]}] ${text}`,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: NARRATOR.voice } } },
      },
    });
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) throw new Error("no audio returned");
    const wav = Buffer.from(part.inlineData.data, "base64");
    const check = await matchesScript(wav, text);
    if (!check.ok) throw new Error(`off-script: "${check.heard.slice(-120)}"`);
    writeFileSync(path, wav);
    console.log(`[voice] ${id}.wav`);
    return id;
  } catch (err) {
    console.warn(`[voice] ${id} attempt ${attempt}: ${err.message}`);
    if (attempt >= 6) {
      console.error(`[voice] ${id} FAILED: ${err.message}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 3000 * attempt));
    return record(id, text, attempt + 1);
  }
}

let next = 0;
const done = [];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < lines.length) done.push(await record(...lines[next++]));
  }),
);

// Manifest covers the recorded narrator plus the shared clips.
const shared = ["bed_breathing", "bed_whispers_a", "bed_whispers_b", "bed_lullaby", "bed_moans", "shriek_0", "shriek_1", "warning"];
const manifest = Object.fromEntries([...done.filter(Boolean), ...shared].map((id) => [id, `${id}.wav`]));
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[done] ${done.filter(Boolean).length}/${lines.length} narrator clips`);
