import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** `taskkill` PATH'ten değil `%SystemRoot%\System32`'den (PATH önceliği ile sahte taskkill.exe çalışmasın). */
export const taskkillPath = (systemRoot: string | undefined = process.env.SystemRoot): string => win32.join(systemRoot || "C:\\Windows", "System32", "taskkill.exe");

/** Süreci torunlarıyla öldürür: Windows'ta `taskkill /T /F`, POSIX'te süreç grubu (spawn `detached: true` ile açılmış olmalı). */
export function killTree(p: ReturnType<typeof spawn>): void {
  // Windows'ta p.kill() yalnız cmd.exe'yi öldürür; torunlar (npm test…) boruları tutar
  if (process.platform === "win32" && p.pid) spawn(taskkillPath(), ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => p.kill());
  else if (p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } } // detached: süreç grubu lideri; torunlar da gider
  else p.kill();
}
