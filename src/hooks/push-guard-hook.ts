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
    const { checkWorkerMode, MODE_GUARD_TOOLS } = await import("./mode-guard.js");
    const j = JSON.parse(raw);
    const tool = j?.tool_name;
    if (typeof tool !== "string" || !MODE_GUARD_TOOLS.includes(tool)) return;
    const cwd = typeof j.cwd === "string" ? j.cwd : process.cwd();
    const id = ownId(cwd);
    // F-vlad-287: çalışan = VLAD_TASK_ID (hook, Claude sürecinin ortamını miras alır; komuttaki `env -u` ona dokunmaz) ya da vlad/T… dalı ya da <repo>-wt/T… dizini
    const worker = id !== null || !!process.env.VLAD_TASK_ID?.trim() || (await import("../mode/guard.js")).inWorkerWorktreeDir(cwd);
    if (!worker) return; // ana VLAD / kullanıcı oturumu
    let kb: string | null = null;
    try { const h = await import("../kb/home.js"); kb = h.resolveKbDir(h.getVladHome()).dir; } catch { /* kb çözülemedi: mode.json yazımı fail-closed */ }
    const modeWhy = checkWorkerMode(tool, j.tool_input, kb);
    if (modeWhy) return block(modeWhy);
    const cmd = j?.tool_input?.command;
    if (tool !== "Bash" || typeof cmd !== "string" || (id === null && !process.env.VLAD_TASK_ID)) return; // push doğrulaması önceki koşulla aynı
    const why = checkWorkerPush(cmd, id);
    if (why) block(why);
  } catch (e) {
    if (mentionsPush(raw) || (/mode/i.test(raw) && (process.env.VLAD_TASK_ID || ownId(process.cwd())))) block(`push-guard hatası (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
  }
});
