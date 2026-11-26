import { Command } from "commander";
import { helpOf } from "./ctx.js";

/** The bare `vlad` command both the full tree (`buildProgram`) and the one-group tree (`programFor`) start from. */
export function rootCommand(): Command {
  // commander writes the help of a bare group ("vlad", "vlad task") to writeErr before throwing
  // commander.help; keep it so handleParseError can show it instead of a bare "(outputHelp)" error.
  let pendingHelp = "";
  const program = new Command();
  helpOf.set(program, () => pendingHelp);
  program
    .name("vlad")
    .description("VLAD: Claude Code orkestratörü")
    .exitOverride()
    .enablePositionalOptions()
    .configureOutput({ writeErr: (str) => { pendingHelp += str; } });
  return program;
}
