import { execFileSync } from "node:child_process";

/** PreToolUse(Bash) hook: yalnız çalışan oturumlarda (VLAD_TASK_ID ya da cwd `vlad/T…` dalı) `git push` argv'sini doğrular; ret = çıkış 2 + stderr. Fail-closed: hata/yükleme hatasında ham girdi `git … push` içeriyorsa çıkış 2. */
function ownId(cwd: string): string | null {
  const env = process.env.VLAD_TASK_ID;
  if (env && /^T\d{8}-\d+$/.test(env)) return env;
  try {
    const b = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return /^vlad\/(T\d{8}-\d+)$/.exec(b)?.[1] ?? null;
  } catch { return null; }
}
const block = (msg: string) => { process.stderr.write(msg + "\n"); process.exitCode = 2; };
const mentionsPush = (raw: string) => /\bgit\b[\s\S]*\bpush\b/.test(raw);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  try {
    const { checkWorkerPush } = await import("./push-guard.js");
    const j = JSON.parse(raw);
    const cmd = j?.tool_input?.command;
    if (j?.tool_name !== "Bash" || typeof cmd !== "string") return;
    const id = ownId(typeof j.cwd === "string" ? j.cwd : process.cwd());
    if (id === null && !process.env.VLAD_TASK_ID) return; // çalışan değil (ana VLAD / kullanıcı oturumu)
    const why = checkWorkerPush(cmd, id);
    if (why) block(why);
  } catch (e) {
    if (mentionsPush(raw)) block(`push-guard hatası (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
  }
});
