import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { createStateStore } from "../../src/monitor/state.js";
import { createKeychainReader } from "../../src/monitor/secret.js";
import { buildAlertTask, buildResolvedNote } from "../../src/monitor/task-text.js";
import { loadMonitorConfig } from "../../src/monitor/config.js";
import { MONITOR_LABEL, CAPACITY_LABEL, capacityPlist, createMonitorInstaller, monitorPlist } from "../../src/monitor/launchd.js";
import { EMPTY_STATE, MONITOR_LIMITS } from "../../src/monitor/types.js";
import { parseAlertsResponse } from "../../src/monitor/contract.js";
import { IS_WIN } from "../support/platform.js";

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "spc", n), "utf8"));
const critical = () => parseAlertsResponse(fx("alerts-critical-firing.json"), "medialog").items[0]!;

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "vlad-mon-u-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("state store", () => {
  // Windows'ta atlanır: 0700/0600 mod bitleri POSIX'e özgü
  it.skipIf(IS_WIN)("dosya yoksa boş durum; yazma 0700 dizin + 0600 dosya, atomik (tmp kalmaz); gidiş-dönüş", () => {
    const dir = join(tmp, "m");
    const s = createStateStore(dir);
    expect(s.load()).toEqual(EMPTY_STATE);
    s.save({ v: 1, servers: { a: { epoch: "e", cursor: "c", last_ok: 1, fail_streak: 0, tasks: {} } } });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "state.json")).mode & 0o777).toBe(0o600);
    expect(s.load().servers.a!.cursor).toBe("c");
    expect(require("node:fs").readdirSync(dir)).toEqual(["state.json"]);
  });
  it("bozuk JSON ve yanlış sürüm sessizce sıfırlanmaz, açık hata", () => {
    const dir = join(tmp, "m2");
    const s = createStateStore(dir);
    s.save(EMPTY_STATE);
    writeFileSync(join(dir, "state.json"), "{bozuk");
    expect(() => s.load()).toThrow(/bozuk/);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 2, servers: {} }));
    expect(() => s.load()).toThrow(/geçersiz sürüm/);
  });
});

describe("Keychain okuyucu", () => {
  it("execFile argümanları: security find-generic-password -a $USER -s <hizmet> -w; sonundaki satır sonu atılır", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const r = createKeychainReader(async (file, args) => { calls.push({ file, args }); return { code: 0, stdout: "tok123\n" }; });
    expect(await r.read("spc_token_medialog")).toBe("tok123");
    expect(calls[0]!.file).toBe("security");
    expect(calls[0]!.args).toEqual(["find-generic-password", "-a", process.env.USER || require("node:os").userInfo().username, "-s", "spc_token_medialog", "-w"]);
    expect(calls[0]!.args.join(" ")).not.toContain("tok123");
  });
  it("yalnız çıkış 44 (kayıt yok) null; diğer kodlar 'Keychain okunamadı (kod N)' hatası", async () => {
    for (const code of [1, 36, 51, 128]) {
      await expect(createKeychainReader(async () => ({ code, stdout: "sir-degil" })).read("x")).rejects.toThrow(new RegExp("Keychain okunamadı \\(kod " + code + "\\)"));
    }
  });
  it("kayıt yok (çıkış 44) ya da boş değer → null", async () => {
    expect(await createKeychainReader(async () => ({ code: 44, stdout: "" })).read("x")).toBeNull();
    expect(await createKeychainReader(async () => ({ code: 0, stdout: "\n" })).read("x")).toBeNull();
  });
});

