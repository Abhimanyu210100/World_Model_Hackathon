// Pre-production pass: Gemini writes the game's direction (story, per-room
// LingBot prompts, key hiding spots, scares) and paints the grounding images
// that LingBot-World-2 uses as the first frame of each room.
//
//   npm run generate            # full run (skips images that already exist)
//   npm run generate -- --force # regenerate everything

import { GoogleGenAI } from "@google/genai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv("development", join(root, ".."), "");
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing from ../.env.local");

const DIRECTOR_MODEL = env.GEMINI_DIRECTOR_MODEL || "gemini-3.8-flash";
const IMAGE_MODEL = env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
const FORCE = process.argv.includes("--force");
const OUT = join(root, "public", "generated");
mkdirSync(OUT, { recursive: true });

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

// The map is fixed in code so game logic never depends on model output.
const ROOMS = [
  { id: "foyer", exits: ["hallway"], keyCandidate: false },
  { id: "hallway", exits: ["foyer", "nursery", "kitchen"], keyCandidate: false },
  { id: "nursery", exits: ["hallway"], keyCandidate: true },
  { id: "kitchen", exits: ["hallway", "basement"], keyCandidate: true },
  { id: "basement", exits: ["kitchen"], keyCandidate: true },
];

const roomSchema = {
  type: "object",
  properties: {
    id: { type: "string", enum: ROOMS.map((r) => r.id) },
    name: { type: "string", description: "Short evocative room name" },
    image_prompt: {
      type: "string",
      description:
        "Prompt for a photoreal first-person still of this room, eye level, 16:9, wide lens, at least one visible doorway, dim practical lighting, no people, no text.",
    },
    lingbot_prompt: {
      type: "string",
      description:
        "One or two sentences for a real-time world model describing the scene, atmosphere, light and slow ambient motion (dust, flicker, swaying). No camera instructions.",
    },
    key_spot: {
      type: "string",
      description: "A concrete place in this room where a small brass key could be hidden yet visible (e.g. 'on the cot's mattress beside a porcelain doll').",
    },
    entry_line: { type: "string", description: "One unsettling sentence shown on entering." },
    search_fail_lines: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
    scare_edit: {
      type: "string",
      description: "Image-edit instruction adding a terrifying apparition to THIS room photo, close to camera (a pale figure, a face in the dark, etc.). Unsettling, not gory.",
    },
    scare_lingbot_prompt: {
      type: "string",
      description: "Same scene for the world model, but a pale silhouette now stands in a doorway and the lights stutter.",
    },
  },
  required: ["id", "name", "image_prompt", "lingbot_prompt", "key_spot", "entry_line", "search_fail_lines", "scare_edit", "scare_lingbot_prompt"],
};

const scriptSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    intro: { type: "string", description: "2-3 sentence second-person intro. The front door is locked; the brass key is somewhere in the house." },
    style: { type: "string", description: "Shared visual style suffix appended to every image prompt, for consistency." },
    rooms: { type: "array", items: roomSchema, minItems: ROOMS.length, maxItems: ROOMS.length },
    key_found_line: { type: "string" },
    locked_door_line: { type: "string", description: "Said when trying the front door without the key." },
    win_line: { type: "string" },
    lose_line: { type: "string", description: "Said when time runs out and it finds you." },
    whispers: { type: "array", items: { type: "string" }, minItems: 6, maxItems: 6, description: "Short whispered fragments shown between scares." },
  },
  required: ["title", "intro", "style", "rooms", "key_found_line", "locked_door_line", "win_line", "lose_line", "whispers"],
};

async function direct() {
  const path = join(OUT, "script.json");
  if (existsSync(path) && !FORCE) return JSON.parse(readFileSync(path, "utf8"));
  console.log(`[director] ${DIRECTOR_MODEL} writing the script…`);
  const res = await ai.models.generateContent({
    model: DIRECTOR_MODEL,
    contents: `You are the creative director of a short first-person horror escape game rendered live by a world model.
Setting: an abandoned 1970s farmhouse at night during a storm. The player must find a small tarnished brass key and escape through the front door.
Rooms (fixed ids, connections): ${ROOMS.map((r) => `${r.id} -> ${r.exits.join(", ")}`).join("; ")}.
The foyer contains the locked front door. Each room must be visually distinct and must show at least one doorway.
Keep it dread-heavy and atmospheric: no gore, no text in images, no people in the base room images.`,
    config: { responseMimeType: "application/json", responseJsonSchema: scriptSchema },
  });
  const script = JSON.parse(res.text);
  // Merge the fixed map in and order rooms like ROOMS.
  script.rooms = ROOMS.map((r) => {
    const g = script.rooms.find((x) => x.id === r.id);
    if (!g) throw new Error(`Director omitted room ${r.id}`);
    return { ...g, ...r };
  });
  writeFileSync(path, JSON.stringify(script, null, 2));
  return script;
}

function imagePart(res) {
  const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error(`No image returned: ${res.text ?? JSON.stringify(res.promptFeedback)}`);
  return Buffer.from(part.inlineData.data, "base64");
}

async function paint(file, contents, attempt = 1) {
  const path = join(OUT, file);
  if (existsSync(path) && !FORCE) return path;
  try {
    const res = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents,
      config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
    });
    writeFileSync(path, imagePart(res));
    console.log(`[painter] ${file}`);
    return path;
  } catch (err) {
    if (attempt >= 3) throw err;
    console.warn(`[painter] ${file} failed (${err.message}); retrying`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
    return paint(file, contents, attempt + 1);
  }
}

const asInline = (path) => ({ inlineData: { mimeType: "image/png", data: readFileSync(path).toString("base64") } });

const script = await direct();
console.log(`[director] "${script.title}"`);

// Base rooms first; key and scare variants are edits of them so they stay consistent.
await Promise.all(
  script.rooms.map((room) => paint(`${room.id}.png`, `${room.image_prompt}. ${script.style}`)),
);
await Promise.all(
  script.rooms.flatMap((room) => {
    const base = asInline(join(OUT, `${room.id}.png`));
    const jobs = [
      paint(`${room.id}_scare.png`, [
        base,
        { text: `${room.scare_edit}. Keep the room identical; the apparition is close to camera, filling much of the frame. ${script.style}` },
      ]),
    ];
    if (room.keyCandidate) {
      jobs.push(
        paint(`${room.id}_key.png`, [
          base,
          { text: `Add a small tarnished brass skeleton key ${room.key_spot}, catching a faint glint of light so a careful observer can spot it. Change nothing else.` },
        ]),
      );
    }
    return jobs;
  }),
);

// Jump-scare faces: extreme close-ups that fill the whole screen.
const FACES = [
  "a gaunt pale ghoul woman with milky white eyes, stringy wet black hair, grey cracked skin, mouth stretched impossibly wide in a scream",
  "an emaciated corpse-like man with hollow pitch-black eye sockets, paper-thin grey skin stretched over the skull, jaw unhinged mid-shriek",
  "a twisted porcelain-white face with too-wide bloodshot eyes, cracked lips peeled back over long yellowed teeth, screaming",
];
await Promise.all(
  FACES.map((face, i) =>
    paint(
      `scare_face_${i}.png`,
      `Extreme close-up horror movie jump-scare frame: ${face}, lunging straight into the camera lens. The face fills the ENTIRE frame edge to edge, eyes staring directly at the viewer. Harsh on-camera flash in total darkness, motion blur, film grain, desaturated sickly palette. Terrifying, no gore, no text.`,
    ),
  ),
);

console.log("[done] assets in public/generated/");
