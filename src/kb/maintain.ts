import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { ARCHIVE } from "./archive.js";
import { writeFileAtomic } from "./atomic.js";
import { readDoc } from "./doc.js";
import { isSeparateKb, kbPaths } from "./home.js";
import { decisionFileFor, decisionTitle } from "./journal.js";

const HEADING = /^### \d{4}-\d{2}-\d{2} — (.+?) — /;
const OBSIDIAN = ".obsidian/";
const DAY_MS = 86400_000;

export interface MaintainResult {
  dry_run: boolean;
  days: number;
  /** decision files written (or that would be) and how many blocks each now receives from decisions.md */
  decisions: { file: string; blocks: number }[];
  tasks: { id: string; from: string; to: string }[];
  findings: { id: string; from: string; to: string }[];
  gitignore_added: string[];
}

interface Parsed { preamble: string; blocks: { slug: string; text: string }[] }

/** Splits a decision log into its `### <date> — <project> — <title>` blocks (text kept verbatim, only trailing blanks trimmed). */
function parseDecisions(text: string): Parsed {
  const pre: string[] = [];
  const blocks: { slug: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) blocks.push({ slug: decisionFileFor(m[1]), lines: [line] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
    else if (!/^# Karar Günlüğü/.test(line)) pre.push(line);
  }
  return { preamble: pre.join("\n").trim(), blocks: blocks.map((b) => ({ slug: b.slug, text: b.lines.join("\n").trimEnd() })) };
}

/** Moves the single `decisions.md` into `decisions/<slug>.md`; older legacy blocks go before ones already in the new layout. */
function splitDecisions(dry: boolean): MaintainResult["decisions"] {
  const p = kbPaths();
  if (!existsSync(p.legacyDecisions)) return [];
  const legacy = parseDecisions(readFileSync(p.legacyDecisions, "utf8"));
  const slugs = [...new Set(legacy.blocks.map((b) => b.slug))];
  if (legacy.preamble && !slugs.includes("_genel")) slugs.push("_genel");
  const report: MaintainResult["decisions"] = [];
  const writes: [string, string][] = [];
  for (const slug of slugs.sort()) {
    const file = join(p.decisions, `${slug}.md`);
    const existing = existsSync(file) ? parseDecisions(readFileSync(file, "utf8")) : { preamble: "", blocks: [] };
    const have = new Set(existing.blocks.map((b) => b.text)); // a rerun after a crash must not duplicate blocks already written
    const mine = legacy.blocks.filter((b) => b.slug === slug && !have.has(b.text)).map((b) => b.text);
    const parts = [...(slug === "_genel" ? [legacy.preamble] : []), existing.preamble, ...mine, ...existing.blocks.map((b) => b.text)].filter(Boolean);
    writes.push([file, `${decisionTitle(slug)}\n\n${parts.join("\n\n")}\n`]);
    report.push({ file: slug, blocks: mine.length });
  }
  if (!dry) {
    mkdirSync(p.decisions, { recursive: true });
    for (const [file, content] of writes) writeFileAtomic(file, content);
    rmSync(p.legacyDecisions); // every block is written above; the originals live on in git history
  }
  return report;
}

/** Moves `<dir>/<id>.md` files whose `state` is in `states` and `updated` is older than the cutoff to `<dir>/archive/<YYYY-MM>/`. */
function archiveDir(dir: string, states: string[], cutoff: number, dry: boolean): { id: string; from: string; to: string }[] {
  if (!existsSync(dir)) return [];
  const kb = kbPaths().kb;
  const moved: { id: string; from: string; to: string }[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const from = join(dir, name);
    let data: { state?: string; updated?: string };
    try { data = readDoc<{ state?: string; updated?: string }>(from).data; } catch { continue; } // unreadable files are listed as warnings by the stores
    const t = Date.parse(data.updated ?? "");
    if (!states.includes(data.state ?? "") || Number.isNaN(t) || t >= cutoff) continue;
    const to = join(dir, ARCHIVE, String(data.updated).slice(0, 7), name);
    if (existsSync(to)) continue; // same id already archived (merge/copy): never overwrite
    moved.push({ id: name.slice(0, -3), from: relative(kb, from), to: relative(kb, to) });
    if (!dry) {
      mkdirSync(join(dir, ARCHIVE, String(data.updated).slice(0, 7)), { recursive: true });
      renameSync(from, to);
    }
  }
  return moved;
}

/** Adds `.obsidian/` to a separate kb repo's .gitignore (Obsidian's local vault state must not be committed). */
function ensureObsidianIgnore(dry: boolean): string[] {
  const p = kbPaths();
  if (!isSeparateKb(p.home)) return [];
  const file = join(p.kb, ".gitignore");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.split(/\r?\n/).some((l) => l.trim().replace(/^\//, "") === OBSIDIAN)) return [];
  if (!dry) writeFileAtomic(file, `${cur && !cur.endsWith("\n") ? cur + "\n" : cur}${OBSIDIAN}\n`);
  return [OBSIDIAN];
}

/**
 * kb upkeep: splits decisions.md per project, archives closed tasks (done|cancelled) and settled findings
 * (fixed|wontfix) not updated for `days` days, keeps Obsidian state out of git. Idempotent; never deletes
 * content; `dryRun` only reports. The stores read the archive transparently.
 */
export function maintainKb(o: { days?: number; dryRun?: boolean; now?: Date } = {}): MaintainResult {
  const days = o.days ?? 30;
  if (!Number.isFinite(days) || days < 0) throw new Error(`geçersiz --days: ${o.days}`);
  const dry = !!o.dryRun;
  const cutoff = (o.now ?? new Date()).getTime() - days * DAY_MS;
  const p = kbPaths();
  return {
    dry_run: dry,
    days,
    decisions: splitDecisions(dry),
    tasks: archiveDir(p.tasks, ["done", "cancelled"], cutoff, dry),
    findings: archiveDir(p.findings, ["fixed", "wontfix"], cutoff, dry),
    gitignore_added: ensureObsidianIgnore(dry),
  };
}
