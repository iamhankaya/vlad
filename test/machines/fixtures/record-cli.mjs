// Sahte `vlad` CLI'si (VLAD_AGENT_CLI): argv ve stdin'i VLAD_RECORD_FILE'a JSONL ekler; çıktı/çıkış kodu env'den.
// Gerçek alt süreç davranışını (shell:false, argv dizisi, stdin) taklit eder; kb'ye dokunmaz.
import { appendFileSync, readFileSync } from "node:fs";

const file = process.env.VLAD_RECORD_FILE;
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch { /* stdin yok */ }
const rec = { argv: process.argv.slice(2), stdin, env: { VLAD_FORWARDED: process.env.VLAD_FORWARDED ?? null, VLAD_OP_ID: process.env.VLAD_OP_ID ?? null } };
if (file) appendFileSync(file, JSON.stringify(rec) + String.fromCharCode(10));
process.stdout.write(process.env.VLAD_RECORD_STDOUT ?? "");
process.stderr.write(process.env.VLAD_RECORD_STDERR ?? "");
process.exit(Number(process.env.VLAD_RECORD_EXIT ?? 0));
