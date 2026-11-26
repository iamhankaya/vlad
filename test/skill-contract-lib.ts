import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Command } from "commander";
import { buildProgram } from "../src/cli/program.js";

// T20261126-15: shared helpers of the skill/doc text <-> CLI contract tests (test/skills/skill-cli-contract.test.ts, test/cli/skill-json-contract.test.ts).
export const root = resolve(import.meta.dirname, "..");
export const prog: Command = buildProgram({ stdout: { write: () => true }, stderr: { write: () => true }, env: {}, cliPath: "cli.js" } as never);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}
const mdIn = (d: string) => walk(join(root, d));
// Third-party skills (design/security/superpowers copies) are not VLAD text; docs/superpowers (historical specs) is not scanned (only docs/*.md).
const THIRD_PARTY = /\.claude\/skills\/(design-taste-frontend|impeccable|ui-ux-pro-max|security-audit|brainstorming|requesting-code-review|systematic-debugging|test-driven-development|verification-before-completion|writing-plans)\//;
export const TEXT_FILES = [
  join(root, "CLAUDE.md"),
  ...readdirSync(join(root, "docs")).filter((n) => n.endsWith(".md")).map((n) => join(root, "docs", n)),
  ...mdIn(".claude/skills"), ...mdIn("global/skills"), ...mdIn("roles"),
].filter((f) => !THIRD_PARTY.test(f));

export const find = (c: Command, ...p: string[]): Command | undefined => p.reduce<Command | undefined>((a, n) => a?.commands.find((x) => x.name() === n), c);
export const flagsOf = (c: Command): Set<string> => {
  const s = new Set<string>(["--help"]);
  for (let x: Command | null = c; x; x = x.parent) for (const o of x.options) if (o.long) s.add(o.long);
  return s;
};

export interface Call { file: string; line: number; path: string[]; flags: string[]; text: string; lineText: string }

/** `vlad <komut> [alt-komut] --bayrak` calls inside backtick spans / fenced code. */
export function extractCalls(file: string, body: string): Call[] {
  const calls: Call[] = [];
  let fenced = false;
  let carry = "";
  body.split("\n").forEach((rawLine, i) => {
    if (/^\s*(```|~~~)/.test(rawLine)) { fenced = !fenced; carry = ""; return; }
    // fenced shell blocks: join `\` continuation lines (the call is reported at its last line)
    if (fenced && /\\\s*$/.test(rawLine)) { carry += rawLine.replace(/\\\s*$/, " "); return; }
    const line = fenced ? carry + rawLine : rawLine;
    carry = "";
    const segs = fenced ? [line.replace(/(^|\s)#\s.*$/, "")] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const seg of segs) {
      for (const m of seg.matchAll(/(?:^|[\s($])vlad ([a-z][a-z-]*(?: [a-z][a-z-]*)*)([^|;&)]*)/g)) {
        const words = m[1].split(" ");
        let cur: Command | undefined = prog; const path: string[] = [];
        for (const w of words) { const n: Command | undefined = cur.commands.find((x) => x.name() === w); if (!n) break; cur = n; path.push(w); }
        const rest = m[1].split(" ").slice(path.length).join(" ") + " " + m[2];
        const file_ = relative(root, file);
        const flagsIn = (t: string) => [...t.matchAll(/(?:^|\s)(--[A-Za-z][\w-]*)/g)].map((x) => x[1]);
        // a group node (has subcommands) followed by a lowercase word that is no subcommand = renamed/unknown subcommand (leaf words are arguments)
        const unknownSub = cur.commands.length > 0 && words[path.length] !== undefined ? words[path.length] : undefined;
        if (unknownSub) { calls.push({ file: file_, line: i + 1, path: [...path, `?${unknownSub}`], flags: [], text: seg, lineText: line }); }
        if (path.join(" ") === "mode request") {
          // `mode request [--wait ...] <komut> [argümanlar]`: bayraklar komuttan önce isteğe, sonra istenen komuta aittir.
          const toks = rest.trim().split(/\s+/).filter(Boolean);
          let k = 0; const own: string[] = [];
          while (k < toks.length && toks[k].startsWith("--")) { own.push(toks[k]); k += toks[k] === "--wait-seconds" ? 2 : 1; }
          calls.push({ file: file_, line: i + 1, path, flags: own, text: seg, lineText: line });
          const inner = toks.slice(k); let c2: Command | undefined = prog; const p2: string[] = [];
          for (const w of inner) { const n: Command | undefined = c2.commands.find((x) => x.name() === w); if (!n) break; c2 = n; p2.push(w); }
          if (p2.length) calls.push({ file: file_, line: i + 1, path: p2, flags: flagsIn(inner.slice(p2.length).join(" ")), text: seg, lineText: line });
          continue;
        }
        calls.push({ file: file_, line: i + 1, path, flags: flagsIn(rest), text: seg, lineText: line });
      }
    }
  });
  return calls;
}
