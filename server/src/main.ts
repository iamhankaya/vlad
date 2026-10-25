import { readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { vladSnapshot } from "./events/diff.ts";
import { EventWatcher, startKbWatch } from "./events/watch.ts";
import { vladProjectSource, vladTaskSource } from "./actions/tasks.ts";
import { createExecutor } from "./actions/executor.ts";
import { vladOps } from "./actions/ops.ts";
import { EventLedger } from "./events/ledger.ts";
import { AppTokenProvider, loadAppKey } from "./github/appToken.ts";
import { GithubClient, observeWrites } from "./github/client.ts";
import { RestGithubReader } from "./github/reader.ts";
import { GithubWriter } from "./github/writer.ts";
import { createChatRunner } from "./chat/wire.ts";
import { buildApp } from "./http/app.ts";
import { assertKbRepoIsNotCodeRepo, buildKbGate, loadKbSyncConfig, projectRepos } from "./kbsync/config.ts";
import { kbSyncView } from "./kbsync/home.ts";
import { createTakeover } from "./kbsync/takeover.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const stateDir = process.env.VLAD_SERVER_STATE_DIR ?? join(homedir(), ".vlad-server");
const ledger = new EventLedger(stateDir);

// Approval path: only with a configured GitHub App (id + private key in the state dir or env). Without it the action routes answer 501.
const appId = process.env.VLAD_GITHUB_APP_ID;
const appKey = loadAppKey(process.env, stateDir);
let actions: NonNullable<Parameters<typeof buildApp>[0]["actions"]> | undefined;
let logWrite: ((method: string, path: string) => void) | undefined;
if (appId && appKey) {
  const tokens = new AppTokenProvider({ appId, privateKey: appKey, installationId: process.env.VLAD_GITHUB_APP_INSTALLATION_ID });
  const client = observeWrites(
    new GithubClient({ tokens }),
    (method, path) => logWrite?.(method, path),
  );
  const reader = new RestGithubReader(client);
  actions = {
    reader, tasks: vladTaskSource, projects: vladProjectSource,
    // `blocked` is expected until `vlad/approved` is written; any other blocker (review, required checks) still stops the merge.
    policy: { allowBlocked: true, appId: Number(appId) },
    execute: createExecutor({
      reader, writer: new GithubWriter(client), tasks: vladTaskSource, ops: vladOps, now: Date.now,
      appendEvent: (type, data, key) => ledger.append(type, data, key),
      appId: Number(appId), mergerLogin: process.env.VLAD_GITHUB_APP_LOGIN, resolveMergerLogin: () => tokens.botLogin(),
      log: (m) => console.warn(m),
    }),
  };
}
// kb promote gate (S13c): takeover route and the kb_sync/takeover fields of /home. Needs the App token (writes main) and VLAD_KB_REPO.
let kbActive: Pick<Parameters<typeof buildApp>[0], "active" | "read"> = {};
const kbCfg = loadKbSyncConfig(process.env, stateDir);
if (kbCfg && appId && appKey) {
  // a kb repo that is also a project's code repo would let pushKbMain write a code main without the approval path: refuse to start
  assertKbRepoIsNotCodeRepo(kbCfg.repo, await projectRepos());
  const tokens = new AppTokenProvider({ appId, privateKey: appKey, installationId: process.env.VLAD_GITHUB_APP_INSTALLATION_ID });
  const gate = await buildKbGate({ config: kbCfg, tokens, client: new GithubClient({ tokens }) });
  kbActive = {
    active: { takeover: createTakeover(gate.takeoverDeps) },
    read: { activeExtra: () => kbSyncView({ kbDir: kbCfg.kbDir, stateDir: kbCfg.stateDir, now: Date.now }) },
  };
} else if (kbCfg) console.warn("VLAD_KB_REPO ayarlı ama GitHub App yok: devralma ve promote devre dışı");
// Chat (F-vlad-024): only with the sandboxed turn socket (deploy/systemd/vlad-chat.socket) and a root-owned client; otherwise the chat routes answer 501.
const chatKbDir = process.env.VLAD_KB_DIR ?? (process.env.VLAD_HOME ? join(process.env.VLAD_HOME, "kb") : undefined);
const chatRunner = chatKbDir ? createChatRunner({ env: process.env, stateDir, kbDir: chatKbDir, ledger, log: (m) => console.warn(m) }) : undefined;
const app = buildApp({ stateDir, version: pkg.version, trustProxy: process.env.VLAD_SERVER_TRUST_PROXY === "1" ? "loopback" : false, logger: true, events: { ledger }, chat: { log: (m) => console.warn(m), ...(chatRunner ? { runner: chatRunner } : {}) }, ...kbActive, ...(actions ? { actions, grants: { sweepMs: 60_000, log: (m: string) => console.warn(m) } } : {}) });
app.addHook("onClose", async () => chatRunner?.stop());
logWrite = (method, path) => app.log.info({ method, path }, "github write");
if (!actions) app.log.warn("GitHub App yapılandırılmadı (VLAD_GITHUB_APP_ID + anahtar): onay uçları 501");

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
