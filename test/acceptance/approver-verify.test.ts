import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkerMode, MODE_GUARD_TOOLS } from "../../src/hooks/mode-guard.js";
import { mintToken } from "../../src/mode/token.js";
import { validateRequest } from "../../src/approver/request.js";
import type { ServiceInstaller } from "../../src/approver/launchd.js";
import { makeCid, makeWorld, runVlad } from "./approver-harness.js";
import type { World } from "./approver-harness.js";
import { IS_WIN } from "../support/platform.js";

// approver-doğrulama (T20261116-07): doğrulama fazında hata avıyla bulunan gerçek hatalar. Kırmızı testler KASITLIDIR (düzeltme Developer görevi).
// Yalnız geçici dizin/sahte launchctl/saf fonksiyon kullanır; gerçek ~/.vlad-secret, ~/.claude ya da canlı ntfy'ye dokunulmaz.
let w: World;
const cwd0 = process.cwd();
beforeEach(async () => { w = await makeWorld(); process.chdir(w.vladHome); });
afterEach(async () => { process.chdir(cwd0); await w.dispose(); });

describe("approver-doğrulama V1: çalışan, dosya OKUMA araçlarıyla anahtara/spool'a erişemez", () => {
  // Hook yorumu: "okuma bağlamı dahil: anahtarı sızdırmak da yetki sayılır". Bash `cat` engelli ama Read aracı serbest ⇒ tutarsız.
  // saf hook fonksiyonu: yalnız dize denetler, dosyaya dokunmaz (üretim yolu `~/.vlad-secret`, hook onu adından tanır)
  const SD = "~/.vlad-secret";
  const targets = () => [`${SD}/mode.key`, `${SD}/approver/channel.json`, `${SD}/approver/pending.json`];
  it("kontrol (yeşil): Bash `cat` ve Write/Edit gizli dizinde reddedilir", () => {
    for (const f of targets()) {
      expect(checkWorkerMode("Bash", { command: `cat ${f}` }, null, { vladHome: w.vladHome }), `Bash cat ${f}`).not.toBeNull();
      expect(checkWorkerMode("Write", { file_path: f }, null, { vladHome: w.vladHome }), `Write ${f}`).not.toBeNull();
    }
  });
  it.each([["mode.key"], ["approver/channel.json"], ["approver/pending.json"]])("Read aracı `%s` okuyamamalı (hook reddeder)", (rel) => {
    const f = `${SD}/${rel}`;
    expect(MODE_GUARD_TOOLS, "Read korunan araç listesinde").toContain("Read");
    expect(checkWorkerMode("Read", { file_path: f }, null, { vladHome: w.vladHome }), `Read ${f}`).not.toBeNull();
  });
});

describe("approver-doğrulama V2: görünmez Unicode, isteğin kontrol-karakter denetiminden geçmemeli", () => {
  const night = (note: string) => validateRequest({ v: 1, cid: makeCid(), op: "mode night", argv: ["mode", "night", "--note", note], requestedAt: new Date().toISOString(), requester: "vlad" });
  it("kontrol (yeşil): bidi RLO ve sıfır genişlik boşluk reddedilir", () => {
    for (const ch of ["‮", "​"]) expect(night(`a${ch}b`).ok, JSON.stringify(ch)).toBe(false);
  });
  // U+061C ARABIC LETTER MARK (bidi), U+E0041 TAG LATIN CAPITAL A (görünmez metin), U+00AD yumuşak tire, U+FE0F varyasyon seçici, U+3164 Hangul dolgu (boş görünür), U+FFF9 satır içi not
  it.each([["؜", "ALM (bidi)"], ["\u{e0041}", "tag karakteri"], ["­", "yumuşak tire"], ["️", "varyasyon seçici"], ["ㅤ", "Hangul dolgu"], ["￹", "satır içi not"]])("%s (%s) `--note` içinde reddedilmeli", (ch) => {
    expect(night(`gece${ch}işi`).ok).toBe(false);
  });
});

describe("approver-doğrulama V3: belgedeki 'üst dizin grup yazılabilirse kurulum reddedilir' sözü", () => {
  // Windows'ta atlanır: grup yazılabilir mod biti (chmod 0775) POSIX'e özgü
  it.skipIf(IS_WIN)("gizli dizinin üst dizini 0775 iken `approver install` reddedilir ve launchctl çağrılmaz", async () => {
    chmodSync(w.root, 0o775); // gizli dizin w.root/secret: üst dizin = w.root (geçici, bize ait)
    const calls: string[] = [];
    const installer: ServiceInstaller = { install: async () => { calls.push("install"); return ["fake"]; }, uninstall: async () => [], status: async () => ({ installed: false, running: false, detail: "" }) };
    const printed: string[] = [];
    const r = await runVlad(["approver", "install", "--json"], {
      env: { VLAD_MODE_TOKEN: mintToken(3_600_000) },
      approverDeps: { isTTY: () => true, stdout: { isTTY: true, write: (s) => printed.push(s) }, installer },
    });
    expect(calls, `install çağrıldı (çıkış ${r.code}): ${r.out}${r.err}`).toEqual([]);
    expect(r.code).not.toBe(0);
  });
});
