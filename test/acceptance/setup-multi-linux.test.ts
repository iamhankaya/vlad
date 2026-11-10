// Kabul (T20261110-04; spec T20261110-02): S8 çok makine + çift anahtar, S9 Linux. İki ayrı sandbox (beyin Mac, işçi Windows simülasyonu).
// Varsayımlar (uygulama 4d netleştirir): `setup --add-worker <ad> --answers` beyinde makineyi config'e ekler ve anahtarı üretir (yazdırmaz);
// anahtar işçiye `vlad agent keygen <ad> --show` çıktısıyla, `--join` stdin'inden geçer.
// Uygulama (T20261110-05) gelene dek KIRMIZI olması beklenir.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_RE, makeSandbox, s1Answers } from "../support/setup-sandbox.js";

const local = (sb: { vladHome: string }) => JSON.parse(readFileSync(join(sb.vladHome, "vlad.local.json"), "utf8"));
const posix = process.platform !== "win32";

describe("S8: beyin Mac + işçi Windows, çift anahtar", () => {
  const brain = makeSandbox({ platform: "darwin" });
  const worker = makeSandbox({ platform: "win32" });
  const outs: string[] = [];
  const keep = (r: { out: string; err: string }) => { outs.push(r.out, r.err); return r; };

  it("beyin kurulumu (çok makine, kendi anahtarı üretilir)", () => {
    const a = s1Answers(brain, { machines: "multi", machine: { name: "mac", agent: { host: "192.168.1.35", port: 7437 } }, keys: "generate", confirm: ["keygen"] });
    const r = keep(brain.run(["setup", "--yes", "--answers", brain.answers(a)]));
    expect(r.code, r.err + r.out).toBe(0);
  });
  it("beyinde --add-worker windows: makine eklenir, anahtar basılmaz", () => {
    const a = { machine: { name: "windows", agent: { host: "192.168.1.34", port: 7437 } }, keys: "generate", confirm: ["keygen"] };
    const r = keep(brain.run(["setup", "--add-worker", "windows", "--yes", "--answers", brain.answers(a)]));
    expect(r.code, r.err + r.out).toBe(0);
    expect(local(brain).keys).toHaveProperty("windows");
  });
  let key = "";
  it("`agent keygen windows --show` anahtarı yalnız o çıktıda basar", () => {
    const r = brain.run(["agent", "keygen", "windows", "--show"]);
    expect(r.code, r.err).toBe(0);
    key = (SECRET_RE.exec(r.out) ?? [""])[0];
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
  it("işçide --join mac: anahtar stdin'den; yalnız beyinle paylaşılan anahtar tutulur, self=windows", () => {
    const a = { role: "worker", machines: "multi", machine: { name: "windows", agent: { host: "192.168.1.34", port: 7437 } }, keys: "stdin", kb: { mode: "path", dir: worker.kbDir }, roots: [join(worker.root, "dev")] };
    const r = keep(worker.run(["setup", "--join", "mac", "--yes", "--answers", worker.answers(a)], { input: key + "\n" }));
    expect(r.code, r.err + r.out).toBe(0);
    const l = local(worker);
    expect(l.self).toBe("windows");
    expect(Object.keys(l.keys)).toEqual(["mac"]);
    expect(l.keys.mac).toBe(key);
    expect(local(brain).keys.windows).toBe(key);
  });
  it.skipIf(!posix)("iki vlad.local.json de 0600", () => {
    for (const sb of [brain, worker]) expect(statSync(join(sb.vladHome, "vlad.local.json")).mode & 0o777, sb.root).toBe(0o600);
  });
  it("kurulum çıktılarında 64-hex anahtar yok (--show hariç)", () => {
    expect(outs.filter((o) => SECRET_RE.test(o))).toEqual([]);
    for (const sb of [brain, worker]) {
      expect(SECRET_RE.test(sb.run(["setup", "--check", "--json"]).out)).toBe(false);
      expect(sb.calls().some((c) => SECRET_RE.test(c)), "sahte araç argv'sinde anahtar").toBe(false);
    }
  });
  it("vlad machine list beyini [brain] işaretler", () => {
    const r = brain.run(["machine", "list"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/mac.*\[brain\]|\[brain\].*mac/);
  });
  it("agent.host genel adres (8.8.8.8) reddedilir; hiçbir şey yazılmaz", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const a = s1Answers(sb, { machines: "multi", machine: { name: "mac", agent: { host: "8.8.8.8", port: 7437 } } });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(a)]);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toMatch(/genel adres|özel/i);
    expect(existsSync(join(sb.vladHome, "vlad.config.local.json"))).toBe(false);
  });
});

describe("S9: Linux", () => {
  it("role=brain: 'desteklenmiyor', çıkış 1; bayrak yok (kullanıcı kararı 2026-11-10: Linux'ta beyin hiçbir bayrakla kurulmaz)", () => {
    const sb = makeSandbox({ platform: "linux" });
    const a = sb.answers(s1Answers(sb));
    const r = sb.run(["setup", "--yes", "--answers", a]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toMatch(/desteklenmiyor/);
    expect(existsSync(join(sb.vladHome, "vlad.config.local.json"))).toBe(false);
    const flag = sb.run(["setup", "--yes", "--allow-unsupported", "--answers", a]);
    expect(flag.code).not.toBe(0); // --allow-unsupported kaldırıldı
    expect(existsSync(join(sb.vladHome, "vlad.config.local.json"))).toBe(false);
  });
  it("role=worker: Agent oto-başlatma kurulmaz; --check yeşil ama 'deneysel' satırı", () => {
    const sb = makeSandbox({ platform: "linux" });
    const a = { role: "worker", machines: "multi", machine: { name: "linux-1", agent: { host: "192.168.1.50", port: 7437 } }, keys: "generate", confirm: ["keygen"], kb: { mode: "path", dir: sb.kbDir }, roots: [join(sb.root, "dev")], agentboot: true };
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(a)]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(sb.calls().filter((c) => /^(systemctl|launchctl|schtasks) /.test(c))).toEqual([]);
    const c = sb.run(["setup", "--check", "--json"]);
    expect(c.code, c.err + c.out).toBe(0);
    const j = JSON.parse(c.out);
    expect(j.platform).toBe("linux");
    expect(j.experimental?.length).toBeGreaterThan(0);
    expect(j.parts.find((p: any) => p.part === "mac-main").status).toBe("n/a");
    expect(j.parts.find((p: any) => p.part === "agent").status).toBe("n/a");
  });
});
