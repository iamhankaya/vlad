import { spawn } from "node:child_process";

/** Süreci torunlarıyla öldürür: Windows'ta `taskkill /T /F`, POSIX'te süreç grubu (spawn `detached: true` ile açılmış olmalı). */
export function killTree(p: ReturnType<typeof spawn>): void {
  // Windows'ta p.kill() yalnız cmd.exe'yi öldürür; torunlar (npm test…) boruları tutar
  if (process.platform === "win32" && p.pid) spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => p.kill());
  else if (p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } } // detached: süreç grubu lideri; torunlar da gider
  else p.kill();
}
