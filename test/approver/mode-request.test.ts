import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestApproval, type RequestClientDeps } from "../../src/cli/groups/approver.js";
import { newId, validateRequest, type RandomSource } from "../../src/approver/request.js";
import { createStore } from "../../src/approver/store.js";
import { LIMITS, type AckRecord, type ResultRecord } from "../../src/approver/types.js";
import { writeAtomic } from "../../src/mode/secure-fs.js";
import { approverDir, setSecretDirForTests } from "../../src/mode/token.js";
import { makeHome } from "../helpers.js";
import { runCli } from "../support/run-cli.js";
import { IS_WIN } from "../support/platform.js";

const cwd0 = process.cwd();
let tmp: string;
beforeEach(() => { tmp = makeHome(); process.chdir(tmp); mkdirSync(join(tmp, "secret"), { mode: 0o700 }); setSecretDirForTests(join(tmp, "secret")); });
afterEach(() => { process.chdir(cwd0); setSecretDirForTests(null); delete process.env.VLAD_TASK_ID; });

const rnd = (seed = 7): RandomSource => ({ bytes: (n) => Buffer.alloc(n, seed) });
const CID = newId(rnd());
const ID = newId({ bytes: (n) => Buffer.alloc(n, 9) });
const EXPIRES = "2030-01-01T00:05:00.000Z";

/** channel.json yalnız varlık için (istemci içeriğini okumamalı: bilerek geçersiz). */
function install(): void { createStore(approverDir()); writeFileSync(join(approverDir(), "channel.json"), "not json"); }

/** Sahte saat + sahte servis: her uykuda inbox'ı tarar, `reply` ack yazar; `results` ile sonuç yazılır. */
function harness(reply: (cid: string) => AckRecord | null, onTick?: (t: number) => void, o: { seed?: number; pollMs?: number } = {}) {
  let t = 1_000_000, sleeps = 0;
  const deps: RequestClientDeps = {
    random: rnd(o.seed), now: () => t, pollMs: o.pollMs ?? 100,
    sleep: async (ms) => {
      t += ms; sleeps++;
      for (const f of readdirSync(join(approverDir(), "inbox"))) {
        const cid = f.slice(0, -5), a = reply(cid);
        if (a) writeAtomic(join(approverDir(), "ack", `${cid}.json`), JSON.stringify(a), { overwrite: true });
      }
      onTick?.(t);
    },
  };
  return { deps, elapsed: () => t - 1_000_000, sleeps: () => sleeps };
}
const pendingAck = (cid: string): AckRecord => ({ v: 1, cid, status: "pending", id: ID, expiresAt: EXPIRES });
const writeResult = (r: Partial<ResultRecord>) => createStore(approverDir()).writeResult({ v: 1, id: ID, status: "done", exitCode: 0, stdout: "", stderr: "", finishedAt: "2030-01-01T00:01:00.000Z", ...r });

