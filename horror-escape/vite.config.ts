import { defineConfig, loadEnv, type Plugin } from "vite";
import { GoogleGenAI } from "@google/genai";
import type { IncomingMessage } from "node:http";

// Keys live in ../.env.local and never reach the browser: the dev server mints
// Reactor JWTs and runs the Gemini "game master" calls on the player's behalf.
const env = loadEnv("development", "..", "");
const JUDGE_MODEL = env.GEMINI_JUDGE_MODEL || "gemini-3.8-flash";

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const judgeSchema = {
  type: "object",
  properties: {
    key_visible: { type: "boolean", description: "A small brass/metal key is clearly visible in the frame." },
    key_reachable: { type: "boolean", description: "The key is near the centre of the frame and close enough to grab." },
    door_visible: { type: "boolean", description: "A doorway or door is prominent and reasonably close in the frame." },
    narration: { type: "string", description: "One short, eerie, second-person sentence (max 18 words) describing what the player sees or finds." },
    direction: { type: "string", description: "One short hint about where to turn or move (left/right/forward/back/look down, etc.)." },
  },
  required: ["key_visible", "key_reachable", "door_visible", "narration", "direction"],
};

function gameMaster(): Plugin {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return {
    name: "game-master",
    configureServer(server) {
      server.middlewares.use("/api/reactor/token", async (_req, res) => {
        try {
          const r = await fetch("https://api.reactor.inc/tokens", {
            method: "POST",
            headers: { "Reactor-API-Key": env.REACTOR_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              authorization_details: [
                { type: "session", resources: { models: { match: ["reactor/lingbot-world-2"] } } },
              ],
              expires_after: 3600,
            }),
          });
          if (!r.ok) throw new Error(`Reactor token ${r.status}: ${await r.text()}`);
          const { jwt } = await r.json();
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "private, no-store");
          res.end(JSON.stringify({ jwt }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // The player's current frame goes to Gemini, which judges what is
      // actually on screen: is the key visible/grabbable, is a door in reach,
      // and which way should they go.
      server.middlewares.use("/api/judge", async (req, res) => {
        try {
          const { frame, intent, room, keyHere, keySpot, keyRoomName, hasKey } = await readJson(req);
          const context = keyHere
            ? `The key is hidden in this room: ${keySpot}. Guide the player toward it without naming it outright.`
            : hasKey
              ? "The player already has the key; nudge them back toward the foyer's front door."
              : `The key is NOT in this room; it is in ${keyRoomName}. In the direction field, tell the player to leave and head for ${keyRoomName} (they press F at a doorway to move rooms).`;
          const result = await ai.models.generateContent({
            model: JUDGE_MODEL,
            contents: [
              { inlineData: { mimeType: "image/jpeg", data: frame } },
              {
                text: `You are the unseen game master of a horror escape game. This is the player's live first-person view in the ${room}.
Player intent: ${intent} (search = looking for the key, door = trying to leave this room, hint = asking for direction).
${context}
Judge strictly from the image. Only report key_visible if you can actually see a key.`,
              },
            ],
            config: { responseMimeType: "application/json", responseJsonSchema: judgeSchema },
          });
          res.setHeader("Content-Type", "application/json");
          res.end(result.text);
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [gameMaster()],
  // The Reactor SDK loads its wasm core via a relative dynamic import, which
  // breaks once Vite pre-bundles it into node_modules/.vite/deps. Serve it
  // as-is and pre-bundle only its CommonJS dependencies.
  optimizeDeps: {
    exclude: ["@reactor-team/js-sdk", "@reactor-models/lingbot-world-2"],
    include: [
      "@reactor-team/js-sdk > awaitqueue",
      "@reactor-team/js-sdk > hls.js",
      "@reactor-team/js-sdk > mp4box",
      "react",
      "react/jsx-runtime",
    ],
  },
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
});
