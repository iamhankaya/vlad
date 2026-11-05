import { win32 } from "node:path";
import type { MenuCtx } from "./index.js";

type Mc = Pick<MenuCtx, "node" | "cli" | "home" | "peer" | "self">;
const PEER_RE = /^[A-Za-z0-9._-]+$/;

/** Yol/ad doğrulaması: VBS dizesine ve kayıt değerine gömülecek her şey tırnak, satır sonu ve denetim karakteri taşımaz. */
export function checkMenuCtx(c: Mc, quotes = true): void {
  // Windows: % hem REG_EXPAND_SZ komutunda hem VBS dizesinde genişleme riski taşır; yolda reddedilir
  if (!PEER_RE.test(c.peer)) throw new Error(`sağ tık menüsü: karşı makine adı geçersiz: ${c.peer}`);
  if (c.self !== undefined && !PEER_RE.test(c.self)) throw new Error(`sağ tık menüsü: yerel makine adı geçersiz: ${c.self}`);
  for (const [k, v] of Object.entries({ node: c.node, cli: c.cli, home: c.home })) {
    if ((quotes ? /["%\u0000-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v)) throw new Error(`sağ tık menüsü: ${k} yolu geçersiz (denetim karakteri${quotes ? ", tırnak ya da %" : ""})`);
  }
}

export const winLabel = (peer: string): string => `${peer} makinesine gönder`;
export const winLauncherPath = (c: Mc): string => win32.join(c.home, ".vlad-agent", `send-${c.peer}.vbs`);
const KEY = (cls: string) => `HKCU\\Software\\Classes\\${cls}\\shell\\VladSend`;
export const WIN_KEYS = [KEY("*"), KEY("Directory")];

/** Yönetici gerektirmeyen HKCU kaydı; `reg.exe` argv (kabuk yok). Komut REG_EXPAND_SZ: wscript tam yolu `%SystemRoot%\System32` altından (PATH'e güvenilmez). Windows 11'de "Diğer seçenekleri göster" altında görünür. */
export function winMenuRegCommands(c: Mc): { file: string; args: string[] }[] {
  checkMenuCtx(c);
  const command = `%SystemRoot%\\System32\\wscript.exe "${winLauncherPath(c)}" "%1"`;
  return WIN_KEYS.flatMap((k) => [
    { file: "reg.exe", args: ["add", k, "/ve", "/d", winLabel(c.peer), "/f"] },
    { file: "reg.exe", args: ["add", `${k}\\command`, "/ve", "/t", "REG_EXPAND_SZ", "/d", command, "/f"] },
  ]);
}

/** Başlatıcı dizini ve dosyası: miras kaldır, yalnız verilen SID + SYSTEM tam yetki (başka yerel kullanıcı başlatıcıyı değiştiremesin). icacls argv, kabuk yok. */
export function winAclCommands(sys32: string, dir: string, file: string, sid: string): { file: string; args: string[] }[] {
  if (!/^S-1-\d+(-\d+)+$/.test(sid)) throw new Error(`kullanıcı SID'i geçersiz: ${sid}`);
  const icacls = win32.join(sys32, "icacls.exe");
  return [
    { file: icacls, args: [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"] },
    { file: icacls, args: [file, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-18:F"] },
  ];
}

const vbs = (s: string) => s.replace(/"/g, '""');

/** Konsol penceresi açmadan `vlad send` çalıştıran VBS. Komut dizesi sabittir; seçili yollar `VLAD_ARG_*` ortam değişkenleriyle gider (`--args-env`): `%VAR%`/`&`/`^`/tırnak hiçbir yerde yorumlanmaz. */
export function winHiddenLauncher(c: Mc): { file: string; content: string; encoding: "utf16le-bom" } {
  checkMenuCtx(c);
  const content = [
    `' VLAD sağ tık "${winLabel(c.peer)}" — vlad install üretir, elle düzenleme`,
    "Option Explicit",
    "Dim sh, env, i, cmd",
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("Process")',
    `sh.Environment("Process")("VLAD_HOME") = "${vbs(c.home)}"`,
    ...(c.self ? [`sh.Environment("Process")("VLAD_MACHINE") = "${vbs(c.self)}"`] : []),
    'env("VLAD_ARG_COUNT") = CStr(WScript.Arguments.Count)',
    "For i = 0 To WScript.Arguments.Count - 1",
    '  env("VLAD_ARG_" & (i + 1)) = WScript.Arguments(i)',
    "Next",
    `cmd = """${vbs(c.node)}"" ""${vbs(c.cli)}"" send --to ""${vbs(c.peer)}"" --notify --args-env"`,
    "sh.Run cmd, 0, False",
    "",
  ].join("\r\n");
  return { file: winLauncherPath(c), content, encoding: "utf16le-bom" };
}
