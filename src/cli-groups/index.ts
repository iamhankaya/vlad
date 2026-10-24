import type { Command } from "commander";
import { registerActive } from "./active.js";
import { registerAudit } from "./audit.js";
import { registerCard } from "./card.js";
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
  registerCard,
  registerRole,
  registerTask,
  registerStatus,
  registerKb,
  registerQuota,
  registerAudit,
  registerActive,
  registerVault,
  registerExt,
];

export function registerAll(program: Command): void {
  for (const register of groups) register(program);
}
