import { homedir } from "node:os";
import { join } from "node:path";
import { getVladHome } from "../kb/index.js";
import { getSection } from "../kb/sections.js";
import { listFindingsWithWarnings, UNRESOLVED } from "../findings/store.js";
import { listRolesWithWarnings } from "../roles/store.js";
import { listTasks } from "../tasks/index.js";
import { effectiveModel } from "../tasks/store.js";
import { firstAdded, installedSkills, lastChanged, roleSkillSince, skillDirs } from "./rules.js";
import { auditSkills, parseSince } from "./skills.js";

const DAY = 86_400_000;
const STALE_DAYS = 30;
const EXAMPLES = 5;
const bare = (s: string) => s.slice(s.lastIndexOf(":") + 1);

export interface ArmMeasure { tasks: number; tasks_with_measure: number; sums: Record<string, number> }
export interface Signal { tasks: number; count: number; examples: string[] }
type Source = "repo" | "global" | "vendor" | "user" | "plugin" | "role";
interface CoverageRow { role: string; skill: string; since: string | null; since_unknown: boolean; expected_tasks: number; loaded_tasks: number; rate: number }
export interface SetupAudit {
  since: string;
  tasks: { total: number; ids: string[]; by_role: Record<string, number>; by_phase: Record<string, number>; by_model: Record<string, number> };
  /** `by_ponytail`: the same sums split by the task's `experiment.ponytail` arm (T20261102-16); tasks outside the experiment are in neither. */
  measures: { tasks_with_measure: number; sums: Record<string, number>; by_ponytail: { on: ArmMeasure; off: ArmMeasure } };
  open_points: { total: number; by_severity: Record<string, number> };
  signals: { test_itirazi: Signal; degisiklik_istegi: Signal; karar: Signal; izin_reddi: Signal };
  cancelled: { total: number; with_reason: number; without_reason_ids: string[] };
  skills: {
    /**
     * `source`: repo/global/vendor (VLAD repo), user (~/.claude/skills), plugin (cache, named `plugin:skill`),
     * role (named by a role, installed nowhere). `added`: first commit of the skill dir (repo/global/vendor), else null.
     */
    inventory: { name: string; source: Source; roles: string[]; loaded: number; added: string | null }[];
    unused: string[];
    transcripts: number;
    /** Role skills per role, measured only on tasks created on/after the date the skill entered the role file. */
    coverage: { by_skill: CoverageRow[]; skipped_before_rule: number; expected: number; loaded: number; rate: number | null };
  };
  /** Last commit date per rule file in the VLAD repo (null: not committed, or no git). */
  rules: { claude_md: string | null; roles: Record<string, string | null> };
  findings: {
    unresolved: { id: string; project: string; severity: string; state: string; title: string; age_days: number; source_task: string }[];
    stale: number;
    by_severity: Record<string, number>; by_project: Record<string, number>; by_source: Record<string, number>;
  };
}

const bump = (m: Record<string, number>, k: string | null | undefined) => { const key = k || "-"; m[key] = (m[key] ?? 0) + 1; };
const matches = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/**
 * Read-only data for the periodic setup audit (`/setup-audit`): done/cancelled tasks updated since `since`
 * (closing-report measures, open points, friction signals), the skill inventory with usage and time-coherent
 * role coverage, rule change dates, and unresolved findings. Interpretation (what is missing, superfluous, a skill
 * candidate) and verifying each candidate against later fixes is the skill's job.
 */
