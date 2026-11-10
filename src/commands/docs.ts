import type { CommandSpec } from "./types.js";
import { COMMANDS } from "./manifest.js";
import { COMMAND_DOCS, GROUP_NOTES } from "./docs-data.js";

/** Error list: every manifest command needs a description and every description a command. */
export function validateDocs(specs: readonly CommandSpec[] = COMMANDS, docs: Readonly<Record<string, string>> = COMMAND_DOCS): string[] {
  const errors: string[] = [];
  const names = new Set(specs.map((s) => s.path.join(" ")));
  for (const n of names) if (!docs[n]?.trim()) errors.push(`açıklama yok: ${n}`);
  for (const k of Object.keys(docs)) if (!names.has(k)) errors.push(`manifestte olmayan komut açıklaması: ${k}`);
  return errors;
}

const workerLabel = (s: CommandSpec): string => (s.worker.kind === "local" ? "yerel" : s.worker.kind === "forward" ? "beyne iletilir" : "işçide reddedilir");
const consoleLabel = (s: CommandSpec): string => (s.console.kind === "none" ? "konsolda yok" : s.console.kind === "read" ? "konsol: okuma" : "konsol: yazma");

/** docs/commands.md content, derived from the manifest (policy) and COMMAND_DOCS (descriptions). Deterministic. */
export function renderCommandsDoc(specs: readonly CommandSpec[] = COMMANDS, docs: Readonly<Record<string, string>> = COMMAND_DOCS): string {
  const groups = new Map<string, CommandSpec[]>();
  for (const s of specs) {
    const g = s.path[0]!;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  const out: string[] = [
    "# VLAD komut başvurusu",
    "",
    "<!-- Üretilmiştir: `npm run build && npm run docs:commands`. Elle düzenleme; açıklamalar src/commands/docs-data.ts, politika src/commands/manifest.ts. -->",
    "",
    "Bayrakların tamamı için `vlad <komut> --help`. Her satırın sonunda manifest politikası: işçi makinede davranışı, vlad-desktop konsol kataloğu, `--json` desteği. Makine okunur çıktı için `--json` ekle; hata olursa CLI stderr'e `{\"error\": ..., \"details\": [...]}` basar ve 1 ile çıkar.",
    "",
  ];
  for (const [g, list] of groups) {
    out.push(`## ${g}`, "");
    if (GROUP_NOTES[g]) out.push(GROUP_NOTES[g]!, "");
    for (const s of list) {
      const name = s.path.join(" ");
      out.push(`- \`vlad ${name}\` — ${docs[name] ?? ""} _(${workerLabel(s)}; ${consoleLabel(s)}${s.json ? "; --json" : ""})_`);
    }
    out.push("");
  }
  return out.join("\n");
}
