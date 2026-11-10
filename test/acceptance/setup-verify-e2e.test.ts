// Doğrulama (T20261110-06): README kılavuzunu temiz sandbox'ta harfiyen izleyince bulunan hatalar.
// Her test, elle yeniden üretilen (Mac, sahte HOME) bir davranışı kanıtlar; düzeltme gelene dek KIRMIZI kalması BEKLENİR.
// Sahte araçlar + geçici dizin (makeSandbox); gerçek HOME/~/.claude'a dokunulmaz.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_RE, makeSandbox, s1Answers } from "../support/setup-sandbox.js";

const local = (sb: { vladHome: string }) => JSON.parse(readFileSync(join(sb.vladHome, "vlad.local.json"), "utf8"));

/** Beyin (Mac) + işçi (Windows simülasyonu); işçi README'deki --join akışıyla kurulur. */
function pair() {
  const brain = makeSandbox({ platform: "darwin" });
  const worker = makeSandbox({ platform: "win32" });
  const b = s1Answers(brain, { machines: "multi", machine: { name: "mac", agent: { host: "192.168.1.10", port: 7437 } }, keys: "generate", confirm: ["keygen"] });
  const rb = brain.run(["setup", "--yes", "--answers", brain.answers(b)]);
  expect(rb.code, rb.err + rb.out).toBe(0);
  const key = (SECRET_RE.exec(brain.run(["agent", "keygen", "windows", "--show"]).out) ?? [""])[0];
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  const w = { role: "worker", machines: "multi", machine: { name: "windows", agent: { host: "192.168.1.20", port: 7437 } }, keys: "stdin", kb: { mode: "path", dir: worker.kbDir }, roots: [join(worker.root, "dev")] };
  return { brain, worker, key, w };
}

describe("README kurulum doğrulaması: bulunan hatalar", () => {
  it("V1: doğru --join ile kurulan işçide `setup --check` yeşil (işçi yalnız beyin anahtarını tutar, D-vlad-057)", () => {
    const { worker, key, w } = pair();
    const r = worker.run(["setup", "--yes", "--answers", worker.answers(w), "--join", "mac", "--brain-host", "192.168.1.10", "--brain-os", "darwin"], { input: key });
    expect(r.code, r.err + r.out).toBe(0);
    expect(Object.keys(local(worker).keys)).toEqual(["mac"]); // çift anahtar: yalnız beyinle paylaşılan
    const c = worker.run(["setup", "--check", "--only", "agent", "--json"]);
    // Hata: agent parçası işçinin KENDİ adıyla anahtar arar ("windows anahtarı yok") ve kırmızı döner.
    expect(c.code, c.err + c.out).toBe(0);
  });

  it("V2: --join --only <parça> yalnız seçilen parçaları uygular (global-skills/hooks yazılmaz)", () => {
    const { worker, key, w } = pair();
    const r = worker.run(["setup", "--yes", "--answers", worker.answers(w), "--join", "mac", "--brain-host", "192.168.1.10", "--brain-os", "darwin", "--only", "kb,config,agent"], { input: key });
    expect(r.code, r.err + r.out).toBe(0);
    // Hata: --only --join'de yok sayılıyor; hook ve global skill'ler yine de yazılıyor.
    expect(r.out).not.toMatch(/SessionEnd hook ekle|skill kopyala/);
  });

  it("V3: --add-worker, tracked config'teki aynı adlı makinenin eski adresini sessizce tutmaz (verilen --host geçerli ya da hata)", () => {
    const { brain } = pair();
    const r = brain.run(["setup", "--add-worker", "windows", "--host", "192.168.1.20", "--os", "win32"]);
    const list = brain.run(["machine", "list"]).out;
    // Hata: çıkış 0, çıktı "windows zaten tanımlı", machine list sahibin 192.168.1.34'ünü gösteriyor (tracked vlad.config.json).
    const honored = /windows\s+win32\s+192\.168\.1\.20:7437/.test(list);
    expect(honored || r.code !== 0, `kod=${r.code}\n${r.out}\n${list}`).toBe(true);
  });

  it("V4: --join --brain-host, tracked config'teki sahibin beyin adresiyle sessizce ezilmez (verilen adres geçerli ya da hata)", () => {
    const { worker, key, w } = pair();
    const r = worker.run(["setup", "--yes", "--answers", worker.answers(w), "--join", "mac", "--brain-host", "192.168.1.10", "--brain-os", "darwin", "--only", "config"], { input: key });
    const list = worker.run(["machine", "list"]).out;
    // Hata: machine list beyini tracked'teki 192.168.1.35 ile gösteriyor; --brain-host yok sayıldı, uyarı yok.
    const honored = /mac\s+darwin\s+192\.168\.1\.10:7437/.test(list);
    expect(honored || r.code !== 0, `kod=${r.code}\n${r.out}\n${list}`).toBe(true);
  });
});
