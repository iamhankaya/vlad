import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ShellRunner } from "../../src/clip/types.js";
import { installSendMenu, macQuickAction, winHiddenLauncher, winMenuRegCommands, type MenuCtx } from "../../src/menu/index.js";
import { rmTemp } from "../helpers.js";

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmTemp(t); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-cmenu-")); temps.push(d); return d; };

const W = { node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\dev\\vlad\\dist\\cli.js", home: "C:\\dev\\vlad", peer: "mac" };
const M = { node: "/opt/homebrew/bin/node", cli: "/Users/me/dev/vlad/dist/cli.js", home: "/Users/me/dev/vlad", peer: "windows" };
const golden = (name: string, actual: string | Buffer) => {
  const f = join(import.meta.dirname, "golden", name);
  if (process.env.VLAD_GOLDEN_UPDATE === "menu") { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, actual); }
  expect(Buffer.from(actual).equals(readFileSync(f))).toBe(true);
};

describe("aktarim:C1 Windows kayıt + gizli başlatıcı", () => {
  it("reg argv: HKCU, dosya (*) ve klasör (Directory), komut wscript + vbs + %1", () => {
    const cmds = winMenuRegCommands(W);
    expect(cmds.every((c) => c.file === "reg.exe" && c.args[0] === "add" && c.args.at(-1) === "/f")).toBe(true);
    const keys = cmds.map((c) => c.args[1]);
    expect(keys).toEqual([
      "HKCU\\Software\\Classes\\*\\shell\\VladSend", "HKCU\\Software\\Classes\\*\\shell\\VladSend\\command",
      "HKCU\\Software\\Classes\\Directory\\shell\\VladSend", "HKCU\\Software\\Classes\\Directory\\shell\\VladSend\\command",
    ]);
    expect(cmds[0]!.args).toEqual(["add", keys[0], "/ve", "/d", "mac makinesine gönder", "/f"]);
    expect(cmds[1]!.args[4]).toBe('wscript.exe "C:\\dev\\vlad\\.vlad-agent\\send-mac.vbs" "%1"');
    expect(JSON.stringify(cmds)).not.toMatch(/HKLM/);
    golden("win-reg.json", JSON.stringify(cmds, null, 1) + "\n");
  });
  it("VBS: UTF-16LE+BOM, yollar gömülü, argümanlar Q() ile, -- ayırıcı, tam yol", () => {
    const l = winHiddenLauncher(W);
    expect(l.encoding).toBe("utf16le-bom");
    expect(l.file).toBe("C:\\dev\\vlad\\.vlad-agent\\send-mac.vbs");
    expect(l.content).toContain('sh.Environment("Process")("VLAD_HOME") = "C:\\dev\\vlad"');
    expect(l.content).toContain('"""C:\\Program Files\\nodejs\\node.exe"" ""C:\\dev\\vlad\\dist\\cli.js"" send --to ""mac"" --notify --"');
    expect(l.content).toContain("Q(WScript.Arguments(i))");
    expect(l.content).toContain("sh.Run cmd, 0, False");
    expect(l.content).toMatch(/\r\n/);
    golden("win-send.vbs", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(l.content, "utf16le")]));
  });
  it("tırnak/özel karakter tablosu: yollar VBS dizesinde çift tırnaklanır, kabuk özel karakterleri etkisiz", () => {
    for (const home of ["C:\\a b\\x", "C:\\a&b^c%d'e", "C:\\şıǧ ü\\yol", "C:\\😀\\vlad"]) {
      const l = winHiddenLauncher({ ...W, home, node: `${home}\\node.exe`, cli: `${home}\\cli.js` });
      expect(l.content).toContain(`("VLAD_HOME") = "${home}"`);
      expect(l.content).toContain(`""${home}\\node.exe""`);
      const reg = winMenuRegCommands({ ...W, home })[1]!.args[4]!;
      expect(reg).toBe(`wscript.exe "${home}\\.vlad-agent\\send-mac.vbs" "%1"`);
    }
    // ", satır sonu ve denetim karakteri yol/peer içinde reddedilir
    for (const bad of ['C:\\a"b', "C:\\a\nb", "C:\\a\u0000b"]) expect(() => winHiddenLauncher({ ...W, home: bad })).toThrow(/geçersiz/);
    expect(() => winHiddenLauncher({ ...W, peer: "x y" })).toThrow(/geçersiz/);
  });
  it("VBS'de Q(): sondaki ters bölü iki katına çıkar (D:\\ → \"D:\\\\\")", () => {
    const l = winHiddenLauncher(W).content;
    expect(l).toMatch(/Function Q\(s\)[\s\S]*String\(n, "\\"\)[\s\S]*End Function/);
  });
});

