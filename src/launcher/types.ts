export interface LaunchRequest {
  taskId: string;
  cwd: string; // worktree yolu
  prompt: string; // başlangıç prompt'u
  env: Record<string, string>; // VLAD_TASK_ID vb.
  title: string; // pencere/sekme başlığı
  model?: string; // claude --model; yoksa varsayılan model
  autoCompact?: string; // claude --autocompact (ör. "300k"); yoksa bayrak eklenmez
  resume?: { sessionId?: string }; // önceki oturumu sürdür: claude --resume <id>, id yoksa --continue
}
export interface LaunchResult {
  ok: boolean;
  method: string;
  detail?: string;
  /** External mode only: the written worker script, the command that runs it, and its working directory. */
  script?: string;
  command?: string;
  cwd?: string;
  /** Desktop-queue mode only: the queue file written for vlad-desktop. */
  queued?: string;
}
export interface Launcher {
  launch(req: LaunchRequest): Promise<LaunchResult>;
}