describe("approver: mode request istemcisi", () => {
  it("çalışan oturumu reddedilir (hiçbir şey yazılmaz)", async () => {
    install();
    process.env.VLAD_TASK_ID = "T20261116-99";
    await expect(requestApproval("night", ["--until", "23:00"], {}, harness(pendingAck).deps)).rejects.toThrow("çalışan oturumu uzaktan onay isteği yazamaz");
    expect(readdirSync(join(approverDir(), "inbox"))).toEqual([]);
  });

  it("geçersiz işlem/argüman, kurulu olmama kontrolünden ÖNCE gelir", async () => {
    await expect(requestApproval("night", ["--bogus"], {}, harness(pendingAck).deps)).rejects.toThrow(/^geçersiz işlem\/argüman: /);
    await expect(requestApproval("rm", [], {}, harness(pendingAck).deps)).rejects.toThrow(/^geçersiz işlem\/argüman: /);
    await expect(requestApproval("setup", [], {}, harness(pendingAck).deps)).rejects.toThrow(/^geçersiz işlem\/argüman: /);
  });

  it("approver kurulu değil: channel.json yok; hiçbir dizin oluşturulmaz", async () => {
    await expect(requestApproval("off", [], {}, harness(pendingAck).deps)).rejects.toThrow("approver kurulu değil: önce terminalde vlad approver install");
    expect(existsSync(approverDir())).toBe(false);
  });

  it("anahtarı ve channel.json içeriğini okumaz: anahtarsız, bozuk channel.json ile de gönderir", async () => {
    install();
    const r = await requestApproval("off", [], {}, harness(pendingAck).deps);
    expect(r.exit).toBe(0);
  });

  // Windows'ta atlanır: 0600 mod biti POSIX'e özgü
  it.skipIf(IS_WIN)("başarı: inbox dosyası geçerli ve 0600, cid rastgelelik kaynağından; çıktı {id,status,expiresAt}", async () => {
    install();
    let seen: string | null = null;
    const h = harness(pendingAck, () => { seen ??= readdirSync(join(approverDir(), "inbox"))[0] ?? null; });
    const r = await requestApproval("night", ["--until", "23:00"], {}, h.deps);
    expect(r).toMatchObject({ exit: 0, data: { id: ID, status: "pending", expiresAt: EXPIRES } });
    expect(Object.keys(r.data).sort()).toEqual(["expiresAt", "id", "status"]);
    const f = join(approverDir(), "inbox", `${CID}.json`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const req = JSON.parse(readFileSync(f, "utf8"));
    expect(req).toMatchObject({ v: 1, cid: CID, op: "mode night", argv: ["mode", "night", "--until", "23:00"] });
    expect(validateRequest(req).ok).toBe(true);
    expect(Object.keys(req).sort()).toEqual(["argv", "cid", "op", "requestedAt", "requester", "v"]); // nonce/tag/konu/id yok
  });

  it("op → argv: watch, install, setup biçimleri", async () => {
    install();
    for (const [op, args, argv] of [["watch", ["on"], ["mode", "watch", "on"]], ["install", [], ["install"]], ["setup", ["--upgrade"], ["setup", "--upgrade"]]] as const) {
      let got: string[] | null = null;
      const h = harness((cid) => { got = JSON.parse(readFileSync(join(approverDir(), "inbox", `${cid}.json`), "utf8")).argv; return pendingAck(cid); });
      await requestApproval(op, [...args], {}, h.deps);
      expect(got).toEqual(argv);
      rmSync(join(approverDir(), "inbox", `${CID}.json`), { force: true });
    }
  });

  it("ack gelmezse: ackWaitMs sonra inbox dosyası silinir ve 'yanıt vermiyor'", async () => {
    install();
    const h = harness(() => null);
    await expect(requestApproval("off", [], {}, h.deps)).rejects.toThrow("approver yanıt vermiyor: servis çalışmıyor olabilir (vlad approver status)");
    expect(h.elapsed()).toBeGreaterThanOrEqual(LIMITS.ackWaitMs);
    expect(readdirSync(join(approverDir(), "inbox"))).toEqual([]);
  });

  it.each<[string, Partial<AckRecord>, string]>([
    ["key_disabled", { status: "invalid", reason: "key_disabled" }, "mod belirteci etkin değil: önce vlad mode token"],
    ["invalid", { status: "invalid", reason: "bad_flag" }, "geçersiz işlem/argüman: bad_flag"],
    ["locked", { status: "locked" }, "kilitli: 3 ret/süre dolumu"],
    ["busy", { status: "busy", id: ID }, `meşgul: bekleyen istek var (${ID.slice(0, 8)})`],
    ["rate_limited", { status: "rate_limited" }, "hız sınırı: soğuma ya da saatlik/günlük kota"],
  ])("ack %s", async (_n, ack, msg) => {
    install();
    await expect(requestApproval("off", [], {}, harness((cid) => ({ v: 1, cid, ...ack }) as AckRecord).deps)).rejects.toThrow(msg);
  });

  it("--wait: done → çıkış 0", async () => {
    install();
    const h = harness(pendingAck, (t) => { if (t > 1_000_300) writeResult({}); });
    const r = await requestApproval("off", [], { wait: true }, h.deps);
    expect(r).toMatchObject({ exit: 0, data: { id: ID, status: "done", exitCode: 0 } });
  });

  it("--wait: done dışı sonuç → çıkış 1 ve neden", async () => {
    install();
    const h = harness(pendingAck, () => { if (!createStore(approverDir()).readResult(ID)) writeResult({ status: "denied", exitCode: null, reason: "rotated" }); });
    const r = await requestApproval("off", [], { wait: true }, h.deps);
    expect(r).toMatchObject({ exit: 1, data: { status: "denied", reason: "rotated" } });
  });

  it("--wait: süre dolarsa wait_timeout, çıkış 1; istek iptal edilmez; varsayılan 310 sn, --wait-seconds ile kısalır", async () => {
    install();
    const a = harness(pendingAck, undefined, { pollMs: 1000 });
    const r1 = await requestApproval("off", [], { wait: true }, a.deps);
    expect(r1).toMatchObject({ exit: 1, data: { status: "wait_timeout", id: ID } });
    expect(a.elapsed()).toBeGreaterThanOrEqual(310_000);
    expect(a.elapsed()).toBeLessThan(312_000);
    const b = harness(pendingAck, undefined, { seed: 8, pollMs: 100 });
    const r2 = await requestApproval("off", [], { waitSeconds: "2" }, b.deps);
    expect(r2.data).toEqual({ status: "wait_timeout", id: ID });
    expect(b.elapsed()).toBeLessThan(3_000);
    expect(readdirSync(join(approverDir(), "inbox"))).toHaveLength(2); // iki istek de yerinde (iptal yok)
  });

  it("--wait-seconds geçersizse hata (istek yazılmaz)", async () => {
    install();
    await expect(requestApproval("off", [], { waitSeconds: "0" }, harness(pendingAck).deps)).rejects.toThrow("--wait-seconds");
    expect(readdirSync(join(approverDir(), "inbox"))).toEqual([]);
  });
});

describe("approver: vlad mode request (CLI)", () => {
  const vlad = (args: string[], env: Record<string, string> = {}) => runCli(["mode", "request", ...args], { env: { VLAD_HOME: tmp, ...env } });
  it("çalışan reddi, geçersiz argüman, kurulu değil: çıkış 1 ve {error} (--json)", async () => {
    const w = await vlad(["off", "--json"], { VLAD_TASK_ID: "T20261116-99" });
    expect(w.code).toBe(1);
    expect(JSON.parse(w.err).error).toBe("çalışan oturumu uzaktan onay isteği yazamaz");
    expect((await vlad(["--json", "night", "--bogus"])).err).toContain("geçersiz işlem/argüman");
    const n = await vlad(["--json", "off"]);
    expect(n.code).toBe(1);
    expect(JSON.parse(n.err).error).toContain("approver kurulu değil");
  });
  it("bayraklar işlemden önce, işlem sonrası bayraklar argv'ye gider", async () => {
    const r = await vlad(["--json", "--wait", "--wait-seconds", "1", "night", "--until", "23:00"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toContain("approver kurulu değil"); // ayrıştırma geçti, argv geçerli bulundu
  });
  // ENGEL (rapora yazıldı): kök program enablePositionalOptions() çağırmadığı için `mode request night --until 23:00` (öncesinde bayrak yok) kökte
  // "unknown option '--until'" olur. src/cli/program.ts'e `.enablePositionalOptions()` eklenince bu test başarısız olur: `it.fails` → `it` yapın.
  it("bayraksız önek: `mode request night --until 23:00` ayrıştırılır", async () => {
    const bare = await vlad(["night", "--until", "23:00"]);
    expect(bare.err).not.toContain("unknown option");
  });
});
