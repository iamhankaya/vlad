import type { Command } from "commander";
import { createKit } from "./kit.js";
import type { CliCtx } from "./ctx.js";
import { rootCommand } from "./root.js";

type Register = (program: Command, kit: ReturnType<typeof createKit>) => void;

/**
 * Top-level command → its group module (T20261126-25): `vlad <komut> …` imports one group instead of all 21 (~20-30 ms
 * per call). A test keeps it equal to `buildProgram`'s command list; a new group must be added here too.
 */
export const GROUP_OF: Record<string, () => Promise<Register>> = {
  scan: async () => (await import("./groups/project.js")).registerProject,
  project: async () => (await import("./groups/project.js")).registerProject,
  finding: async () => (await import("./groups/finding.js")).registerFinding,
  idea: async () => (await import("./groups/idea.js")).registerIdea,
  role: async () => (await import("./groups/role.js")).registerRole,
  task: async () => (await import("./groups/task.js")).registerTask,
  status: async () => (await import("./groups/status.js")).registerStatus,
  mode: async () => (await import("./groups/mode.js")).registerMode,
  audit: async () => (await import("./groups/audit.js")).registerAudit,
  inbox: async () => (await import("./groups/inbox.js")).registerInbox,
  digest: async () => (await import("./groups/inbox.js")).registerInbox,
  decision: async () => (await import("./groups/decision.js")).registerDecision,
  journal: async () => (await import("./groups/journal.js")).registerJournal,
  kb: async () => (await import("./groups/kb.js")).registerKb,
  session: async () => (await import("./groups/session.js")).registerSession,
  agent: async () => (await import("./groups/agent.js")).registerAgent,
  queue: async () => (await import("./groups/agent.js")).registerAgent,
  remote: async () => (await import("./groups/agent.js")).registerAgent,
  machine: async () => (await import("./groups/machine.js")).registerMachine,
  send: async () => (await import("./groups/transfer.js")).registerTransfer,
  clip: async () => (await import("./groups/transfer.js")).registerTransfer,
  install: async () => (await import("./groups/install.js")).registerInstall,
  setup: async () => (await import("./groups/setup.js")).registerSetup,
  approver: async () => (await import("./groups/approver.js")).registerApprover,
  monitor: async () => (await import("./groups/monitor.js")).registerMonitor,
  worktree: async () => (await import("./groups/worktree.js")).registerWorktree,
  history: async () => (await import("./groups/history.js")).registerHistory,
};

/**
 * The command tree for this argv: only the named command's group when argv[2] is a known top-level command, the full
 * tree otherwise (bare `vlad`, `--help`, `help <x>`, a leading option, an unknown/mistyped command: its suggestion needs
 * every name). Help and errors of a group do not depend on its sibling groups, so the output is the same.
 */
export async function programFor(ctx: CliCtx): Promise<Command> {
  const name = ctx.argv[2];
  const load = name !== undefined && Object.hasOwn(GROUP_OF, name) ? GROUP_OF[name] : undefined;
  if (!load) return (await import("./program.js")).buildProgram(ctx);
  const program = rootCommand();
  (await load())(program, createKit(ctx));
  return program;
}
