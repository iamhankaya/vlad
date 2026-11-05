import { win32 } from "node:path";
import type { MenuCtx } from "./index.js";

type Mc = Pick<MenuCtx, "node" | "cli" | "home" | "peer">;
const PEER_RE = /^[A-Za-z0-9._-]+$/;

/** Yol/ad doğrulaması: VBS dizesine ve kayıt değerine gömülecek her şey tırnak, satır sonu ve denetim karakteri taşımaz. */
export function checkMenuCtx(c: Mc, quotes = true): void {
  if (!PEER_RE.test(c.peer)) throw new Error(`sağ tık menüsü: karşı makine adı geçersiz: ${c.peer}`);
  for (const [k, v] of Object.entries({ node: c.node, cli: c.cli, home: c.home })) {
    if ((quotes ? /["\u0000-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v)) throw new Error(`sağ tık menüsü: ${k} yolu geçersiz (denetim karakteri${quotes ? " ya da tırnak" : ""})`);
  }
}

export const winLabel = (peer: string): string => `${peer} makinesine gönder`;
export const winLauncherPath = (c: Mc): string => win32.join(c.home, ".vlad-agent", `send-${c.peer}.vbs`);
const KEY = (cls: string) => `HKCU\\Software\\Classes\\${cls}\\shell\\VladSend`;
export const WIN_KEYS = [KEY("*"), KEY("Directory")];

/** Yönetici gerektirmeyen HKCU kaydı; `reg.exe` argv (kabuk yok). Windows 11'de "Diğer seçenekleri göster" altında görünür. */
export function winMenuRegCommands(c: Mc): { file: string; args: string[] }[] {
  checkMenuCtx(c);
  const command = `wscript.exe "${winLauncherPath(c)}" "%1"`;
  return WIN_KEYS.flatMap((k) => [
    { file: "reg.exe", args: ["add", k, "/ve", "/d", winLabel(c.peer), "/f"] },
    { file: "reg.exe", args: ["add", `${k}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

const vbs = (s: string) => s.replace(/"/g, '""');

/** Konsol penceresi açmadan `vlad send` çalıştıran VBS. `%1` argüman olarak gelir (kabuk dizesine gömülmez): Unicode ve `& ^ %` güvenli. */
export function winHiddenLauncher(c: Mc): { file: string; content: string; encoding: "utf16le-bom" } {
  checkMenuCtx(c);
  const content = [
    `' VLAD sağ tık "${winLabel(c.peer)}" — vlad install üretir, elle düzenleme`,
    "Option Explicit",
    "Dim sh, i, cmd",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Environment("Process")("VLAD_HOME") = "${vbs(c.home)}"`,
    `cmd = """${vbs(c.node)}"" ""${vbs(c.cli)}"" send --to ""${vbs(c.peer)}"" --notify --"`,
    "For i = 0 To WScript.Arguments.Count - 1",
    '  cmd = cmd & " " & Q(WScript.Arguments(i))',
    "Next",
    "sh.Run cmd, 0, False",
    "",
    "' Sondaki ters bölü kapanış tırnağını kaçırmasın (D:\\ gibi kök yollar)",
    "Function Q(s)",
    "  Dim n, k",
    "  n = 0",
    "  For k = Len(s) To 1 Step -1",
    '    If Mid(s, k, 1) = "\\" Then n = n + 1 Else Exit For',
    "  Next",
    '  Q = """" & s & String(n, "\\") & """"',
    "End Function",
    "",
  ].join("\r\n");
  return { file: winLauncherPath(c), content, encoding: "utf16le-bom" };
}