describe("aktarim:C2 Mac Hızlı Eylem", () => {
  it("paket: <ad>.workflow/Contents/{Info.plist,document.wflow}; komut tek tırnaklı, tam yol, -- ayırıcı", () => {
    const q = macQuickAction(M);
    expect(q.dir).toBe("windows makinesine gönder.workflow");
    expect(q.files.map((f) => f.rel).sort()).toEqual(["Contents/Info.plist", "Contents/document.wflow"]);
    const wf = q.files.find((f) => f.rel.endsWith("wflow"))!.content;
    expect(wf).toContain("export VLAD_HOME=&apos;/Users/me/dev/vlad&apos;");
    expect(wf).toContain("&apos;/opt/homebrew/bin/node&apos; &apos;/Users/me/dev/vlad/dist/cli.js&apos; send --to &apos;windows&apos; --notify -- &quot;$@&quot;");
    expect(wf).toContain("<key>inputMethod</key>\n\t\t\t\t\t<integer>1</integer>");
    const plist = q.files.find((f) => f.rel.endsWith("Info.plist"))!.content;
    expect(plist).toContain("runWorkflowAsService"); expect(plist).toContain("com.apple.finder"); expect(plist).toContain("public.item");
    for (const f of q.files) golden(`mac-${f.rel.replace("/", "-")}`, f.content);
  });
  it("özel karakterler: tek tırnak kabukta '\\'' ile, XML'de kaçışla; ş ı ğ emoji korunur", () => {
    const q = macQuickAction({ ...M, home: "/Users/me/it's & <x> \"q\" şığ 😀", node: "/n o/node", cli: "/c/cli.js" });
    const wf = q.files.find((f) => f.rel.endsWith("wflow"))!.content;
    expect(wf).toContain("it&apos;\\&apos;&apos;s &amp; &lt;x&gt; &quot;q&quot; şığ 😀");
    expect(wf).not.toContain("<x>");
  });
  it("peer adı yalnız [A-Za-z0-9._-]; aksi reddedilir", () => {
    expect(() => macQuickAction({ ...M, peer: "a/b" })).toThrow(/geçersiz/);
    expect(() => macQuickAction({ ...M, peer: "a b" })).toThrow(/geçersiz/);
  });
  it.runIf(process.platform === "darwin")("plutil -lint geçer (yalnız Mac)", () => {
    const d = tmp();
    for (const f of macQuickAction(M).files) { const p = join(d, f.rel.replace("/", "-")); writeFileSync(p, f.content); execFileSync("plutil", ["-lint", p]); }
  });
});

function fakeFs() {
  const files = new Map<string, string | Buffer>(); const writes: string[] = []; const removed: string[] = []; const runs: { file: string; args: string[] }[] = [];
  const run: ShellRunner = async (file, args) => { runs.push({ file, args }); return { stdout: Buffer.alloc(0), stderr: "", code: 0 }; };
  return {
    files, writes, removed, runs,
    d: {
      run,
      write: async (f: string, c: string | Buffer) => { writes.push(f); files.set(f, c); },
      read: async (f: string) => files.get(f) ?? null,
      remove: async (f: string) => { removed.push(f); for (const k of [...files.keys()]) if (k === f || k.startsWith(f + "/")) files.delete(k); },
      exists: async (f: string) => files.has(f),
    },
  };
}
const ctx = (over: Partial<MenuCtx>): MenuCtx => ({ os: "darwin", ...M, servicesDir: "/tmp/svc", dryRun: false, ...over });

