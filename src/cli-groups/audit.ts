import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { def, defWrite, out, type Opts } from "../cli-util.js";
import { addAudit, listAudit } from "../audit/store.js";
import type { AuditData } from "../kb/index.js";

async function readJson(file: string): Promise<unknown> {
  let text: string;
  if (file === "-") {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    text = readFileSync(file, "utf8");
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`geçersiz JSON: ${(e as Error).message}`);
  }
}

const auditLine = (e: AuditData) => `${e.ts}  ${e.action_id}  ${e.kind}  ${e.repo}#${e.pr}  ${e.approver.type}:${e.approver.id}  ${e.result}`;

export function registerAudit(program: Command): void {
  const audit = program.command("audit").description("Denetim kaydı (kb/audit/YYYY-MM.jsonl)");
  defWrite(audit, "add", "Denetim satırı ekler (tek, action_id anahtarlı)", async (o: Opts) => {
    const e = addAudit(await readJson(o.file as string));
    out(o, { action_id: e.action_id }, `denetim yazıldı: ${e.action_id}`);
  }).requiredOption("--file <json>", "denetim satırı JSON (- = stdin)");
  def(audit, "list", "Denetim satırlarını listeler; bozuk satır uyarı olur", (o: Opts) => {
    const { entries, warnings } = listAudit({ since: o.since as string | undefined });
    out(o, { entries, warnings }, [...entries.map(auditLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"));
  }).option("--since <iso>", "bu zamandan sonrakiler");
}