export function auditSetup(o: { since?: string; configDir?: string; now?: Date } = {}): SetupAudit {
  const now = o.now ?? new Date();
  const since = o.since ?? new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);
  const sinceMs = parseSince(since);
  if (Number.isNaN(sinceMs)) throw new Error(`geçersiz --since: ${o.since}`);

  const tasks = listTasks({ state: ["done", "cancelled"] }).filter((t) => Date.parse(t.data.updated) >= sinceMs);
  const roles = listRolesWithWarnings().roles;
  const out: SetupAudit = {
    since,
    tasks: { total: tasks.length, ids: tasks.map((t) => t.data.id).sort(), by_role: {}, by_phase: {}, by_model: {} },
    measures: { tasks_with_measure: 0, sums: {}, by_ponytail: { on: { tasks: 0, tasks_with_measure: 0, sums: {} }, off: { tasks: 0, tasks_with_measure: 0, sums: {} } } },
    open_points: { total: 0, by_severity: {} },
    signals: {
      test_itirazi: { tasks: 0, count: 0, examples: [] }, degisiklik_istegi: { tasks: 0, count: 0, examples: [] },
      karar: { tasks: 0, count: 0, examples: [] }, izin_reddi: { tasks: 0, count: 0, examples: [] },
    },
    cancelled: { total: 0, with_reason: 0, without_reason_ids: [] },
    skills: { inventory: [], unused: [], transcripts: 0, coverage: { by_skill: [], skipped_before_rule: 0, expected: 0, loaded: 0, rate: null } },
    rules: { claude_md: null, roles: {} },
    findings: { unresolved: [], stale: 0, by_severity: {}, by_project: {}, by_source: {} },
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
    bump(out.tasks.by_model, effectiveModel(t.data, roles.find((r) => r.slug === t.data.role)));

    const closing = getSection(t.body, "## Kapanış raporu") ?? "";
    // line start only: template text ("Ölçüm satırı…") or a quoted example is not a measure
    const m = [...closing.matchAll(/^Ölçüm:(.*)$/gm)].pop();
    const arm = t.data.experiment?.ponytail;
    const armOut = arm ? out.measures.by_ponytail[arm] : undefined;
    if (armOut) armOut.tasks++;
    if (m) {
      out.measures.tasks_with_measure++;
      if (armOut) armOut.tasks_with_measure++;
      const add = (k: string, v: string) => { for (const sums of [out.measures.sums, armOut?.sums]) if (sums) sums[k] = (sums[k] ?? 0) + Number(v); };
      for (const [, k, v] of m[1].matchAll(/([a-zçğıöşü_]+)=(\d+)/gi)) add(k, v);
      const lines = /satır=\+(\d+)\/-(\d+)/i.exec(m[1]); // worker format: satır=+<eklenen>/-<silinen>
      if (lines) { add("satir_eklenen", lines[1]); add("satir_silinen", lines[2]); }
    }
    const points = /^### Açık noktalar\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(closing)?.[1] ?? "";
    for (const [, sev] of points.matchAll(/^- \[(kritik|yüksek|orta|düşük|bilgi)\]/gim)) {
      out.open_points.total++;
      bump(out.open_points.by_severity, sev.toLowerCase());
    }

    const progress = getSection(t.body, "## İlerleme") ?? "";
    const questions = getSection(t.body, "## Sorular") ?? "";
    // structural matches only: the **Soru:** line, "### Önceki rapor #N" (one per change round, reportTask), a timestamped [KARAR] line
    signal(out.signals.test_itirazi, id, matches(questions, /\*\*Soru:\*\*\s*Test itirazı:/g));
    signal(out.signals.degisiklik_istegi, id, matches(getSection(t.body, "## Önceki raporlar") ?? "", /^### Önceki rapor #\d+/gm));
    signal(out.signals.karar, id, matches(progress, /^- \S+ \[KARAR\]/gm));
    signal(out.signals.izin_reddi, id, matches(progress, /[iİ]zin reddi|permission denied/gi));

    if (t.data.state === "cancelled") {
      out.cancelled.total++;
      // no dedicated field (and `error` may be left over from an earlier failed state): a reason is a timestamped
      // İlerleme line whose text starts with iptal/İptal/cancel (optionally after [KARAR])
      if (/^- \S+ (?:\[KARAR\] )?(?:[iİ]ptal|cancel)/im.test(progress)) out.cancelled.with_reason++;
      else out.cancelled.without_reason_ids.push(id);
    }
  }
  out.cancelled.without_reason_ids.sort();

  // skills: where they live, which roles name them (by the name the role uses), how often transcripts show them loaded
  const home = getVladHome();
  const configDir = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const found = new Map<string, { source: Source; roles: Set<string>; added: string | null }>();
  for (const [dir, source] of [[".claude/skills", "repo"], ["global/skills", "global"], ["vendor/skills", "vendor"]] as const) {
    for (const n of skillDirs(join(home, dir))) found.set(n, { source, roles: new Set(), added: firstAdded(home, `${dir}/${n}`) });
  }
  for (const i of installedSkills(configDir)) if (!found.has(i.name)) found.set(i.name, { source: i.source, roles: new Set(), added: null });
  for (const r of roles) {
    for (const s of r.skills) {
      if (!found.has(s)) found.set(s, { source: "role", roles: new Set(), added: null });
      found.get(s)!.roles.add(r.slug);
    }
  }
  const usage = auditSkills({ since, configDir: o.configDir });
  const loaded: Record<string, number> = { ...usage.vlad.loaded };
  for (const t of usage.tasks) for (const s of t.scanned) loaded[s] = (loaded[s] ?? 0) + 1;
  out.skills.transcripts = usage.summary.audited;
  // transcripts record the name the worker typed (plugin:skill or bare), so usage is matched on the bare name
  out.skills.inventory = [...found]
    .map(([name, v]) => ({ name, source: v.source, roles: [...v.roles].sort(), loaded: loaded[bare(name)] ?? 0, added: v.added }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  out.skills.unused = out.skills.inventory.filter((s) => !s.loaded).map((s) => s.name);

  // rule dates and time-coherent coverage: a task is measured only against rules in force on its creation date
  out.rules.claude_md = lastChanged(home, "CLAUDE.md");
  for (const r of roles) out.rules.roles[r.slug] = lastChanged(home, `roles/${r.slug}.md`);
  const allTasks = listTasks();
  const created = new Map(allTasks.map((t) => [t.data.id, t.data.created]));
  const ponytailOff = new Set(allTasks.filter((t) => t.data.experiment?.ponytail === "off").map((t) => t.data.id)); // A/B off arm: ponytail was left out on purpose
  const rows = new Map<string, CoverageRow>();
  const cov = out.skills.coverage;
  for (const t of usage.tasks) {
    const role = roles.find((r) => r.slug === t.role);
    if (!t.transcript || !role) continue;
    for (const s of role.skills) {
      if (s === "ponytail" && ponytailOff.has(t.id)) continue;
      const key = `${role.slug}\u0000${s}`;
      const row = rows.get(key) ?? (() => {
        const at = roleSkillSince(home, `roles/${role.slug}.md`, s);
        return { role: role.slug, skill: s, since: at, since_unknown: at === null, expected_tasks: 0, loaded_tasks: 0, rate: 0 };
      })();
      rows.set(key, row);
      const made = Date.parse(created.get(t.id) ?? "");
      if (Number.isNaN(made)) continue; // no creation date: cannot be placed against the rule date, so not measured
      // since_unknown (no git history for the skill): every task is measured; the flag tells the reader the date is missing
      if (row.since && made < Date.parse(row.since)) { cov.skipped_before_rule++; continue; }
      row.expected_tasks++;
      if (t.scanned.includes(bare(s))) row.loaded_tasks++;
    }
  }
  cov.by_skill = [...rows.values()].filter((r) => r.expected_tasks).map((r) => ({ ...r, rate: r.loaded_tasks / r.expected_tasks }))
    .sort((a, b) => (a.role + a.skill < b.role + b.skill ? -1 : 1));
  cov.expected = cov.by_skill.reduce((n, r) => n + r.expected_tasks, 0);
  cov.loaded = cov.by_skill.reduce((n, r) => n + r.loaded_tasks, 0);
  cov.rate = cov.expected ? cov.loaded / cov.expected : null;

  const fs = listFindingsWithWarnings({ state: [...UNRESOLVED] }).findings;
  out.findings.unresolved = fs
    .map((f) => ({
      id: f.data.id, project: f.data.project, severity: f.data.severity, state: f.data.state, title: f.data.title,
      age_days: Math.floor((now.getTime() - Date.parse(f.data.created)) / DAY), source_task: f.data.source_task,
    }))
    .sort((a, b) => b.age_days - a.age_days || (a.id < b.id ? -1 : 1));
  out.findings.stale = out.findings.unresolved.filter((f) => f.age_days > STALE_DAYS).length;
  for (const f of out.findings.unresolved) { bump(out.findings.by_severity, f.severity); bump(out.findings.by_project, f.project); bump(out.findings.by_source, f.source_task); }
  return out;
}