describe("görev metni", () => {
  it("başlık [spc] <server>: <başlık>; kontrol karakterleri temiz; 120 karaktere kısalır", () => {
    const a = { ...critical(), title: "a\u0007b\nc " + "x".repeat(300) };
    const t = buildAlertTask("medialog", a);
    expect(t.title).toMatch(/^\[spc\] medialog: a b c x+…$/);
    expect(t.title.length).toBeLessThanOrEqual(MONITOR_LIMITS.titleMax);
    expect(t.title).not.toMatch(/[\u0000-\u001f]/);
  });
  it("gövde: koşul, ISO başlangıç, işaret satırı tek başına, Kabul kriterleri; ajan metni tırnaklı", () => {
    const a = critical();
    const d = buildAlertTask("medialog", a).description;
    expect(d).toContain("97.5 > 90");
    expect(d).toContain(new Date(a.fired_at).toISOString());
    expect(d.split("\n")).toContain(`spc-alert: medialog/${a.alert_id}`);
    expect(d).toContain("## Kabul kriterleri");
    expect(d).toContain(`- Başlık: ${JSON.stringify(a.title)}`);
  });
  it("geçersiz tarih alanı fırlatmaz (iso korumalı)", () => {
    const a = { ...critical(), fired_at: 9e15 };
    expect(() => buildAlertTask("medialog", a)).not.toThrow();
    expect(() => buildResolvedNote({ ...critical(), state: "resolved" as const, resolved_at: 9e15, resolve_reason: "condition_cleared" as const })).not.toThrow();
  });
  it("resolved notu tek satır: alert_id, neden, ISO, süre", () => {
    const a = { ...critical(), state: "resolved" as const, resolved_at: critical().fired_at + 5 * 60_000, resolve_reason: "condition_cleared" as const };
    const n = buildResolvedNote(a);
    expect(n).toBe(`spc: ${a.alert_id} çözüldü (condition_cleared) ${new Date(a.resolved_at).toISOString()}, 5 dk`);
    expect(n).not.toContain("\n");
  });
});

describe("loadMonitorConfig", () => {
  const withCfg = (monitor: unknown, cards: string[]) => {
    const home = makeHome();
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ monitor }));
    for (const c of cards) writeFileSync(join(home, "kb", "projects", `${c}.md`), "---\nslug: " + c + "\n---\n");
    return home;
  };
  it("bölüm yoksa boş sunucu listesi", () => {
    expect(loadMonitorConfig(makeHome())).toEqual({ servers: [] });
  });
  it("geçerli yapılandırma okunur", () => {
    const home = withCfg({ servers: [{ id: "medialog", agent_url: "https://x.example", project: "medialog" }] }, ["medialog"]);
    expect(loadMonitorConfig(home).servers).toEqual([{ id: "medialog", agent_url: "https://x.example", project: "medialog" }]);
  });
  it("kartı olmayan proje → config hatası (varsayılan projeye düşülmez)", () => {
    const home = withCfg({ servers: [{ id: "m", agent_url: "https://x.example", project: "yok" }] }, []);
    expect(() => loadMonitorConfig(home)).toThrow(/proje kartı yok: yok/);
  });
  it("yinelenen kimlik → config hatası", () => {
    const s = { id: "m", agent_url: "https://x.example", project: "p" };
    const home = withCfg({ servers: [s, s] }, ["p"]);
    expect(() => loadMonitorConfig(home)).toThrow(/yinelenen/);
  });
  describe("agent_url doğrulaması", () => {
    const load = (agent_url: string) => loadMonitorConfig(withCfg({ servers: [{ id: "m", agent_url, project: "p" }] }, ["p"]));
    it("https ve özel/loopback http kabul; kök yol ya da boş yol", () => {
      for (const u of ["https://spc.example.com", "https://spc.example.com/", "http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "http://10.1.2.3", "http://172.16.0.9", "http://192.168.1.5:80", "http://100.64.1.2:8787", "http://box.local", "http://box.tailnet.ts.net"]) {
        expect(() => load(u), u).not.toThrow();
      }
    });
    it("kimlik bilgisi, sorgu, parça, ek yol → config hatası", () => {
      for (const u of ["https://user:pw@spc.example.com", "https://user@spc.example.com", "https://spc.example.com/?x=1", "https://spc.example.com/#f", "https://spc.example.com/api", "https://spc.example.com/spc/v1"]) {
        expect(() => load(u), u).toThrow(/agent_url/);
      }
    });
    it("genel adrese düz http → config hatası (belirteç açık metin gitmez)", () => {
      for (const u of ["http://spc.example.com", "http://8.8.8.8", "http://172.32.0.1", "http://100.128.0.1", "http://192.169.0.1"]) {
        expect(() => load(u), u).toThrow(/http/);
      }
    });
    it("ayrıştırılamayan adres → config hatası; ileti kimlik bilgisi içermez", () => {
      expect(() => load("http://")).toThrow(/agent_url/);
      let msg = "";
      try { load("https://user:gizli-parola@spc.example.com"); } catch (e) { msg = (e as Error).message; }
      expect(msg).toMatch(/agent_url/);
      expect(msg).not.toContain("gizli-parola");
    });
  });
  it("şemaya aykırı (sır alanı) → config hatası", () => {
    const home = withCfg({ servers: [{ id: "m", agent_url: "https://x.example", project: "p", token: "s" }] }, ["p"]);
    expect(() => loadMonitorConfig(home)).toThrow();
  });
});

