export type Autonomy = "plan" | "commit" | "pr";
export type TaskKind = "dev" | "research" | "pipeline";
export type TaskState =
  | "queued"
  | "running"
  | "blocked"
  | "stalled"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";
export type ProjectStatus = "active" | "paused" | "archived";
/** Who can reach the system: sizes the architect's `### Sistem tasarımı`. Unrelated to `local_only`. */
export type Exposure = "local" | "network" | "internet";
export type Launcher = "auto" | "wt" | "powershell" | "cloud";

/** kb/projects/<slug>.md frontmatter (spec 5.1) */
export interface ProjectCard {
  slug: string;
  name: string;
  path: string;
  /** Clone path per machine (`VLAD_MACHINE` name -> path); once set, a machine missing here has no clone. */
  paths?: Record<string, string>;
  stack: string[];
  status: ProjectStatus;
  autonomy: Autonomy;
  /** GitHub `owner/name` the cloud launcher works on; absent → no cloud launch. */
  repo?: string;
  /** Branch cloud phases start from outside a pipeline; absent → `master`. */
  default_branch?: string;
  /** Reach of the system (local | network | internet); asked from the user, never guessed from the stack. */
  exposure?: Exposure;
  /** Cannot run in the cloud (e.g. needs Windows); cloud launch fails with `local_only_reason`. */
  local_only?: boolean;
  local_only_reason?: string;
  /** Single gate command of the project (e.g. `scripts/gate.sh`); absent → no gate defined. */
  gate?: string;
  last_activity: string | null;
  last_scanned: string | null;
}

/** kb/tasks/<id>.md frontmatter (spec 5.2) */
export interface TaskData {
  id: string;
  project: string;
  title: string;
  kind: TaskKind;
  state: TaskState;
  autonomy: Autonomy;
  branch?: string | null;
  worktree?: string | null;
  session_id?: string | null;
  created: string;
  updated: string;
  error?: string | null;
  /** When /digest processed the closing report of a done task. */
  digested?: string | null;
  /** roles/<slug>.md the task is done in (roles spec §5). */
  role?: string | null;
  /** Pipeline (çatı) task this phase belongs to (pipeline spec §5). */
  parent?: string | null;
  /** Tasks under the same parent that must be done before this one starts. */
  depends_on?: string[];
  /** Human-readable phase name (spec, plan, kabul, uygulama, doğrulama, …). */
  phase?: string | null;
  /** Repo file (relative path) holding this task's full closing report; a long report travels to dependants as summary + this path. */
  report_file?: string | null;
  /** Machine the worker runs on (`currentMachine()` at launch). */
  host?: string | null;
  /** Latest worker progress; `pct` null = no percentage known. */
  progress?: TaskProgress | null;
  /** Pull request the task's branch is under. */
  pr?: TaskPr | null;
}

export interface TaskProgress {
  pct: number | null;
  label: string;
  at: string;
}

export interface TaskPr {
  number: number;
  /** GitHub `owner/name`. */
  repo: string;
  base: string;
  url?: string;
}

export type FindingSeverity = "kritik" | "yüksek" | "orta" | "düşük" | "bilgi";
export type FindingState = "open" | "deferred" | "fixed" | "wontfix";

/** kb/findings/<id>.md frontmatter (findings spec §2) */
export interface FindingData {
  /** `F-<project>-NNN`, numbered per project. */
  id: string;
  project: string;
  severity: FindingSeverity;
  state: FindingState;
  /** Task whose report raised the finding. */
  source_task: string;
  title: string;
  /** Task that fixed it; only while `state` is `fixed`. */
  fixed_by?: string | null;
  created: string;
  updated: string;
  /** When the state became `fixed`. */
  fixed?: string | null;
}

export const CARD_KINDS = ["ci_red", "conflict", "vlad_question", "action_request", "kb_conflict"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CARD_ACTION_KINDS = ["merge_phase", "merge_final", "push", "tag"] as const;
export type CardActionKind = (typeof CARD_ACTION_KINDS)[number];
/** The only options an action_request card has; an agent cannot supply its own. */
export const ACTION_OPTIONS = [{ id: "approve", label: "Onayla" }, { id: "reject", label: "Reddet" }];
export type CardState = "open" | "resolved" | "dismissed";

/** kb/cards/C-<YYYYMMDD>-<NN>.md frontmatter (mobile plan, kayıt türleri) */
export interface CardData {
  /** `C-<YYYYMMDD>-<NN>`; NN widens to three digits past 99 per day. */
  id: string;
  kind: CardKind;
  project: string;
  task: string | null;
  state: CardState;
  title: string;
  options: { id: string; label: string }[];
  /** `by_device` is taken from the CLI argument as is: only the API (verified envelope) may be trusted to supply it. */
  answer: { option?: string; text?: string; by_device: string; at: string } | null;
  /** Only for `action_request`; its repo must be the card project's registered repo. */
  action?: { kind: CardActionKind; repo: string; sha: string; pr?: number; base?: string; ref?: string };
  created: string;
  updated: string;
}

/** roles/<slug>.md frontmatter (roles spec §4) */
export interface RoleData {
  slug: string;
  title: string;
  kind: "advisory" | "executor";
  summary: string;
  /** Skills the role loads before starting (pipeline spec §8). */
  skills?: string[];
  /** Claude model the role's worker/agent runs on (`claude --model`, Agent `model`); absent → default. */
  model?: string;
}

/** kb/inbox/<ts>-<session_id>.json (spec 5.3) */
export interface InboxRecord {
  session_id: string;
  cwd: string;
  project: string | null;
  task_id: string | null;
  transcript_path: string | null;
  reason: string;
  ended: string;
  git: {
    branch: string | null;
    head: string | null;
    recent_commits: { sha: string; subject: string; date: string }[];
    changed_files: string[];
  } | null;
  excerpt: { role: "user" | "assistant"; text: string }[];
  user_message_count: number;
}

/** vlad.config.json (spec 4) */
export interface VladConfig {
  roots: string[];
  ignore: string[];
  defaultAutonomy: Autonomy;
  staleAfterHours: number;
  /** Max simultaneously `running` dev workers (all projects); absent → unlimited. */
  maxParallel?: number;
  launcher: Launcher;
  worktreeDir: string;
  /** Branch `vlad kb commit --push` pushes to when it has no upstream; absent → `origin <current branch>`. */
  kbPushBranch?: string;
  /** Per-machine overlay of roots/launcher/maxParallel/worktreeDir/kbPushBranch; applied by loadConfig. */
  machines?: Record<string, MachineConfig>;
  /** Oldest CLI version allowed to use this home; older CLIs stop with `VLAD CLI çok eski`. */
  minCliVersion?: string;
  projects: Record<string, { autonomy?: Autonomy }>;
}

export type MachineConfig = Partial<Pick<VladConfig, "roots" | "launcher" | "maxParallel" | "worktreeDir" | "kbPushBranch">>;

/** One line of kb/audit/YYYY-MM.jsonl (mobile plan, kayıt şemaları). */
export interface AuditData {
  ts: string;
  /** Unique across all months. */
  action_id: string;
  kind: string;
  repo: string;
  pr: number;
  head_sha: string;
  approver: { type: "device" | "grant"; id: string };
  result: string;
  merge_sha?: string;
  detail?: string;
}
