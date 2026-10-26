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
/** How a cloud worker gets its task text: clones vlad-kb read-only, or receives it inline in the prompt. */
export type CloudKb = "readonly" | "inline";
export type Launcher = "auto" | "wt" | "powershell" | "cloud";

/** kb/projects/<slug>.md frontmatter (spec 5.1) */
export interface ProjectCard {
  slug: string;
  name: string;
  path: string;
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
export type TaskModel = "haiku" | "sonnet" | "opus";

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
  /** Model this task's worker runs on; overrides the role's `model`. Absent → the role's, then the default. */
  model?: TaskModel | null;
  /** Why this task needs `model`; required for `opus`. */
  model_reason?: string | null;
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
  /** Minutes without a task-file update or transcript write before a local worker counts as silent (default 15). */
  workerSilentMinutes?: number;
  /** Max simultaneously `running` dev workers (all projects); absent → unlimited. */
  maxParallel?: number;
  launcher: Launcher;
  worktreeDir: string;
  /** kb checkout (relative to VLAD_HOME or absolute); default <home>/kb. */
  kbDir?: string;
  /** Cloud worker kb access; absent → `inline`. */
  cloudKb?: CloudKb;
  projects: Record<string, { autonomy?: Autonomy }>;
}