describe("aktarim:C3 installSendMenu", () => {
  it("--dry-run: hiçbir şey yazmaz/çalıştırmaz, eylemleri listeler", async () => {
    for (const c of [ctx({ dryRun: true }), ctx({ os: "win32", ...W, dryRun: true })]) {
      const f = fakeFs(); const r = await installSendMenu(c, f.d);
      expect(f.writes).toEqual([]); expect(f.runs).toEqual([]); expect(r.actions.length).toBeGreaterThan(0);
    }
  });
  it("Mac: dosyaları servicesDir altına yazar, pbs -update çalıştırır; ikinci çalıştırma içeriği değiştirmez", async () => {
    const f = fakeFs(); const c = ctx({});
    const a1 = await installSendMenu(c, f.d);
    expect(f.writes.sort()).toEqual(["/tmp/svc/windows makinesine gönder.workflow/Contents/Info.plist", "/tmp/svc/windows makinesine gönder.workflow/Contents/document.wflow"]);
    expect(f.runs).toEqual([{ file: "/System/Library/CoreServices/pbs", args: ["-update"] }]);
    const snap = new Map(f.files); f.writes.length = 0; f.runs.length = 0;
    const a2 = await installSendMenu(c, f.d);
    expect(f.writes).toEqual([]); expect(f.runs).toEqual([]); expect(new Map(f.files)).toEqual(snap);
    expect(a1.actions.join()).toMatch(/kuruldu/); expect(a2.actions.join()).toMatch(/güncel/);
  });
  it("Mac: pbs hatası kurulumu bozmaz (uyarı eylemi)", async () => {
    const f = fakeFs(); f.d.run = async () => { throw new Error("pbs yok"); };
    const r = await installSendMenu(ctx({}), f.d);
    expect(f.writes).toHaveLength(2); expect(r.actions.join("\n")).toMatch(/pbs.*pbs yok/);
  });
  it("Windows: 4 reg add + UTF-16LE+BOM başlatıcı; ikinci çalıştırmada başlatıcı yeniden yazılmaz (reg /f idempotent)", async () => {
    const f = fakeFs(); const c = ctx({ os: "win32", ...W });
    await installSendMenu(c, f.d);
    expect(f.runs.map((r) => r.file)).toEqual(Array(4).fill("reg.exe"));
    const vbs = f.files.get("C:\\dev\\vlad\\.vlad-agent\\send-mac.vbs") as Buffer;
    expect(Buffer.isBuffer(vbs) && vbs[0] === 0xff && vbs[1] === 0xfe).toBe(true);
    f.writes.length = 0; await installSendMenu(c, f.d);
    expect(f.writes).toEqual([]);
  });
  it("Windows: reg hatası açık hata olarak fırlar (yarım kurulum sessiz kalmaz)", async () => {
    const f = fakeFs(); f.d.run = async () => ({ stdout: Buffer.alloc(0), stderr: "ERROR: erişim", code: 1 });
    await expect(installSendMenu(ctx({ os: "win32", ...W }), f.d)).rejects.toThrow(/reg.*erişim/);
  });
  it("geri alma: uninstall Mac paketini ve Windows anahtarlarını/başlatıcıyı kaldırır, yoksa sorun çıkarmaz", async () => {
    const f = fakeFs();
    await installSendMenu(ctx({}), f.d);
    const r = await installSendMenu(ctx({ uninstall: true }), f.d);
    expect(f.removed).toEqual(["/tmp/svc/windows makinesine gönder.workflow"]); expect(f.files.size).toBe(0); expect(r.actions.join()).toMatch(/kaldırıldı/);
    await installSendMenu(ctx({ uninstall: true }), f.d); // ikinci kez: hata yok
    const w = fakeFs(); await installSendMenu(ctx({ os: "win32", ...W }), w.d); w.runs.length = 0;
    await installSendMenu(ctx({ os: "win32", ...W, uninstall: true }), w.d);
    expect(w.runs.map((x) => x.args.slice(0, 2))).toEqual([
      ["delete", "HKCU\\Software\\Classes\\*\\shell\\VladSend"], ["delete", "HKCU\\Software\\Classes\\Directory\\shell\\VladSend"],
    ]);
    expect(w.removed).toEqual(["C:\\dev\\vlad\\.vlad-agent\\send-mac.vbs"]);
  });
  it("native kapalıyken (VLAD_NO_NATIVE=1) enjeksiyonsuz çağrı gerçek diske/kayıt defterine dokunmaz", async () => {
    const d = tmp();
    for (const os of ["darwin", "win32"] as const) {
      const r = await installSendMenu(ctx({ os, ...(os === "win32" ? W : M), servicesDir: d, home: d }));
      expect(r.actions.join()).toMatch(/native devre dışı/);
    }
    expect(existsSync(join(d, "windows makinesine gönder.workflow"))).toBe(false);
  });
});
