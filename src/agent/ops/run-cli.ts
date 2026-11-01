import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RemoteError, type ExecResult } from "../../machines/types.js";

/** Alt süreç betiği: üretimde dist/cli.js; yalnız VLAD_AGENT_TEST=1 iken VLAD_AGENT_CLI (kaydedici betik) geçerlidir. */
export function cliPath(): string {
  if (process.env.VLAD_AGENT_TEST === "1" && process.env.VLAD_AGENT_CLI) return process.env.VLAD_AGENT_CLI;
  return fileURLToPath(new URL("../../cli.js", import.meta.url));
}

/** `node cli.js <argv…>` — shell yok, argv dizi; çıktı/çıkış kodu aynen döner. */
export function runCli(argv: string[], o: { stdin?: string; forwarded: string; opId: string; timeoutMs: number }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...argv], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, VLAD_FORWARDED: o.forwarded, VLAD_OP_ID: o.opId },
    });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    const timer = setTimeout(() => { child.kill(); reject(new RemoteError("failed", `failed: komut ${Math.round(o.timeoutMs / 1000)} sn içinde bitmedi`)); }, o.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(new RemoteError("failed", `failed: alt süreç başlamadı: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exit: code ?? 1 });
    });
    child.stdin.on("error", () => { /* çocuk stdin'i okumadan çıktı */ });
    child.stdin.end(o.stdin ?? "");
  });
}
