// approver exec testleri için sahte "cli": ilk argüman davranışı seçer. Gerçek vlad çalıştırmaz.
import { spawn } from "node:child_process";
const [mode, ...rest] = process.argv.slice(2);
if (mode === "env") { process.stdout.write(JSON.stringify({ argv: rest, env: process.env, cwd: process.cwd() })); }
else if (mode === "exit") { process.stderr.write("hata metni"); process.exit(Number(rest[0] ?? 3)); }
else if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "stubborn") { process.on("SIGTERM", () => {}); const gc = spawn("sleep", ["60"], { stdio: "ignore" }); process.stdout.write(`pid ${gc.pid}\n`); setInterval(() => {}, 1000); }
else if (mode === "flood") { const n = Number(rest[0] ?? 1_000_000); process.stdout.write("x".repeat(n)); process.stderr.write("y".repeat(n)); }
