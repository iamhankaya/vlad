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
  /** Cannot run in the cloud (e.g. needs Windows); cloud launch fails with `local_only_reason`. */
  local_only?: boolean;
  local_only_reason?: string;
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
  launcher: Launcher;
  worktreeDir: string;
  projects: Record<string, { autonomy?: Autonomy }>;
}
