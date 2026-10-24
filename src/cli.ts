#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { registerAll } from "./cli-groups/index.js";
import { fail } from "./cli-util.js";
import { checkMinCliVersion, getVladHome } from "./kb/index.js";

// commander writes the help of a bare group ("vlad", "vlad task") to writeErr before throwing
// commander.help; keep it so the catch below can show it instead of a bare "(outputHelp)" error.
let pendingHelp = "";
const program = new Command();
program
  .name("vlad")
  .description("VLAD: Claude Code orkestratörü")
  .exitOverride()
  .configureOutput({ writeErr: (str) => { pendingHelp += str; } })
  // every command first checks that this CLI is new enough for the VLAD home's schemas
  .hook("preAction", () => checkMinCliVersion(getVladHome()));

registerAll(program);

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) process.exit(0); // --help / --version
    if (e.code === "commander.help" || e.code === "commander.helpDisplayed") {
      process.stderr.write(pendingHelp); // bare group without subcommand
      process.exit(1);
    }
    fail(new Error(e.message.replace(/^error: /, "")));
  }
  fail(e);
}
