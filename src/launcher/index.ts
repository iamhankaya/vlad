export * from "./types.js";
export * from "./terminal.js";
export * from "./mode.js";
export * from "./process.js";

import { closeWorkerProcess } from "./process.js";
import { closeWorkerWindow } from "./terminal.js";

/** Stops a task's worker: the terminal window on Windows, the systemd unit elsewhere. */
export function closeWorker(taskId: string): void {
  if (process.platform === "win32") closeWorkerWindow(taskId);
  else closeWorkerProcess(taskId);
}
