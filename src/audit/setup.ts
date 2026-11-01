import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getVladHome } from "../kb/index.js";
import { getSection } from "../kb/sections.js";
import { listFindingsWithWarnings, UNRESOLVED } from "../findings/store.js";
import { listRolesWithWarnings } from "../roles/store.js";
import { listTasks } from "../tasks/index.js";
import { auditSkills } from "./skills.js";

const DAY = 86_400_000;
const STALE_DAYS = 30;
const EXAMPLES = 5;
const bare = (s: string) => s.slice(s.lastIndexOf(":") + 1);

export interface Signal { tasks: number; count: number; examples: string[] }
export interface SetupAudit {
  since: string;
  tasks: { total: number; ids: string[]; by_role: Record<string, number>; by_phase: Record<string, number>; by_model: Record<string, number> };
  measures: { tasks_with_measure: number; sums: Record<string, number> };
  open_points: { total: number; by_severity: Record<string, number> };
  signals: { test_itirazi: Signal; degisiklik_istegi: Signal; karar: Signal; izin_reddi: Signal };
  skills: {
    inventory: { name: string; source: "repo" | "global" | "vendor" | "role"; roles: string[]; loaded: number }[];
    unused: string[];
    transcripts: number;
  };
  findings: { unresolved: { id: string; project: string; severity: string; state: string; title: string; age_days: number }[]; stale: number };
}

const bump = (m: Record<string, number>, k: string | null | undefined) => { const key = k || "-"; m[key] = (m[key] ?? 0) + 1; };
const matches = (s: string, re: RegExp) => (s.match(re) ?? []).length;

function skillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md"))).map((e) => e.name);
}

/**
 * Read-only data for the periodic setup audit (`/setup-audit`): done/cancelled tasks updated since `since`
 * (closing-report measures, open points, friction signals), the skill inventory with usage, and unresolved
 * findings by age. Interpretation (what is missing, superfluous, a skill candidate) is the skill's job.
 */
export function auditSetup(o: { since?: string; configDir?: string; now?: Date } = {}): SetupAudit {
  const now = o.now ?? new Date();
  const since = o.since ?? new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new Error(`geçersiz --since: ${o.since}`);

  const tasks = listTasks({ state: ["done", "cancelled"] }).filter((t) => Date.parse(t.data.updated) >= sinceMs);
  const roles = listRolesWithWarnings().roles;
  const out: SetupAudit = {
    since,
    tasks: { total: tasks.length, ids: tasks.map((t) => t.data.id).sort(), by_role: {}, by_phase: {}, by_model: {} },
    measures: { tasks_with_measure: 0, sums: {} },
    open_points: { total: 0, by_severity: {} },
    signals: {
      test_itirazi: { tasks: 0, count: 0, examples: [] }, degisiklik_istegi: { tasks: 0, count: 0, examples: [] },
      karar: { tasks: 0, count: 0, examples: [] }, izin_reddi: { tasks: 0, count: 0, examples: [] },
    },
    skills: { inventory: [], unused: [], transcripts: 0 },
    findings: { unresolved: [], stale: 0 },
  };

  const signal = (s: Signal, id: string, n: number) => {
    if (!n) return;
    s.tasks++; s.count += n;
    if (s.examples.length < EXAMPLES) s.examples.push(id);
  };
  for (const t of tasks) {
    const { id } = t.data;
    bump(out.tasks.by_role, t.data.role);
    bump(out.tasks.by_phase, t.data.phase);
    bump(out.tasks.by_model, t.data.model ?? roles.find((r) => r.slug === t.data.role)?.model);

    const closing = getSection(t.body, "## Kapanış raporu") ?? "";
    const m = [...closing.matchAll(/Ölçüm:(.*)/g)].pop();
    if (m) {
      out.measures.tasks_with_measure++;
      for (const [, k, v] of m[1].matchAll(/([a-zçğıöşü_]+)=(\d+)/gi)) out.measures.sums[k] = (out.measures.sums[k] ?? 0) + Number(v);
    }
    const points = /^### Açık noktalar\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(closing)?.[1] ?? "";
    for (const [, sev] of points.matchAll(/^- \[(kritik|yüksek|orta|düşük|bilgi)\]/gim)) {
      out.open_points.total++;
      bump(out.open_points.by_severity, sev.toLowerCase());
    }

    const progress = getSection(t.body, "## İlerleme") ?? "";
    signal(out.signals.test_itirazi, id, matches(t.body, /Test itirazı:/g));
    signal(out.signals.degisiklik_istegi, id, matches(t.body, /^## Önceki raporlar\s*$/gm));
    signal(out.signals.karar, id, matches(progress, /\[KARAR\]/g));
    signal(out.signals.izin_reddi, id, matches(progress, /izin reddi|permission denied/gi));
  }

  // skills: where they live, which roles name them, how often transcripts show them loaded
  const home = getVladHome();
  const found = new Map<string, { source: "repo" | "global" | "vendor" | "role"; roles: Set<string> }>();
  const add = (name: string, source: "repo" | "global" | "vendor") => found.set(name, { source, roles: new Set() });
  for (const [dir, src] of [[".claude/skills", "repo"], ["global/skills", "global"], ["vendor/skills", "vendor"]] as const) {
    for (const n of skillDirs(join(home, dir))) add(n, src);
  }
  for (const r of roles) {
    for (const s of r.skills.map(bare)) {
      if (!found.has(s)) found.set(s, { source: "role", roles: new Set() });
      found.get(s)!.roles.add(r.slug);
    }
  }
  const usage = auditSkills({ since, configDir: o.configDir });
  const loaded: Record<string, number> = { ...usage.vlad.loaded };
  for (const t of usage.tasks) for (const s of t.loaded) loaded[s] = (loaded[s] ?? 0) + 1;
  out.skills.transcripts = usage.summary.audited;
  out.skills.inventory = [...found].map(([name, v]) => ({ name, source: v.source, roles: [...v.roles].sort(), loaded: loaded[name] ?? 0 })).sort((a, b) => (a.name < b.name ? -1 : 1));
  out.skills.unused = out.skills.inventory.filter((s) => !s.loaded).map((s) => s.name);

  const fs = listFindingsWithWarnings({ state: [...UNRESOLVED] }).findings;
  out.findings.unresolved = fs
    .map((f) => ({ id: f.data.id, project: f.data.project, severity: f.data.severity, state: f.data.state, title: f.data.title, age_days: Math.floor((now.getTime() - Date.parse(f.data.created)) / DAY) }))
    .sort((a, b) => b.age_days - a.age_days || (a.id < b.id ? -1 : 1));
  out.findings.stale = out.findings.unresolved.filter((f) => f.age_days > STALE_DAYS).length;
  return out;
}
