import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv, spawnVlad } from "../support/spawn-vlad.js";
import { ALLOWED_EXEC_ENV, resultOf, sleep, submit, waitFor, writeRequest, waitAck } from "./approver-harness.js";
import { makeWorld } from "./approver-harness.js";
import type { World } from "./approver-harness.js";

// approver-kabul: ÇOCUK SÜREÇ senaryoları (port, tekillik, env, gerçek VMT2 ile dist/cli.js). Servis `approver-run-entry.mjs` ile (aynı runApprover kodu, test deps);
// üretim `vlad approver run` env seam'siz. Gizli dizin: NODE_OPTIONS shim + VLAD_TEST_SECRET_DIR (harness geçici dizini); gerçek kullanıcı dizinine ASLA bağlanmaz.
const ROOT = resolve(import.meta.dirname, "..", "..");
const ENTRY = join(ROOT, "test", "support", "approver-run-entry.mjs");
const FAKE_CLI = join(ROOT, "test", "support", "fake-vlad-cli.mjs");
const SHIM = join(ROOT, "test", "support", "no-secret-shim.mjs");
let w: World;
let procs: Entry[] = [];
beforeEach(async () => { w = await makeWorld(); });
afterEach(async () => { for (const p of procs) await p.kill(); procs = []; await w.dispose(); });

interface Entry { proc: ChildProcess; pid: number; out(): string; err(): string; exited: Promise<number | null>; code(): number | null | undefined; kill(): Promise<void> }
let n = 0;
function startEntry(mode: "fake" | "real", record?: string): Entry {
  const cfgPath = join(w.root, `entry-${++n}.json`);
  writeFileSync(cfgPath, JSON.stringify({ server: w.cfg.server, requestTopic: w.cfg.requestTopic, mode, record, fakeCli: FAKE_CLI, shim: SHIM }));
  const proc = spawn(process.execPath, [ENTRY, cfgPath], {
    cwd: w.vladHome, stdio: ["ignore", "pipe", "pipe"],
    env: isolatedEnv({ VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret, LEAK_CANARY: "1" }),
  });
  let out = "", err = "", code: number | null | undefined;
  proc.stdout!.on("data", (d) => { out += d; }); proc.stderr!.on("data", (d) => { err += d; });
  const exited = new Promise<number | null>((r) => proc.on("close", (c) => { code = c; r(c); }));
  const e: Entry = {
    proc, pid: proc.pid!, out: () => out, err: () => err, exited, code: () => code,
    async kill() { if (code === undefined) { proc.kill("SIGTERM"); await Promise.race([exited, sleep(3000)]); if (code === undefined) { proc.kill("SIGKILL"); await exited; } } },
  };
  procs.push(e);
  return e;
}
const records = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; envKeys: string[]; home: string; vladHome: string; tokenShape: string | null; cwd: string }) : []);

