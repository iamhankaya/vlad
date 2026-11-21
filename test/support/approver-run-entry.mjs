// Uzaktan onay kabul testleri (T20261116-05): ÇOCUK SÜREÇ başlatıcısı. Üretim `vlad approver run` env seam'siz kalır; bu dosya AYNI servis kodunu
// (dist/approver/service.js `runApprover`) test deps ile çağırır. Gizli dizin: NODE_OPTIONS=--import no-secret-shim.mjs + VLAD_TEST_SECRET_DIR (harness verir).
// Kullanım: node approver-run-entry.mjs <cfg.json>   cfg: { server, requestTopic, mode: "fake" | "real", record?: dosya, fakeCli?: yol, shim?: yol }
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const dist = (p) => import(pathToFileURL(resolve(import.meta.dirname, "..", "..", "dist", p)).href);
const { runApprover } = await dist("approver/service.js");
const { NtfyChannel } = await dist("approver/ntfy.js");
const { createStore } = await dist("approver/store.js");
const { createExecutor, defaultExecEnv } = await dist("approver/exec.js");
const { approverDir, secretDir } = await dist("mode/token.js");

const fakeExecutor = {
  run(argv, token) {
    return new Promise((res) => {
      const env = { ...defaultExecEnv({ path: process.env.PATH ?? "", home: userInfo().homedir, vladHome: process.env.VLAD_HOME ?? "", token }), FAKE_RECORD: cfg.record };
      const c = spawn(process.execPath, [cfg.fakeCli, ...argv], { env, cwd: process.env.VLAD_HOME, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("close", (code) => res({ exitCode: code, stdout: out, stderr: err, timedOut: false }));
    });
  },
};
// gerçek mod: çocuk `dist/cli.js` gizli dizin olarak TEST dizinini görsün (shim + VLAD_TEST_SECRET_DIR); aksi halde gerçek kullanıcı dizinine bağlanırdı
const realExecutor = { run: (argv, token, ctx) => createExecutor().run(argv, token, ctx, { envExtra: { VLAD_TEST_SECRET_DIR: process.env.VLAD_TEST_SECRET_DIR, NODE_OPTIONS: `--import=${pathToFileURL(cfg.shim).href}` } }) };

const ac = new AbortController();
process.on("SIGTERM", () => ac.abort());
process.on("SIGINT", () => ac.abort());
process.stdout.write(JSON.stringify({ event: "started", pid: process.pid, secretDir: secretDir() }) + "\n");
try {
  await runApprover({
    channel: new NtfyChannel({ v: 1, server: cfg.server, requestTopic: cfg.requestTopic, createdAt: new Date().toISOString() }),
    clock: { now: () => new Date() },
    random: { bytes: (n) => randomBytes(n) },
    executor: cfg.mode === "real" ? realExecutor : fakeExecutor,
    store: createStore(approverDir()),
    log: () => {},
    signal: ac.signal,
  });
  process.exit(0);
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e) + "\n");
  process.exit(/başka servis çalışıyor/.test(String(e && e.message)) ? 75 : 1);
}
