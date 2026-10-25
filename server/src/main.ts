import { readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { vladSnapshot } from "./events/diff.ts";
import { EventWatcher, startKbWatch } from "./events/watch.ts";
import { buildApp } from "./http/app.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const stateDir = process.env.VLAD_SERVER_STATE_DIR ?? join(homedir(), ".vlad-server");
const app = buildApp({ stateDir, version: pkg.version, trustProxy: process.env.VLAD_SERVER_TRUST_PROXY === "1" ? "loopback" : false, logger: true });

// Event source: the kb (VLAD_KB_DIR, else <VLAD_HOME>/kb). Without VLAD_HOME there is nothing to look at (read routes answer 503 too).
const kb = process.env.VLAD_KB_DIR ?? (process.env.VLAD_HOME ? join(process.env.VLAD_HOME, "kb") : undefined);
if (kb) {
  const watcher = new EventWatcher({
    ledger: app.vladEvents.ledger,
    snapshot: () => vladSnapshot(),
    onError: (e) => app.log.warn({ err: e }, "event snapshot failed"),
  });
  const stop = startKbWatch({
    watcher,
    dirs: ["tasks", "cards"].map((d) => join(kb, d)).concat(kb),
    watch: (dir, cb) => {
      try {
        const w = watch(dir, () => cb());
        w.on("error", () => w.close());
        return w;
      } catch {
        return { close() {} }; // directory missing: the fallback tick still looks
      }
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    debounceMs: 500,
    fallbackMs: 30_000,
  });
  app.addHook("onClose", async () => stop());
}
// Loopback only: the public side is Tailscale Funnel, never a direct listener.
await app.listen({ host: process.env.VLAD_SERVER_HOST ?? "127.0.0.1", port: Number(process.env.VLAD_SERVER_PORT ?? 8787) });
