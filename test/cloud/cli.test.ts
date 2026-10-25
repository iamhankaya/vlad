import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
let home: string;

beforeEach(() => {
  home = makeHome();
  mkdirSync(join(home, "roles"), { recursive: true });
  writeFileSync(join(home, "card.md"), `---
slug: alpha
name: Alpha
path: "C:\\\\dev\\\\alpha"
stack: [ts]
status: active
autonomy: commit
repo: owner/alpha
last_activity: null
last_scanned: null
---

## Özet
x
`);
});

function vlad(args: string[], input?: string, env: Record<string, string> = {}) {
  const r = spawnSync("node", [cli, ...args], {
    encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home, CLAUDE_CODE_REMOTE: "", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const CLOUD = { CLAUDE_CODE_REMOTE: "true" };
function newTask(): string {
  expect(vlad(["project", "write", "alpha", "--file", join(home, "card.md")]).code).toBe(0);
  writeFileSync(join(home, "body.md"), "## Tanım\nx\n");
  return JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", join(home, "body.md"), "--json"], undefined, CLOUD).out).id;
}

describe("cloud CLI", () => {
  it("launch --json in a cloud env returns create_session arguments and runs the task", () => {
    const id = newTask();
    expect(id).toMatch(/-51$/);
    const r = vlad(["task", "launch", id, "--json"], undefined, CLOUD);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ mode: "cloud", repo: "owner/alpha", outcome_branch: `vlad/${id}`, worktree: null, state: "running" });
    expect(vlad(["task", "list", "--state", "running", "--json"]).out).toContain(id);
  });

  // S2a: auto on Linux outside the cloud now means the systemd process launcher instead of a "bulut algılanmadı"
  // error. This card's path is a Windows path, so the launch still fails (before any launcher runs) and stays queued.
  it("launch outside the cloud on a non-Windows host no longer reports a missing cloud and stays queued on failure", () => {
    const id = newTask();
    const r = vlad(["task", "launch", id, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).not.toMatch(/bulut algılanmadı/);
    expect(vlad(["task", "list", "--state", "queued", "--json"]).out).toContain(id);
  });

  it("launch with a card lacking repo fails clearly in the cloud", () => {
    newTask();
    writeFileSync(join(home, "card.md"), readFileSync(join(home, "card.md"), "utf8").replace("repo: owner/alpha\n", ""));
    vlad(["project", "write", "alpha", "--file", join(home, "card.md")]);
    const id = JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "U", "--kind", "dev", "--body-file", join(home, "body.md"), "--json"], undefined, CLOUD).out).id;
    const r = vlad(["task", "launch", id, "--json"], undefined, CLOUD);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/repo: owner\/name/);
  });

  it("ingest reads list_events JSON from a file or stdin and is idempotent", () => {
    const id = newTask();
    vlad(["task", "launch", id, "--json"], undefined, CLOUD);
    const events = JSON.stringify({ data: [
      { type: "user", message: { content: "[VLAD:LOG #1] örnek" } },
      { type: "assistant", message: { content: [{ type: "text", text: "[VLAD:LOG #1] gerçek adım" }] } },
    ] });
    const f = join(home, "events.json");
    writeFileSync(f, events);
    const a = vlad(["task", "ingest", id, "--file", f, "--json"]);
    expect(a.code, a.err).toBe(0);
    expect(JSON.parse(a.out).processed).toEqual([{ seq: 1, kind: "LOG" }]);
    const b = vlad(["task", "ingest", id, "--json"], events);
    expect(JSON.parse(b.out)).toMatchObject({ processed: [], skipped: [1] });
    expect(vlad(["task", "list", "--json"]).out).toContain(id);
  });
});