describe("approver-kabul: KK8 gelen port yok, gerçek secretDir'e erişim yok", () => {
  it("servis akışa bağlanınca dinleyen TCP soketi yok (lsof); gizli dizin test dizinidir, kullanıcının gerçek dizini değil", async () => {
    if (process.platform !== "darwin") return; // plan: yalnız darwin dışında koşullu skip; lsof yoksa/izin yoksa aşağıda HATA
    const e = startEntry("fake", join(w.root, "rec.jsonl"));
    await waitFor(() => e.out().includes('"started"'), "başlatıcı", 10_000);
    const started = JSON.parse(e.out().split("\n")[0]!) as { secretDir: string };
    expect(started.secretDir).toBe(w.secret);
    expect(started.secretDir).not.toBe(join(userInfo().homedir, ".vlad-secret"));
    expect(started.secretDir.startsWith(w.root)).toBe(true);
    const rid = writeRequest(w, { argv: ["mode", "off"] });
    await waitAck(w, rid, 10_000);
    await waitFor(() => w.ntfy.connections.length > 0, "yanıt akışı bağlantısı (istek sonrası)", 10_000);
    const r = spawnSync("lsof", ["-nP", "-a", "-p", String(e.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 10_000 });
    if (r.error) throw new Error(`lsof çalıştırılamadı (atlanmaz, HATA): ${r.error.message}`);
    expect(r.stdout.trim(), "dinleyen soket olmamalı").toBe("");
    expect(r.status).toBe(1); // lsof: eşleşme yok
    const established = spawnSync("lsof", ["-nP", "-a", "-p", String(e.pid), "-iTCP"], { encoding: "utf8", timeout: 10_000 });
    expect(established.stdout).toContain(String(new URL(w.cfg.server).port)); // yalnız giden bağlantı: sahte ntfy portuna
  }, 30_000);
});

describe("approver-kabul: servis tekliği ve yürütme env'i", () => {
  it("aynı dizinde iki servis: toplam çalıştırma 1; ikinci süreç çıkarsa 75", async () => {
    const rec = join(w.root, "rec.jsonl");
    const a = startEntry("fake", rec);
    await waitFor(() => procs.every((q) => q.out().includes('"started"')), "servis başladı", 10_000);
    const b = startEntry("fake", rec);
    await Promise.race([b.exited, sleep(2500)]);
    if (b.code() !== undefined) expect(b.code(), b.err()).toBe(75);
    const { pending, msg } = await submit(w, ["mode", "off"]);
    await w.ntfy.press(msg!, "Onayla");
    await resultOf(w, pending!.id);
    await w.ntfy.press(msg!, "Onayla");
    await sleep(500);
    expect(records(rec)).toHaveLength(1);
    expect(a.code()).toBeUndefined(); // birinci servis ayakta
  }, 40_000);

  it("yürütme alt sürecinin env'i izin listesiyle sınırlı: PATH, HOME(passwd), VLAD_HOME, LANG, VLAD_MODE_TOKEN(VMT2); USERPROFILE/NODE_OPTIONS/VLAD_TASK_ID/canary yok", async () => {
    const rec = join(w.root, "rec.jsonl");
    startEntry("fake", rec);
    await waitFor(() => procs.every((q) => q.out().includes('"started"')), "servis başladı", 10_000);
    const argv = ["mode", "night", "--until", "23:00", "--note", "çocuk"];
    const { pending, msg } = await submit(w, argv);
    await w.ntfy.press(msg!, "Onayla");
    const res = await resultOf(w, pending!.id);
    expect(res.status).toBe("done");
    const [r] = records(rec);
    expect(r!.argv).toEqual(argv);
    expect(r!.tokenShape).toBe("VMT2");
    // Windows: işletim sistemi çocuk sürece sistem değişkenlerini kendisi ekler (SYSTEMROOT, USERPROFILE, TEMP…); bunlar servis env'inden sızmış sayılmaz (POSIX'te boş küme beklenir).
    const osInjected = process.platform === "win32" ? /^(HOMEDRIVE|HOMEPATH|LOGONSERVER|SYSTEMDRIVE|SYSTEMROOT|TEMP|TMP|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|USERNAME|USERPROFILE|WINDIR|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|COMPUTERNAME|APPDATA|LOCALAPPDATA|ALLUSERSPROFILE|PUBLIC|DRIVERDATA|SESSIONNAME)$/i : /^$/;
    const extra = r!.envKeys.filter((k) => !(ALLOWED_EXEC_ENV as readonly string[]).includes(k) && k !== "FAKE_RECORD" && !k.startsWith("__") && !osInjected.test(k));
    expect(extra, "izin listesi dışı env").toEqual([]);
    for (const bad of [...(process.platform === "win32" ? [] : ["USERPROFILE"]), "NODE_OPTIONS", "VLAD_TASK_ID", "LEAK_CANARY", "VLAD_TEST_SECRET_DIR"]) expect(r!.envKeys).not.toContain(bad);
    expect(r!.home).toBe(userInfo().homedir); // HOME passwd'dan, süreç env'inden değil
    expect(r!.home).not.toBe(process.env.HOME === homedir() ? "" : process.env.HOME);
    expect(r!.vladHome).toBe(w.vladHome);
  }, 40_000);
});

describe("approver-kabul: gerçek servis + gerçek `dist/cli.js` + gerçek VMT2 (uçtan uca)", () => {
  it("onay → `mode night` gerçekten uygulanır (VLAD_HOME test dizininde); torun gizli dizin olarak test dizinini görür; sonuçta token yok", async () => {
    startEntry("real");
    await waitFor(() => procs.every((q) => q.out().includes('"started"')), "servis başladı", 10_000);
    const { pending, msg } = await submit(w, ["mode", "night", "--until", "23:59"]);
    await w.ntfy.press(msg!, "Onayla");
    const res = await resultOf(w, pending!.id, 20_000);
    expect(res, JSON.stringify(res)).toMatchObject({ status: "done", exitCode: 0 });
    expect(JSON.stringify(res)).not.toMatch(/VMT[12]\./);
    const st = spawnVlad({ args: ["mode", "status"], cwd: w.vladHome, env: { VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret } });
    expect(st.stdout).toMatch(/gece modu etkin/);
    // aynı onay ikinci kez: işlem tekrarlanmaz
    await w.ntfy.press(msg!, "Onayla");
    await sleep(500);
    const used = readdirUsed();
    expect(used).toBe(1);
  }, 60_000);

  it("onay verilmezse (Reddet) mod değişmez", async () => {
    startEntry("real");
    await waitFor(() => procs.every((q) => q.out().includes('"started"')), "servis başladı", 10_000);
    const { pending, msg } = await submit(w, ["mode", "night", "--until", "23:59"]);
    await w.ntfy.press(msg!, "Reddet");
    expect((await resultOf(w, pending!.id)).status).toBe("denied");
    const st = spawnVlad({ args: ["mode", "status"], cwd: w.vladHome, env: { VLAD_HOME: w.vladHome, VLAD_TEST_SECRET_DIR: w.secret } });
    expect(st.stdout).not.toMatch(/gece modu etkin/);
    expect(readdirUsed()).toBe(0);
  }, 40_000);

  it("servis ölürken (SIGTERM) çocuk süreç grubu kalmaz ve ack verilmemiş istek işlenmez; yeniden başlatma yeni istek alır", async () => {
    const e = startEntry("fake", join(w.root, "rec.jsonl"));
    await waitFor(() => procs.every((q) => q.out().includes('"started"')), "servis başladı", 10_000);
    await e.kill();
    expect(e.code()).toBeDefined();
    const cid = writeRequest(w, { argv: ["mode", "off"] });
    await sleep(500);
    expect(existsSync(join(w.dir, "ack", `${cid}.json`))).toBe(false); // servis yok ⇒ ack yok
    startEntry("fake", join(w.root, "rec.jsonl"));
    expect((await waitAck(w, cid, 10_000)).status).toBe("pending");
  }, 40_000);
});

function readdirUsed(): number {
  const d = join(w.secret, "used");
  return existsSync(d) ? require("node:fs").readdirSync(d).length : 0;
}
