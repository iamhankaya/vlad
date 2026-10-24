import type { Command } from "commander";
import { registerExt } from "./ext.js";
import { registerFinding } from "./finding.js";
import { registerKb } from "./kb.js";
import { registerProject } from "./project.js";
import { registerQuota } from "./quota.js";
import { registerRole } from "./role.js";
import { registerStatus } from "./status.js";
import { registerTask } from "./task.js";
import { registerVault } from "./vault.js";

/**
 * Command groups in help order. Each slice adds only its own import and its own array line
 * (alphabetical); cli.ts itself stays untouched.
 */
const groups: ((program: Command) => void)[] = [
  registerProject,
  registerFinding,
  registerRole,
  registerTask,
  registerStatus,
  registerKb,
  registerQuota,
  registerVault,
  registerExt,
];

export function registerAll(program: Command): void {
  for (const register of groups) register(program);
}
