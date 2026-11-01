import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Os } from "../machines/types.js";

export interface InstallCtx { node: string; cli: string; home: string; path: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Mac: LaunchAgent. AbandonProcessGroup → Agent yeniden başlasa tmux çalışan oturumları ölmez. */
export function launchdPlist(c: InstallCtx): string {
  const args = [c.node, c.cli, "agent", "start"].map((a) => `<string>${esc(a)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.vlad.agent</string>
<key>ProgramArguments</key><array>${args}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(c.path)}</string><key>VLAD_HOME</key><string>${esc(c.home)}</string></dict>
<key>StandardOutPath</key><string>${esc(join(c.home, ".vlad-agent", "agent.log"))}</string>
<key>StandardErrorPath</key><string>${esc(join(c.home, ".vlad-agent", "agent.log"))}</string>
</dict></plist>
`;
}

/** Windows: oturum açılışında kullanıcının etkileşimli oturumunda (/it) başlar; hizmet olarak kurulmaz (masaüstü penceresi açamaz). */
export function schtasksArgs(c: Pick<InstallCtx, "node" | "cli" | "home">): string[] {
  return ["/create", "/tn", "VladAgent", "/sc", "onlogon", "/it", "/rl", "limited", "/tr", `"${winStartCmd(c.home)}"`, "/f"];
}

/** schtasks süreç ortamını taşımaz; VLAD_HOME'u (launchd gibi) bu başlatma betiği sabitler. */
const winStartCmd = (home: string): string => `${home}\\.vlad-agent\\agent-start.cmd`;
const winStartContent = (c: Pick<InstallCtx, "node" | "cli" | "home">): string =>
  `@echo off\r\nchcp 65001 >nul\r\nset "VLAD_HOME=${c.home.replace(/%/g, "%%")}"\r\n"${c.node}" "${c.cli}" agent start\r\n`;

export interface Plan { description: string; command?: string; file?: string; content?: string; apply?: () => void }

/** Yalnız yazdırılacakları üretir; `apply` ayrı bir adımdır (CLI `--apply` ile çağırır). */
export function installPlan(os: Os, c: InstallCtx): Plan {
  if (os === "win32") {
    const a = schtasksArgs(c);
    const file = winStartCmd(c.home);
    const content = winStartContent(c);
    return {
      description: "Windows Görev Zamanlayıcı: oturum açılışında Agent (VLAD_HOME'u sabitleyen başlatma betiği)", file, content,
      command: `schtasks ${a.map((x) => (/\s/.test(x) && !x.startsWith('"') ? `"${x}"` : x)).join(" ")}`,
      apply: () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); execFileSync("schtasks", a, { stdio: "inherit" }); },
    };
  }
  if (os === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", "com.vlad.agent.plist");
    const content = launchdPlist(c);
    return {
      description: "Mac LaunchAgent (RunAtLoad, KeepAlive, AbandonProcessGroup)", file, content,
      command: `launchctl bootstrap gui/$(id -u) ${file}`,
      apply: () => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
        execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, file], { stdio: "inherit" });
      },
    };
  }
  throw new Error(`agent install: ${os} desteklenmiyor (yalnız win32 ve darwin)`);
}
