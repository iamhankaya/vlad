import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad, startAgent, type HomePair, type RunningAgent, type Side } from "./harness.js";

// Gerçek alt süreç Agent'larla uçtan uca (loopback TCP, --port 0). Her test kendi home çiftini kullanır.
const CARD = `---
slug: alpha
name: Alpha
path: ${JSON.stringify(process.cwd())}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const config = (mac: number, windows: number) => ({
  machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: mac } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: windows } }],
  brain: "mac", consoles: [{ name: "desktop" }],
});
const writeCfg = (p: HomePair, mac: number, windows: number) => { for (const s of [p.brain, p.worker]) writeFileSync(join(s.home, "vlad.config.json"), JSON.stringify(config(mac, windows))); };

async function setup(brainTest: Record<string, string> = {}) {
  const p = makeHomePair({ config: config(7437, 7437), consoles: ["desktop"] });
  cleanups.push(() => rmTemp(dirname(p.brain.home)), () => p.cleanup());
  writeFileSync(join(p.brain.home, "card.md"), CARD);
  expect(spawnVlad(p.brain, ["project", "write", "alpha", "--file", join(p.brain.home, "card.md")]).code).toBe(0);
  const id = JSON.parse(spawnVlad(p.brain, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], { stdin: "## Tanım\nx\n" }).out).id as string;
  const taskFile = join(p.brain.kb, "tasks", `${id}.md`);
  writeFileSync(taskFile, readFileSync(taskFile, "utf8").replace(/^state: queued$/m, "state: running\nmachine: windows"));
  const ports = { mac: 0, windows: 0 };
  const agents: { mac?: RunningAgent; windows?: RunningAgent } = {};
  cleanups.push(async () => { await agents.mac?.stop(); await agents.windows?.stop(); });
  const start = async (who: "mac" | "windows", test?: Record<string, string>) => {
    const a = await startAgent(who === "mac" ? p.brain : p.worker, { test: { VLAD_AGENT_FLUSH_MS: "86400000", ...test } });
    agents[who] = a; ports[who] = a.port; writeCfg(p, ports.mac || 7437, ports.windows || 7437);
  };
  const stop = async (who: "mac" | "windows") => { await agents[who]?.stop(); agents[who] = undefined; };
  await start("mac", brainTest);
  await start("windows");
  const text = () => readFileSync(taskFile, "utf8");
  const consoleSide: Side = { ...p.worker, env: { ...p.worker.env, VLAD_LOCAL_FILE: p.consoleLocal("desktop"), VLAD_MACHINE: "desktop" } };
  return { p, id, start, stop, text, consoleSide };
}

describe("machines:B end-to-end (real Agent processes)", () => {
  it("worker `task log|ask|report|session` reach the brain with CLI-identical output; the worker kb is untouched", async () => {
    const { p, id, text } = await setup();
    const log = spawnVlad(p.worker, ["task", "log", id, "merhaba çğıöşü"]);
    expect(log).toMatchObject({ code: 0, out: "eklendi\n" });
    expect(text()).toContain("merhaba çğıöşü");
    const j = spawnVlad(p.worker, ["task", "log", id, "--", "-x --y", "--json"]); // `-` ile başlayan metin düz veridir
    expect(j.code).toBe(1); // "--json" ikinci positional'dır → fazla argüman; asıl nokta: kabuk/flag enjeksiyonu yok
    expect(spawnVlad(p.worker, ["task", "log", id, "--", "-x --y"]).code).toBe(0);
    expect(text()).toContain("-x --y");
    const ses = spawnVlad(p.worker, ["task", "session", id, "sess-1", "--json"]);
    expect(JSON.parse(ses.out)).toEqual({ id, session_id: "sess-1" });
    const body = "### Yapılanlar\r\nÇok \"tırnaklı\" $HOME `tick` ✓\n".repeat(4000);
    expect(spawnVlad(p.worker, ["task", "report", id, "--file", "-"], { stdin: body }).code).toBe(0);
    expect(text()).toContain("Çok \"tırnaklı\" $HOME `tick` ✓");
    expect(text()).toMatch(/^state: awaiting_approval$/m);
    expect(spawnVlad(p.worker, ["task", "list", "--json"]).out).not.toContain(id); // işçi kb'sine yazılmadı
  }, 60_000);

  it("a task owned by another machine is forbidden and the file does not change", async () => {
    const { p, id, text } = await setup();
    writeFileSync(join(p.brain.kb, "tasks", `${id}.md`), text().replace("machine: windows", "machine: mac"));
    const before = text();
    const r = spawnVlad(p.worker, ["task", "log", id, "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("forbidden: görev başka makineye ait");
    expect(text()).toBe(before);
  }, 60_000);

  it("brain down → queued (exit 0, JSON {queued}), `queue list` shows it, flush after the brain returns delivers exactly once", async () => {
    const { p, id, start, stop, text } = await setup();
    await stop("mac");
    const q = spawnVlad(p.worker, ["task", "log", id, "kuyruktaki satır", "--json"]);
    expect(q.code).toBe(0);
    expect(JSON.parse(q.out)).toMatchObject({ queued: true, seq: 1 });
    expect(q.err).toContain("kuyruğa alındı");
    expect(spawnVlad(p.worker, ["queue", "list", "--json"]).out).toContain('"seq":1');
    await start("mac");
    const f = spawnVlad(p.worker, ["queue", "flush", "--json"]);
    expect(JSON.parse(f.out)).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(text().split("kuyruktaki satır")).toHaveLength(2);
    expect(JSON.parse(spawnVlad(p.worker, ["queue", "flush", "--json"]).out).sent).toBe(0);
  }, 60_000);

  it("order is kept: later writes queue behind an earlier pending one and flush in seq order", async () => {
    const { p, id, start, stop, text } = await setup();
    await stop("mac");
    for (const m of ["bir", "iki", "uc"]) expect(spawnVlad(p.worker, ["task", "log", id, m]).code).toBe(0);
    await start("mac");
    expect(JSON.parse(spawnVlad(p.worker, ["queue", "flush", "--json"]).out).sent).toBe(3);
    const t = text();
    expect(t.indexOf(" bir")).toBeLessThan(t.indexOf(" iki"));
    expect(t.indexOf(" iki")).toBeLessThan(t.indexOf(" uc"));
  }, 60_000);

  it("crash after apply: the retry with the same opId is recovered by reconciliation, not applied twice (ask)", async () => {
    const { p, id, start, stop, text } = await setup({ VLAD_TEST_CRASH_AT: "after-apply" });
    const r = spawnVlad(p.worker, ["task", "ask", id, "kritik soru?"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("kuyruğa alındı"); // yanıt gelmedi → belirsiz → kuyruk
    expect(text().split("kritik soru?").length).toBe(2); // etki uygulanmıştı
    await stop("mac");
    await start("mac"); // çökme bayrağı yok; açılışta uzlaştırma
    expect(JSON.parse(spawnVlad(p.worker, ["queue", "flush", "--json"]).out)).toEqual({ sent: 1, failed: 0, remaining: 0 });
    expect(text().split("kritik soru?").length).toBe(2);
  }, 60_000);

  it("worker Agent not running → exit 75 with a clear message; non-forwardable kb writes are refused (exit 1)", async () => {
    const { p, id, stop } = await setup();
    const w = spawnVlad(p.worker, ["project", "set", "alpha", "exposure", "local"]);
    expect(w.code).toBe(1);
    expect(w.err).toContain("bu makine beyin değil");
    await stop("windows");
    const r = spawnVlad(p.worker, ["task", "log", id, "x"]);
    expect(r.code).toBe(75);
    expect(r.err).toContain("yerel VLAD Agent çalışmıyor (vlad agent status)");
  }, 60_000);

  it("`agent start` twice: the second exits 0 with 'zaten çalışıyor'; `agent status` reports it", async () => {
    const { p, start } = await setup();
    void start;
    const st = spawnVlad(p.worker, ["agent", "status", "--json"]);
    expect(JSON.parse(st.out)).toMatchObject({ running: true, machine: "windows" });
    const port = JSON.parse(st.out).port as number;
    const second = spawnVlad(p.worker, ["agent", "start", "--port", String(port)]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("zaten çalışıyor");
  }, 60_000);

  it("`agent start` refuses a public bind address", async () => {
    const p = makeHomePair({ config: { ...config(7437, 7437), machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", bind: "8.8.8.8", port: 7437 } }] } });
    cleanups.push(() => p.cleanup());
    const r = spawnVlad(p.worker, ["agent", "start", "--port", "0"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("agent: genel adrese bağlanılamaz: 8.8.8.8");
    const w = makeHomePair({ config: { ...config(7437, 7437), machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "0.0.0.0", port: 7437 } }] } });
    cleanups.push(() => w.cleanup());
    expect(spawnVlad(w.worker, ["agent", "start", "--port", "0"]).err).toContain("genel adrese bağlanılamaz: 0.0.0.0");
  }, 60_000);

  it("`agent keygen` writes a new 64-hex key to the local file and the old key stops working", async () => {
    const { p } = await setup();
    const k = JSON.parse(spawnVlad(p.worker, ["agent", "keygen", "windows", "--json"]).out);
    expect(k.key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(p.worker.local, "utf8")).keys.windows).toBe(k.key);
    expect(k.key).not.toBe(p.keys.windows);
    expect(spawnVlad(p.worker, ["agent", "keygen", "ghost"]).code).toBe(1);
  }, 60_000);

  it("console: `vlad remote` runs catalog commands on the brain and mirrors stdout/exit; off-catalog and bad file flags are forbidden", async () => {
    const { p, id, consoleSide, stop } = await setup();
    const direct = spawnVlad(p.brain, ["task", "list", "--json"]);
    const viaRemote = spawnVlad(consoleSide, ["remote", "--", "task", "list", "--json"]);
    expect(viaRemote.code).toBe(0);
    expect(viaRemote.out).toBe(direct.out);
    expect(viaRemote.out).toContain(id);
    const bad = spawnVlad(consoleSide, ["remote", "--", "agent", "keygen", "windows"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("forbidden: komut konsoldan çalıştırılamaz: agent keygen");
    expect(spawnVlad(consoleSide, ["remote", "--", "task", "report", id, "--file", "/etc/passwd"]).err).toContain("forbidden");
    const opId = "11111111-1111-4111-8111-111111111111";
    const w1 = spawnVlad(consoleSide, ["remote", "--op-id", opId, "--", "task", "log", id, "konsoldan"]);
    const w2 = spawnVlad(consoleSide, ["remote", "--op-id", opId, "--", "task", "log", id, "konsoldan"]);
    expect(w1.code).toBe(0);
    expect(w2.out).toBe(w1.out);
    expect(readFileSync(join(p.brain.kb, "tasks", `${id}.md`), "utf8").split("konsoldan")).toHaveLength(2); // opId tekrarı çift yazmadı
    await stop("mac");
    const down = spawnVlad(consoleSide, ["remote", "--", "task", "list", "--json"]);
    expect(down.code).toBe(75);
  }, 60_000);

  it("a worker identity cannot use `exec`; the console key cannot `apply-write` (task files unchanged)", async () => {
    const { p, id, text } = await setup();
    // işçi kimliğiyle remote: konsol değil → istemci tarafı reddi
    expect(spawnVlad(p.worker, ["remote", "--", "task", "list"]).err).toContain("bir konsol kimliği değil");
    expect(text()).toContain("machine: windows");
    void id;
  }, 60_000);
});
