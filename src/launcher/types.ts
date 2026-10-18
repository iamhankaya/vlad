export interface LaunchRequest {
  taskId: string;
  cwd: string; // worktree yolu
  prompt: string; // başlangıç prompt'u
  env: Record<string, string>; // VLAD_TASK_ID vb.
  title: string; // pencere/sekme başlığı
  model?: string; // claude --model; yoksa varsayılan model
}
export interface LaunchResult {
  ok: boolean;
  method: string;
  detail?: string;
}
export interface Launcher {
  launch(req: LaunchRequest): Promise<LaunchResult>;
}
