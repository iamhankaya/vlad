import type { TaskState } from "../kb/index.js";

/** Spec §5.2 izin verilen geçişler. */
export const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ["running", "cancelled"],
  running: ["blocked", "awaiting_approval", "failed", "stalled", "cancelled"],
  blocked: ["running", "cancelled"],
  stalled: ["running", "cancelled"],
  awaiting_approval: ["done", "running", "cancelled"],
  failed: ["queued", "cancelled"],
  done: [],
  cancelled: [],
};

export class TransitionError extends Error {
  constructor(public from: TaskState, public to: TaskState) {
    const allowed = TRANSITIONS[from] ?? [];
    super(
      `geçersiz geçiş: ${from} → ${to}; izin verilenler: ${allowed.length ? allowed.join(", ") : "(yok)"}`,
    );
    this.name = "TransitionError";
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}
