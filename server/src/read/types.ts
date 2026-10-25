/** Shapes of `vlad ... --json` output (src/kb/types.ts) and of the API (contract/openapi.yaml) the read layer maps between. */
export type TaskState = "queued" | "running" | "blocked" | "stalled" | "awaiting_approval" | "done" | "failed" | "cancelled";
export interface Progress { pct: number | null; label: string; at: string }
export interface PullRequestRef { number: number; repo: string; base: string; url?: string }

export interface TaskData {
  id: string; project: string; title: string; kind: "dev" | "research" | "pipeline"; state: TaskState; autonomy: "plan" | "commit" | "pr";
  created: string; updated: string;
  error?: string | null; role?: string | null; parent?: string | null; depends_on?: string[]; phase?: string | null;
  host?: string | null; progress?: Progress | null; pr?: PullRequestRef | null;
  [k: string]: unknown;
}

export interface CardData {
  id: string; kind: string; project: string; task: string | null; state: string; title: string;
  options: { id: string; label: string }[];
  answer: { option?: string; text?: string; by_device: string; at: string } | null;
  action?: { kind: string; repo: string; sha: string; pr?: number; base?: string; ref?: string };
  kb_conflict?: { key: string; reason: string; source: string; head: string; base: string; paths: string[]; rules?: string[] };
  created: string; updated: string;
}

export interface GateInfo {
  task_id: string; phase?: string | null; pr: PullRequestRef; head_sha: string; ci: "green" | "red" | "pending" | "none";
  mergeable: boolean | null; report_md: string; merge_kind?: "merge_phase" | "merge_final";
  reviews: { source: string; verdict: "clear" | "findings" | "unknown"; summary?: string }[];
}

/** Live PR facts for a task waiting for approval (GitHub; wired by the approval path). Null = not known. */
export type GateProvider = (task: TaskData, reportMd: string) => Promise<Omit<GateInfo, "task_id" | "phase" | "report_md"> | null>;
