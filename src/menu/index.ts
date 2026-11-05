import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, win32 } from "node:path";
import type { ShellRunner } from "../clip/types.js";
import type { Os } from "../machines/types.js";
import { nativeAllowed } from "../platform/native.js";
import { macQuickAction } from "./mac.js";
import { WIN_KEYS, winHiddenLauncher, winLauncherPath, winMenuRegCommands } from "./win.js";

// Sağ tık "gönder" menüsü: Windows HKCU kaydı + gizli VBS başlatıcı, Mac Finder Hızlı Eylemi. Hepsi yönetici gerektirmez.
export { macQuickAction } from "./mac.js";
export { winHiddenLauncher, winMenuRegCommands } from "./win.js";
export interface MenuCtx { os: Os; node: string; cli: string; home: string; peer: string; servicesDir: string; dryRun: boolean; /** menüyü kaldırır (geri alma) */ uninstall?: boolean }
export interface MenuDeps {
  run?: ShellRunner; write?: (f: string, content: string | Buffer) => Promise<void>; exists?: (f: string) => Promise<boolean>;
  /** boş eşitlik denetimi için: dosya yoksa null */ read?: (f: string) => Promise<string | Buffer | null>;
  remove?: (f: string) => Promise<void>;
}

const PBS = "/System/Library/CoreServices/pbs";
const realRun: ShellRunner = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000, encoding: "buffer" }, (e, stdout, stderr) =>
    resolve({ stdout, stderr: stderr.toString("utf8"), code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0 }));
});
const realDeps: Required<MenuDeps> = {
  run: realRun,
  write: async (f, c) => { await mkdir(dirname(f), { recursive: true }); await writeFile(f, c); },
  exists: async (f) => readFile(f).then(() => true, () => false),
  read: async (f) => readFile(f).catch(() => null),
  // yalnız bu modülün ürettiği yollar silinir: Hızlı Eylem paketi (.workflow) ya da başlatıcı (.vbs)
  remove: async (f) => { if (!/\.(workflow|vbs)$/.test(f)) throw new Error(`silme reddedildi: ${f}`); await rm(f, { recursive: true, force: true }); },
};

const same = (a: string | Buffer | null, b: string | Buffer) => a !== null && Buffer.from(a).equals(Buffer.from(b));

async function reg(run: ShellRunner, c: { file: string; args: string[] }): Promise<void> {
  const r = await run(c.file, c.args);
  if (r.code !== 0) throw new Error(`reg.exe başarısız (${c.args.slice(0, 2).join(" ")}): ${r.stderr.trim() || `çıkış ${r.code}`}`);
}

async function installWin(c: MenuCtx, d: Required<MenuDeps>): Promise<string[]> {
  const l = winHiddenLauncher(c);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(l.content, "utf16le")]);
  const actions: string[] = [];
  if (c.uninstall) {
    for (const k of WIN_KEYS) await d.run("reg.exe", ["delete", k, "/f"]).catch(() => undefined); // yoksa hata sayılmaz
    await d.remove(l.file);
    return [`sağ tık menüsü kaldırıldı: HKCU ${WIN_KEYS.length} anahtar, ${l.file}`];
  }
  if (same(await d.read(l.file), bytes)) actions.push(`sağ tık başlatıcısı güncel: ${l.file}`);
  else { await d.write(l.file, bytes); actions.push(`sağ tık başlatıcısı yazıldı: ${l.file}`); }
  for (const cmd of winMenuRegCommands(c)) await reg(d.run, cmd); // reg add /f: tekrar çalıştırmak aynı sonucu verir
  actions.push(`sağ tık menüsü kuruldu (Gezgin, HKCU): ${c.peer}`);
  return actions;
}

async function installMac(c: MenuCtx, d: Required<MenuDeps>): Promise<string[]> {
  const q = macQuickAction(c);
  const root = join(c.servicesDir, q.dir);
  const refresh = async (): Promise<string> => d.run(PBS, ["-update"]).then((r) => (r.code === 0 ? "" : `; pbs -update çıkış ${r.code}`), (e) => `; pbs -update başarısız: pbs ${(e as Error).message}`);
  if (c.uninstall) {
    if (!(await d.exists(join(root, q.files[0]!.rel)))) return [`sağ tık menüsü zaten yok: ${root}`];
    await d.remove(root);
    return [`sağ tık menüsü kaldırıldı: ${root}${await refresh()}`];
  }
  let changed = false;
  for (const f of q.files) {
    const p = join(root, f.rel);
    if (same(await d.read(p), f.content)) continue;
    await d.write(p, f.content); changed = true;
  }
  if (!changed) return [`sağ tık menüsü güncel: ${root}`];
  return [`sağ tık menüsü kuruldu (Finder Hızlı Eylem): ${root}${await refresh()}`];
}

/** Eylemleri döner (vlad install çıktısına eklenir). `dryRun` yazmaz/çalıştırmaz. Enjeksiyonsuz ve VLAD_NO_NATIVE=1 iken gerçek diske/kayıt defterine dokunmaz. */
export async function installSendMenu(c: MenuCtx, d: MenuDeps = {}): Promise<{ actions: string[] }> {
  const win = c.os === "win32";
  if (!win && c.os !== "darwin") return { actions: [`sağ tık menüsü atlandı: ${c.os} desteklenmiyor`] };
  if (c.dryRun) {
    if (win) winMenuRegCommands(c); // girdi doğrulaması dry-run'da da çalışsın
    const what = c.uninstall ? "kaldırılacak" : "kurulacak";
    return { actions: [win ? `sağ tık menüsü ${what}: HKCU ${WIN_KEYS.join(", ")} ve ${winLauncherPath(c)}` : `sağ tık menüsü ${what}: ${join(c.servicesDir, macQuickAction(c).dir)}`] };
  }
  if (!(d.run && d.write && d.read && d.exists && d.remove) && !nativeAllowed()) return { actions: ["sağ tık menüsü atlandı: native devre dışı (VLAD_NO_NATIVE=1)"] };
  const deps = { ...realDeps, ...d } as Required<MenuDeps>;
  return { actions: win ? await installWin(c, deps) : await installMac(c, deps) };
}
