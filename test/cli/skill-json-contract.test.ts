import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";
import { TEXT_FILES, extractCalls, type Call } from "../skill-contract-lib.js";

// T20261126-15: JSON field references in skill/doc text (`summary.state`, `→ \`alan\``, `kbLint: {count, byCode, at}`) ↔ the real `--json` output
// of the commands the skills read (project status, status --summary, decision list, audit setup, task list, kb search), taken from a seeded temp home.

const CMDS: Record<string, string[]> = {
  "project status": ["project", "status", "alpha"],
  "status": ["status", "--summary"],
  "decision list": ["decision", "list", "--project", "alpha", "--all"],
  "audit setup": ["audit", "setup"],
  "task list": ["task", "list", "--full"],
  "kb search": ["kb", "search", "Mimari", "--project", "alpha"],
  "mode status": ["mode", "status"],
};

/** Dotted paths of a JSON value; arrays are flattened (no index), so `tasks.id` covers every element. Every prefix is a path too. */
export function pathsOf(v: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) pathsOf(x, prefix, out); return out; }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); pathsOf(x, p, out); }
  }
  return out;
}

/** Field references on a line that names one of the tracked commands. */
export function fieldRefs(line: string): string[] {
  const refs: string[] = [];
  for (const m of line.matchAll(/`([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)`/g)) {
    if (/\.(md|json|ts|js|ps1|sh|yml|yaml|txt|exe)$/.test(m[1])) continue; // file names, not fields
    refs.push(m[1]);
  }
  for (const m of line.matchAll(/`([A-Za-z_]\w*): \{([^}`]+)\}`/g)) { refs.push(m[1]); for (const k of m[2].split(",")) refs.push(`${m[1]}.${k.trim()}`); }
  return refs;
}

/** Documented exceptions (gerekçeli): key `<dosya>|<alan yolu>`. */
export const FIELD_ALLOW: Record<string, string> = {
  "docs/claude-ayrinti.md|create_session.model": "Claude bulut API parametresi (create_session aracı), vlad CLI çıktısı değil; aynı satırda `task list` effective_model anlatılıyor.",
};

describe("skill/doc text ↔ CLI: JSON alan sözleşmesi", { timeout: 120_000 }, () => {
  const shapes: Record<string, Set<string>> = {};
  beforeAll(() => {
    const home = makeHome();
    const run = (args: string[], input?: string) => {
      const r = spawnVlad({ args: [...args, "--json"], input, cwd: home, timeoutMs: 90_000, env: { VLAD_HOME: home } });
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      return JSON.parse(r.stdout);
    };
    run(["project", "write", "alpha", "--file", "-"], "---\nslug: alpha\nname: Alpha\npath: /tmp/alpha\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n");
    const taskId = run(["task", "new", "--project", "alpha", "--title", "Mimari görev", "--kind", "dev", "--body-file", "-"], "## Tanım\nx\n").id as string;
    run(["finding", "add", "--project", "alpha", "--severity", "orta", "--title", "Mimari bulgu", "--source", "T20261101-01"], "");
    run(["decision", "add", "--project", "alpha", "--title", "Mimari karar", "--body-file", "-"], "- **Karar:** x");
    run(["project", "summary", "alpha", "--file", "-"], "Özet metni");
    run(["mode", "night", "--until-task", taskId, "--push", "--except", "deploy", "--note", "test"]);
    for (const [name, args] of Object.entries(CMDS)) shapes[name] = pathsOf(run(args));
  });

  const calls = TEXT_FILES.flatMap((f) => extractCalls(f, readFileSync(f, "utf8")));
  const tracked = (c: Call) => (c.path.join(" ") in CMDS ? c.path.join(" ") : "");

  it("izlenen komutların örnek çıktısı boş değil (zengin tohum)", () => {
    for (const n of Object.keys(CMDS)) expect(shapes[n].size, n).toBeGreaterThan(3);
    expect(shapes["task list"].has("tasks.id")).toBe(true);
    expect(shapes["decision list"].has("decisions.id")).toBe(true);
    expect(shapes["kb search"].has("hits.id")).toBe(true);
  });

  it("izlenen bir komutun yazıldığı satırdaki alan atıfları gerçek çıktıda var", () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    let checked = 0;
    for (const c of calls) {
      if (!tracked(c) || seen.has(`${c.file}:${c.line}`)) continue;
      seen.add(`${c.file}:${c.line}`);
      const names = new Set(calls.filter((x) => x.file === c.file && x.line === c.line).map(tracked).filter(Boolean));
      // `project status` written without the `vlad` prefix still names that command's output
      for (const k of Object.keys(CMDS)) if (k.includes(" ") && c.lineText.includes(`\`${k}`)) names.add(k);
      for (const ref of fieldRefs(c.lineText)) {
        checked++;
        const ok = [...names].some((n) => shapes[n].has(ref));
        if (!ok && !((`${c.file}|${ref}`) in FIELD_ALLOW)) bad.push(`${c.file}:${c.line} \`${ref}\` (${[...names].join(", ")})`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(bad).toEqual([]);
  });

  it("yakalama: var olmayan alan atfı kırmızı çıkar, var olan geçer", () => {
    expect(fieldRefs("`vlad project status x --json` → `summary.yok` ve `summary.state`")).toEqual(["summary.yok", "summary.state"]);
    expect(shapes["project status"].has("summary.state")).toBe(true);
    expect(shapes["project status"].has("summary.yok")).toBe(false);
    expect(fieldRefs("`kbLint: {count, byCode, at}`")).toEqual(["kbLint", "kbLint.count", "kbLint.byCode", "kbLint.at"]);
  });
});
