import { Command } from "commander";
import { createKit } from "./kit.js";
import { helpOf } from "./ctx.js";
import type { CliCtx } from "./ctx.js";
import { registerProject } from "./groups/project.js";
import { registerFinding } from "./groups/finding.js";
import { registerIdea } from "./groups/idea.js";
import { registerRole } from "./groups/role.js";
import { registerTask } from "./groups/task.js";
import { registerStatus } from "./groups/status.js";
import { registerMode } from "./groups/mode.js";
import { registerAudit } from "./groups/audit.js";
import { registerInbox } from "./groups/inbox.js";
import { registerDecision } from "./groups/decision.js";
import { registerJournal } from "./groups/journal.js";
import { registerKb } from "./groups/kb.js";
import { registerSession } from "./groups/session.js";
import { registerAgent } from "./groups/agent.js";
import { registerMachine } from "./groups/machine.js";
import { registerTransfer } from "./groups/transfer.js";
import { registerInstall } from "./groups/install.js";

export { failWith, handleParseError, pendingHelpOf } from "./ctx.js";
export type { CliCtx } from "./ctx.js";
export { KB_WRITES, REFRESH_KEYS } from "./policy.js";

/** Builds the whole command tree; parses nothing and keeps no module-level state, so two calls are independent. */
export function buildProgram(ctx: CliCtx): Command {
  const kit = createKit(ctx);
  // commander writes the help of a bare group ("vlad", "vlad task") to writeErr before throwing
  // commander.help; keep it so the catch below can show it instead of a bare "(outputHelp)" error.
  let pendingHelp = "";
  const program = new Command();
  helpOf.set(program, () => pendingHelp);
  program
    .name("vlad")
    .description("VLAD: Claude Code orkestratörü")
    .exitOverride()
    .configureOutput({ writeErr: (str) => { pendingHelp += str; } });

  registerProject(program, kit);
  registerFinding(program, kit);
  registerIdea(program, kit);
  registerRole(program, kit);
  registerTask(program, kit);
  registerStatus(program, kit);
  registerMode(program, kit);
  registerAudit(program, kit);
  registerInbox(program, kit);
  registerDecision(program, kit);
  registerJournal(program, kit);
  registerKb(program, kit);
  registerSession(program, kit);
  registerAgent(program, kit);
  registerMachine(program, kit);
  registerTransfer(program, kit);
  registerInstall(program, kit);
  return program;
}
