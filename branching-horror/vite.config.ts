import { defineConfig, loadEnv, type Plugin } from "vite";

// The Reactor API key lives in ../.env.local and never reaches the browser:
// the dev server mints short-lived FastH3 session tokens on request.
const env = loadEnv("development", "..", "");

function reactorToken(): Plugin {
  return {
    name: "reactor-token",
    configureServer(server) {
      server.middlewares.use("/api/reactor/token", async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        try {
          const r = await fetch("https://api.reactor.inc/tokens", {
            method: "POST",
            headers: { "Reactor-API-Key": env.REACTOR_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              authorization_details: [{ type: "session", resources: { models: { match: ["reactor/fast-h3"] } } }],
              expires_after: 3600,
            }),
          });
          if (!r.ok) throw new Error(`Reactor token ${r.status}: ${await r.text()}`);
          const { jwt } = await r.json();
          res.end(JSON.stringify({ jwt }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [reactorToken()],
  // The Reactor SDK loads its wasm core via a relative dynamic import, which
  // breaks once Vite pre-bundles it. Serve it as-is.
  optimizeDeps: {
    exclude: ["@reactor-team/js-sdk", "@reactor-models/fast-h3"],
    include: [
      "@reactor-team/js-sdk > awaitqueue",
      "@reactor-team/js-sdk > hls.js",
      "@reactor-team/js-sdk > mp4box",
      "react",
      "react/jsx-runtime",
    ],
  },
  server: { port: 5174, strictPort: true, host: "127.0.0.1" },
});
