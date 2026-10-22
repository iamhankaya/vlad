import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, nowIso, readDoc, serializeDoc, validate, writeDoc } from "../kb/index.js";
import type { FindingData, FindingSeverity, FindingState } from "../kb/index.js";

export type Finding = { data: FindingData; body: string; file: string };

export const SEVERITIES: readonly FindingSeverity[] = ["kritik", "yüksek", "orta", "düşük", "bilgi"];
export const STATES: readonly FindingState[] = ["open", "deferred", "fixed", "wontfix"];
/** States that still count as unresolved. */
export const UNRESOLVED: readonly FindingState[] = ["open", "deferred"];

const DETAIL = "## Ayrıntı";

function findingFile(id: string): string {
  return join(kbPaths().findings, `${id}.md`);
}

/** Next free `F-<project>-NNN` for the project (numbering is per project). */
export function nextFindingId(dir: string, project: string): string {
  const prefix = `F-${project}-`;
  let max = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = f.startsWith(prefix) ? /^(\d+)\.md$/.exec(f.slice(prefix.length)) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

export function addFinding(
  o: { project: string; severity: string; source: string; title: string; detail?: string; state?: string },
  now: Date = new Date(),
): Finding {
  if (!/^[a-z0-9-]+$/.test(o.project)) throw new Error(`geçersiz proje slug'ı: "${o.project}" (yalnızca a-z, 0-9 ve '-')`);
  if (!(SEVERITIES as readonly string[]).includes(o.severity)) {
    throw new Error(`geçersiz önem: "${o.severity}" (geçerli: ${SEVERITIES.join(", ")})`);
  }
  const state = o.state ?? "open";
  if (state !== "open" && state !== "deferred") throw new Error(`yeni bulgu open|deferred olabilir: "${state}"`);
  const dir = kbPaths().findings;
  mkdirSync(dir, { recursive: true });
  const detail = (o.detail ?? "").trim();
  const body = `${DETAIL}\n${detail ? detail + "\n" : ""}`;
  const prefix = `F-${o.project}-`;
  let n = Number(nextFindingId(dir, o.project).slice(prefix.length));
  for (;;) {
    const id = `${prefix}${String(n).padStart(3, "0")}`;
    const ts = nowIso(now);
    const data: FindingData = {
      id, project: o.project, severity: o.severity as FindingSeverity, state, source_task: o.source,
      title: o.title.trim(), created: ts, updated: ts,
    };
    validate("finding", data);
    const file = findingFile(id);
    try {
      writeFileSync(file, serializeDoc(data, body), { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        n++;
        continue;
      }
      throw e;
    }
    return { data, body, file };
  }
}

export function getFinding(id: string): Finding {
  const file = /^F-[a-z0-9-]+-\d+$/.test(id) ? findingFile(id) : "";
  if (!file || !existsSync(file)) throw new Error(`bulgu bulunamadı: ${id}`);
  const { data, body } = readDoc<FindingData>(file);
  return { data, body, file };
}

/** Valid findings in id order; unreadable or invalid files are skipped and reported as warnings. */
export function listFindingsWithWarnings(
  f: { project?: string; state?: FindingState[]; severity?: FindingSeverity[] } = {},
): { findings: Finding[]; warnings: string[] } {
  const dir = kbPaths().findings;
  const findings: Finding[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { findings, warnings };
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const file = join(dir, name);
    try {
      const { data, body } = readDoc<FindingData>(file);
      validate("finding", data);
      if (f.project && data.project !== f.project) continue;
      if (f.state && !f.state.includes(data.state)) continue;
      if (f.severity && !f.severity.includes(data.severity)) continue;
      findings.push({ data, body, file });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { findings, warnings };
}

/** Parses a comma-separated filter, rejecting values outside `allowed`. */
export function parseFilter<T extends string>(raw: string, allowed: readonly T[], what: string): T[] {
  const vals = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = vals.filter((v) => !(allowed as readonly string[]).includes(v));
  if (bad.length) throw new Error(`geçersiz ${what}: ${bad.join(", ")} (geçerli: ${allowed.join(", ")})`);
  return vals as T[];
}

/** Open (open + deferred) findings of critical or high severity. */
export function countOpenSevere(): number {
  return listFindingsWithWarnings({ state: [...UNRESOLVED], severity: ["kritik", "yüksek"] }).findings.length;
}

/** Changes the state; `by` (the fixing task) is allowed only with `fixed` and is cleared on any other state. */
export function setFindingState(id: string, state: string, by?: string, now: Date = new Date()): Finding {
  if (!(STATES as readonly string[]).includes(state)) {
    throw new Error(`geçersiz durum: "${state}" (geçerli: ${STATES.join(", ")})`);
  }
  if (by && state !== "fixed") throw new Error("--by yalnızca fixed durumunda kullanılır");
  const f = getFinding(id);
  const ts = nowIso(now);
  const next: Record<string, unknown> = { ...f.data, state, updated: ts };
  delete next.fixed_by;
  delete next.fixed;
  if (state === "fixed") {
    next.fixed = ts;
    if (by) next.fixed_by = by;
  }
  validate("finding", next);
  writeDoc(f.file, next, f.body);
  return { data: next as unknown as FindingData, body: f.body, file: f.file };
}
