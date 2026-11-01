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
export function schtasksArgs(c: Pick<InstallCtx, "node" | "cli">): string[] {
  return ["/create", "/tn", "VladAgent", "/sc", "onlogon", "/it", "/rl", "limited", "/tr", `"${c.node}" "${c.cli}" agent start`, "/f"];
}

export interface Plan { description: string; command?: string; file?: string; content?: string; apply?: () => void }

/** Yalnız yazdırılacakları üretir; `apply` ayrı bir adımdır (CLI `--apply` ile çağırır). */
export function installPlan(os: Os, c: InstallCtx): Plan {
  if (os === "win32") {
    const a = schtasksArgs(c);
    return { description: "Windows Görev Zamanlayıcı: oturum açılışında Agent", command: `schtasks ${a.map((x) => (/\s/.test(x) && !x.startsWith('"') ? `"${x}"` : x)).join(" ")}`, apply: () => { execFileSync("schtasks", a, { stdio: "inherit" }); } };
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
