import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { def, defWrite, out, type Opts } from "../cli-util.js";
import { addGrant, listGrants, revokeGrant } from "../grants/store.js";
import type { GrantData } from "../kb/index.js";

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

const grantLine = (g: GrantData) =>
  `${g.id}  ${g.scope.type}:${g.scope.ref}  ${g.action}  [${g.conditions.join(",")}]  son:${g.expires}  kullanım<=${g.max_uses}${g.revoked ? "  İPTAL" : ""}`;

export function registerGrant(program: Command): void {
  const grant = program.command("grant").description("Yetki devri kayıtları (kb/grants/G-NNN.md)");
  defWrite(grant, "add", "Devir kaydı ekler (yalnız biçim doğrulaması; imzayı API doğrular)", async (o: Opts) => {
    const g = addGrant(await readJson(o.file as string));
    out(o, { id: g.data.id }, `devir yazıldı: ${g.data.id}`);
  }).requiredOption("--file <json>", "devir JSON (- = stdin)");
  def(grant, "list", "Devirleri listeler; bozuk dosya uyarı olur", (o: Opts) => {
    const { grants, warnings } = listGrants({ active: Boolean(o.active) });
    out(o, { grants: grants.map((g) => g.data), warnings }, [...grants.map((g) => grantLine(g.data)), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"));
  }).option("--active", "yalnız iptal edilmemiş ve süresi dolmamışlar");
  defWrite(grant, "revoke <id>", "Devri iptal eder (geri alınamaz)", (id: string, o: Opts) => {
    const g = revokeGrant(id);
    out(o, { id: g.data.id, revoked: true }, `devir iptal edildi: ${g.data.id}`);
  });
}