describe("launchd", () => {
  const c = { node: "/usr/bin/node", cli: "/x/cli.js", home: "/v", path: "/usr/bin" };
  it("plist: com.vlad.monitor, StartInterval 300, RunAtLoad, KeepAlive/AbandonProcessGroup yok, argümanlar, ortamda yalnız PATH+VLAD_HOME", () => {
    const p = monitorPlist(c, "/l/launchd.log");
    expect(p).toContain(`<key>Label</key><string>${MONITOR_LABEL}</string>`);
    expect(MONITOR_LABEL).toBe("com.vlad.monitor");
    expect(p).toContain("<key>StartInterval</key><integer>300</integer>");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).not.toMatch(/KeepAlive|AbandonProcessGroup/);
    expect(p).toContain("<string>monitor</string><string>pull</string>");
    expect(p.match(/<key>(\w+)<\/key><string>[^<]*<\/string><\/dict>|<key>EnvironmentVariables<\/key>/g)).toBeTruthy();
    const env = /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(p)![1]!;
    expect([...env.matchAll(/<key>(\w+)<\/key>/g)].map((m) => m[1])).toEqual(["PATH", "VLAD_HOME"]);
    expect(p).toContain("/l/launchd.log");
  });
  it("kapasite plist'i: com.vlad.monitor-capacity, pazartesi 09:00 takvim aralığı, RunAtLoad/KeepAlive yok, [node, cli, monitor, capacity], günlük capacity.log", () => {
    const p = capacityPlist(c, "/l/capacity.log");
    expect(p).toContain(`<key>Label</key><string>${CAPACITY_LABEL}</string>`);
    expect(CAPACITY_LABEL).toBe("com.vlad.monitor-capacity");
    expect(p).toContain("<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>");
    expect(p).not.toMatch(/RunAtLoad|KeepAlive|StartInterval|AbandonProcessGroup/);
    expect(p).toContain("<string>monitor</string><string>capacity</string>");
    const env = /<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s.exec(p)![1]!;
    expect([...env.matchAll(/<key>(\w+)<\/key>/g)].map((m) => m[1])).toEqual(["PATH", "VLAD_HOME"]);
    expect(p).toContain("/l/capacity.log");
  });
  const fakeLc = (fail?: string) => {
    const calls: string[][] = [];
    return { calls, lc: async (args: string[]) => { calls.push(args); return fail && args[0] === fail ? { code: 5, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" }; } };
  };
  // Windows'ta atlanır: 0600 mod biti POSIX'e özgü (launchd yalnız macOS)
  it.skipIf(IS_WIN)("install: plist 0600 yazılır, bootout sonra bootstrap gui/<uid>; tekrar install idempotent; günlük 0600", async () => {
    const { calls, lc } = fakeLc();
    const inst = createMonitorInstaller(lc, { plistDir: join(tmp, "LA"), stateDir: join(tmp, "st") });
    await inst.install(c);
    await inst.install(c);
    const plist = join(tmp, "LA", `${MONITOR_LABEL}.plist`);
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, "st", "launchd.log")).mode & 0o777).toBe(0o600);
    const uid = process.getuid?.() ?? 501;
    const capPlist = join(tmp, "LA", `${CAPACITY_LABEL}.plist`);
    expect(statSync(capPlist).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, "st", "capacity.log")).mode & 0o777).toBe(0o600);
    expect(calls.filter((a) => a[0] === "bootstrap")).toEqual([["bootstrap", `gui/${uid}`, plist], ["bootstrap", `gui/${uid}`, capPlist], ["bootstrap", `gui/${uid}`, plist], ["bootstrap", `gui/${uid}`, capPlist]]);
    expect(calls[0]).toEqual(["bootout", `gui/${uid}/${MONITOR_LABEL}`]);
  });
  // Windows'ta atlanır: 0600 mod biti POSIX'e özgü (launchd yalnız macOS)
  it.skipIf(IS_WIN)("test kancası nesne biçimi: { launchctl, homeDir } gerçek ~/Library ve ~/.vlad-monitor'a dokunmadan kurar", async () => {
    const { calls, lc } = fakeLc();
    const inst = createMonitorInstaller({ launchctl: lc, homeDir: tmp });
    await inst.install(c);
    expect(existsSync(join(tmp, "Library", "LaunchAgents", `${MONITOR_LABEL}.plist`))).toBe(true);
    expect(statSync(join(tmp, ".vlad-monitor", "launchd.log")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(tmp, "Library", "LaunchAgents", `${MONITOR_LABEL}.plist`), "utf8")).toContain(join(tmp, ".vlad-monitor", "launchd.log"));
    expect(calls.some((a) => a[0] === "bootstrap")).toBe(true);
    expect(await inst.status()).toMatchObject({ installed: true });
  });
  it("bootstrap başarısızsa plist geri alınır ve hata verilir", async () => {
    const { lc } = fakeLc("bootstrap");
    const inst = createMonitorInstaller(lc, { plistDir: join(tmp, "LA"), stateDir: join(tmp, "st") });
    await expect(inst.install(c)).rejects.toThrow(/bootstrap başarısız/);
    expect(existsSync(join(tmp, "LA", `${MONITOR_LABEL}.plist`))).toBe(false);
  });
  it("uninstall: bootout + plist silinir; bootout 'yüklü değil' (3) başarıdır; gerçek hata dosyaları silmez", async () => {
    const ok = fakeLc();
    const inst = createMonitorInstaller(ok.lc, { plistDir: join(tmp, "LA"), stateDir: join(tmp, "st") });
    await inst.install(c);
    await inst.uninstall();
    expect(existsSync(join(tmp, "LA", `${MONITOR_LABEL}.plist`))).toBe(false);
    const bad = fakeLc("bootout");
    const i2 = createMonitorInstaller(ok.lc, { plistDir: join(tmp, "LA2"), stateDir: join(tmp, "st") });
    await i2.install(c);
    const i3 = createMonitorInstaller(bad.lc, { plistDir: join(tmp, "LA2"), stateDir: join(tmp, "st") });
    await expect(i3.uninstall()).rejects.toThrow(/bootout başarısız/);
    expect(existsSync(join(tmp, "LA2", `${MONITOR_LABEL}.plist`))).toBe(true);
  });
  it("uninstall iki işi de boot-out eder ve iki plist'i siler; status kapasite işini de bildirir", async () => {
    const { calls, lc } = fakeLc();
    const inst = createMonitorInstaller(lc, { plistDir: join(tmp, "LA3"), stateDir: join(tmp, "st") });
    await inst.install(c);
    const st = await inst.status();
    expect(st.detail).toMatch(/kapasite işi yüklü/);
    calls.length = 0;
    await inst.uninstall();
    const uid = process.getuid?.() ?? 501;
    expect(calls.map((a) => a[1])).toEqual([`gui/${uid}/${MONITOR_LABEL}`, `gui/${uid}/${CAPACITY_LABEL}`]);
    expect(existsSync(join(tmp, "LA3", `${MONITOR_LABEL}.plist`))).toBe(false);
    expect(existsSync(join(tmp, "LA3", `${CAPACITY_LABEL}.plist`))).toBe(false);
  });
  it("status: plist yok → kurulu değil; var + yüklü değil → açıklama", async () => {
    const lc = async () => ({ code: 113, stdout: "", stderr: "Could not find service" });
    const inst = createMonitorInstaller(lc, { plistDir: join(tmp, "LA"), stateDir: join(tmp, "st") });
    expect(await inst.status()).toMatchObject({ installed: false, running: false });
    await createMonitorInstaller(async () => ({ code: 0, stdout: "", stderr: "" }), { plistDir: join(tmp, "LA"), stateDir: join(tmp, "st") }).install(c);
    expect(await inst.status()).toMatchObject({ installed: true, running: false });
  });
});
void chmodSync;
