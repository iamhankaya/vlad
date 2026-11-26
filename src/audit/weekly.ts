const DAY = 86_400_000;

/** Per-role / per-project counts inside one week. */
export interface WeekCounts { tasks: number; review_bulgusu: number; degisiklik_istegi: number; izin_reddi: number }
/**
 * One ISO week (Monday, UTC) of the audited range. Rates are per task: `review_bulgusu_per_task` divides by `measured`
 * (tasks whose closing report carries an Ölçüm line), the other two by `tasks`; null when the denominator is 0.
 * Tasks bucket by `updated` (the audit window key), findings by `created` (opened) and `updated` (closed = fixed|wontfix).
 * `rules_changed`: rule files (CLAUDE.md, roles/<slug>.md) with a commit that week.
 */
export interface WeekRow extends WeekCounts {
  week: string;
  measured: number;
  review_bulgusu_per_task: number | null;
  degisiklik_istegi_per_task: number | null;
  izin_reddi_per_task: number | null;
  findings_opened: number;
  findings_closed: number;
  rules_changed: string[];
  by_role: Record<string, WeekCounts>;
  by_project: Record<string, WeekCounts>;
  /** by the task's effective model (task model ?? role model; "-" = none), e.g. opus phases vs the default */
  by_model: Record<string, WeekCounts>;
}

export interface WeeklyTask { at: string; model: string | null; role: string | null | undefined; project: string; measured: boolean; review: number; changes: number; denials: number }
export interface WeeklyFinding { created: string; updated: string; state: string }

/** Monday (UTC) of the week containing the timestamp, `YYYY-MM-DD`; null for an unparsable date. */
export function weekStart(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY).toISOString().slice(0, 10);
}

const zero = (): WeekCounts => ({ tasks: 0, review_bulgusu: 0, degisiklik_istegi: 0, izin_reddi: 0 });
const rate = (n: number, d: number) => (d ? n / d : null);

/** Weekly series for `vlad audit setup`: sorted by week, only weeks with a task, a finding event or a rule change; `sinceMs` bounds the finding events. */
export function buildWeekly(o: { tasks: WeeklyTask[]; findings: WeeklyFinding[]; rules: Record<string, string[]>; sinceMs: number }): WeekRow[] {
  const rows = new Map<string, WeekRow>();
  const row = (week: string): WeekRow => {
    let r = rows.get(week);
    if (!r) {
      r = { week, ...zero(), measured: 0, review_bulgusu_per_task: null, degisiklik_istegi_per_task: null, izin_reddi_per_task: null, findings_opened: 0, findings_closed: 0, rules_changed: [], by_role: {}, by_project: {}, by_model: {} };
      rows.set(week, r);
    }
    return r;
  };
  for (const t of o.tasks) {
    const w = weekStart(t.at);
    if (!w) continue;
    const r = row(w);
    if (t.measured) r.measured++;
    for (const c of [r, (r.by_role[t.role || "-"] ??= zero()), (r.by_project[t.project] ??= zero()), (r.by_model[t.model || "-"] ??= zero())]) {
      c.tasks++; c.review_bulgusu += t.review; c.degisiklik_istegi += t.changes; c.izin_reddi += t.denials;
    }
  }
  for (const f of o.findings) {
    const opened = Date.parse(f.created) >= o.sinceMs ? weekStart(f.created) : null;
    if (opened) row(opened).findings_opened++;
    const closed = (f.state === "fixed" || f.state === "wontfix") && Date.parse(f.updated) >= o.sinceMs ? weekStart(f.updated) : null;
    if (closed) row(closed).findings_closed++;
  }
  for (const [file, dates] of Object.entries(o.rules)) {
    for (const d of dates) {
      const w = weekStart(d);
      if (w && Date.parse(d) >= o.sinceMs && !row(w).rules_changed.includes(file)) row(w).rules_changed.push(file);
    }
  }
  const out = [...rows.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  for (const r of out) {
    r.rules_changed.sort();
    r.review_bulgusu_per_task = rate(r.review_bulgusu, r.measured);
    r.degisiklik_istegi_per_task = rate(r.degisiklik_istegi, r.tasks);
    r.izin_reddi_per_task = rate(r.izin_reddi, r.tasks);
  }
  return out;
}
