import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "./helpers.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
let home: string;

beforeEach(() => { home = makeHome(); });

function vlad(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync("node", [cli, ...args], {
    encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home, ...extraEnv },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const mkTask = () => {
  const body = join(home, "body.md");
  writeFileSync(body, "## Tanım\nx\n");
  return JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", body, "--json"]).out).id as string;
};

function writeCard(repo: string) {
  const f = join(home, "card.md");
  writeFileSync(f, `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`);
  expect(vlad(["project", "write", "alpha", "--file", f, "--json"]).code).toBe(0);
}

describe("vlad cli", { timeout: 30_000 }, () => {
  it("has a shebang", () => {
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
  it("task new --json returns the id", () => {
    const r = vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).id).toMatch(/^T\d{8}-01$/);
  });
  it("task new warns (not fails) about task ids in the body that are not in the kb", () => {
    const known = mkTask();
    const body = `## Tanım\n${known} var, T20251025-100 yok, T20251025-100 tekrar, T20251025-101 de yok\n`;
    const args = ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-"];
    const r = vlad([...args, "--json"], body);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.id).toMatch(/^T\d{8}-02$/);
    expect(j.warnings).toEqual([expect.stringContaining("T20251025-100"), expect.stringContaining("T20251025-101")]);
    expect(vlad(args, body).out).toContain("uyarı:");
    expect(JSON.parse(vlad([...args, "--json"], "## Tanım\nx\n").out).warnings).toEqual([]);
  });
  it("invalid transition exits 1 with JSON error on stderr", () => {
    const id = mkTask();
    const r = vlad(["task", "set", id, "done", "--json"]);
    expect(r.code).toBe(1);
    const e = JSON.parse(r.err);
    expect(e.error).toMatch(/geçersiz geçiş/);
    expect(Array.isArray(e.details)).toBe(true);
  });
  it("status --summary prints the one-line summary", () => {
    mkTask();
    const r = vlad(["status", "--summary"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("İşlenmemiş 0 rapor, 0 aktif görev (0 onay bekliyor, 0 takıldı, 0 soru soruyor, 0 hatalı)");
  });
  it("status --summary --hook prints SessionStart hook JSON shown to user and model", () => {
    mkTask();
    const r = vlad(["status", "--summary", "--hook"]);
    expect(r.code).toBe(0);
    const line = "İşlenmemiş 0 rapor, 0 aktif görev (0 onay bekliyor, 0 takıldı, 0 soru soruyor, 0 hatalı)";
    expect(JSON.parse(r.out)).toEqual({
      systemMessage: `VLAD: ${line}`,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line },
    });
  });
  it("status --summary counts failed tasks and --json carries the failed list", () => {
    const a = mkTask();
    const b = mkTask();
    const f = (id: string) => join(home, "kb", "tasks", readdirSync(join(home, "kb", "tasks")).find((n) => n.startsWith(id))!);
    writeFileSync(f(a), readFileSync(f(a), "utf8").replace(/^state: queued\r?$/m, "state: failed"));
    writeFileSync(f(b), readFileSync(f(b), "utf8").replace(/^error: .*\r?$/m, "error: kırıldı"));
    const r = vlad(["status", "--summary"]);
    expect(r.out.trim()).toBe("İşlenmemiş 0 rapor, 0 aktif görev (0 onay bekliyor, 0 takıldı, 0 soru soruyor, 2 hatalı)");
    const j = JSON.parse(vlad(["status", "--summary", "--json"]).out);
    expect(j.failed.map((t: { id: string }) => t.id).sort()).toEqual([a, b].sort());
  });
  it("finding add/list/set round-trip, filters, status --summary count and error format", () => {
    const detail = join(home, "d.md");
    writeFileSync(detail, "ayrıntı\n");
    writeFileSync(join(home, "kb", "projects", "alpha.md"), "---\nslug: alpha\n---\n");
    const add = (sev: string, extra: string[] = []) =>
      vlad(["finding", "add", "--project", "alpha", "--severity", sev, "--source", "T20261022-01", "--title", `b-${sev}`, ...extra, "--json"]);
    const a = add("kritik", ["--detail-file", detail]);
    expect(a.code, a.err).toBe(0);
    expect(JSON.parse(a.out).id).toBe("F-alpha-001");
    expect(JSON.parse(add("orta", ["--state", "deferred"]).out).id).toBe("F-alpha-002");
    const all = JSON.parse(vlad(["finding", "list", "--json"]).out);
    expect(all.findings.map((f: { id: string }) => f.id)).toEqual(["F-alpha-001", "F-alpha-002"]);
    expect(all.findings[0].detail).toBe("ayrıntı");
    const def = JSON.parse(vlad(["finding", "list", "--state", "deferred", "--json"]).out);
    expect(def.findings.map((f: { id: string }) => f.id)).toEqual(["F-alpha-002"]);
    expect(vlad(["finding", "list", "--project", "alpha", "--severity", "kritik"]).out).toContain("F-alpha-001  kritik");
    expect(vlad(["status", "--summary"]).out.trim()).toMatch(/hatalı\), 1 açık kritik\/yüksek bulgu$/);
    expect(JSON.parse(vlad(["status", "--summary", "--json"]).out).openSevereFindings).toBe(1);
    const s = vlad(["finding", "set", "F-alpha-001", "fixed", "--by", "T20261022-02", "--json"]);
    expect(s.code, s.err).toBe(0);
    expect(JSON.parse(s.out)).toEqual({ id: "F-alpha-001", state: "fixed", fixed_by: "T20261022-02" });
    expect(vlad(["status", "--summary"]).out.trim()).toBe("İşlenmemiş 0 rapor, 0 aktif görev (0 onay bekliyor, 0 takıldı, 0 soru soruyor, 0 hatalı)");
    for (const bad of [
      ["finding", "add", "--project", "alpha", "--severity", "acil", "--source", "T20261022-01", "--title", "x", "--json"],
      ["finding", "set", "F-alpha-001", "closed", "--json"],
      ["finding", "set", "F-alpha-001", "open", "--by", "T20261022-02", "--json"],
      ["finding", "set", "F-alpha-077", "fixed", "--json"],
      ["finding", "list", "--state", "x", "--json"],
    ]) {
      const r = vlad(bad);
      expect(r.code, bad.join(" ")).toBe(1);
      expect(JSON.parse(r.err)).toHaveProperty("error");
    }
  });
  it("project note appends to ## Çalışma notları", () => {
    writeCard("C:\\r");
    expect(vlad(["project", "note", "alpha", "vitest önbelleğini temizle", "--json"]).code).toBe(0);
    const nf = join(home, "n.md");
    writeFileSync(nf, "ikinci\nsatır\n");
    expect(vlad(["project", "note", "alpha", "--file", nf]).code).toBe(0);
    const t = readFileSync(join(home, "kb", "projects", "alpha.md"), "utf8");
    expect(t).toMatch(/## Çalışma notları\n- \d{4}-\d\d-\d\d: vitest önbelleğini temizle\n- \d{4}-\d\d-\d\d: ikinci satır\n/);
    expect(vlad(["project", "note", "alpha", "--json"]).code).toBe(1);
  });
  it("done tasks count as unprocessed until digested; task list --undigested and task digested", () => {
    const id = mkTask();
    const f = join(home, "kb", "tasks", readdirSync(join(home, "kb", "tasks")).find((n) => n.startsWith(id))!);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^state: queued\r?$/m, "state: done"));
    expect(vlad(["status", "--summary"]).out.trim()).toBe(
      "İşlenmemiş 1 rapor, 0 aktif görev (0 onay bekliyor, 0 takıldı, 0 soru soruyor, 0 hatalı)",
    );
    expect(JSON.parse(vlad(["status", "--json"]).out).undigested).toBe(1);
    const l = JSON.parse(vlad(["task", "list", "--undigested", "--json"]).out);
    expect(l.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    const r = vlad(["task", "digested", id, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ids: [id] });
    expect(JSON.parse(vlad(["task", "list", "--undigested", "--json"]).out).tasks).toEqual([]);
    expect(vlad(["status", "--summary"]).out).toContain("İşlenmemiş 0 rapor");
  });
  it("role list --json lists roles and warnings; text lists slug kind title", () => {
    mkdirSync(join(home, "roles"));
    writeFileSync(join(home, "roles", "tester.md"), "---\nslug: tester\ntitle: Senior Tester\nkind: executor\nsummary: s\n---\n");
    writeFileSync(join(home, "roles", "bad.md"), "---\nslug: bad\n---\n");
    const j = JSON.parse(vlad(["role", "list", "--json"]).out);
    expect(j.roles.map((r: { slug: string }) => r.slug)).toEqual(["tester"]);
    expect(j.roles[0]).toMatchObject({ slug: "tester", model: null });
    expect(j.warnings).toHaveLength(1);
    expect(vlad(["role", "list"]).out).toContain("tester  executor  Senior Tester");
  });
  it("task new --model: opus needs --model-reason; list --json shows the effective model", () => {
    mkdirSync(join(home, "roles"));
    writeFileSync(join(home, "roles", "tester.md"), "---\nslug: tester\ntitle: Senior Tester\nkind: executor\nsummary: s\nmodel: sonnet\n---\n");
    const bad = vlad(["task", "new", "--project", "alpha", "--title", "T", "--model", "opus", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toMatch(/gerekçe|model-reason/);
    expect(vlad(["task", "new", "--project", "alpha", "--title", "T", "--model", "gpt", "--json"]).code).toBe(1);
    const ok = vlad(["task", "new", "--project", "alpha", "--title", "T", "--role", "tester", "--model", "opus", "--model-reason", "kritik", "--json"]);
    expect(ok.code).toBe(0);
    const plain = vlad(["task", "new", "--project", "alpha", "--title", "T2", "--role", "tester", "--json"]);
    const { tasks } = JSON.parse(vlad(["task", "list", "--json"]).out);
    expect(tasks.find((t: { id: string }) => t.id === JSON.parse(ok.out).id)).toMatchObject({ model: "opus", model_reason: "kritik", effective_model: "opus", role_model: "sonnet" });
    expect(tasks.find((t: { id: string }) => t.id === JSON.parse(plain.out).id)).toMatchObject({ effective_model: "sonnet", role_model: "sonnet" });
    for (const r of [ok, plain]) expect(vlad(["task", "set", JSON.parse(r.out).id, "running"]).code).toBe(0);
    const st = vlad(["status"]).out;
    expect(st).toContain("model: opus");
    expect(st).not.toMatch(/alpha {2}T2\b.*model:/);
  });
  it("task new --role writes the role; a kind mismatch exits 1 with a JSON error", () => {
    mkdirSync(join(home, "roles"));
    writeFileSync(join(home, "roles", "tester.md"), "---\nslug: tester\ntitle: Senior Tester\nkind: executor\nsummary: s\n---\n");
    writeFileSync(join(home, "roles", "finans.md"), "---\nslug: finans\ntitle: Finans\nkind: advisory\nsummary: s\n---\n");
    const ok = vlad(["task", "new", "--project", "alpha", "--title", "T", "--role", "tester", "--json"]);
    expect(ok.code, ok.err).toBe(0);
    const l = JSON.parse(vlad(["task", "list", "--json"]).out);
    expect(l.tasks[0]).toMatchObject({ id: JSON.parse(ok.out).id, role: "tester" });
    const bad = vlad(["task", "new", "--project", "alpha", "--title", "T", "--role", "finans", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toMatch(/rol finans \(advisory\) dev görevinde kullanılamaz/);
  });
  it("pipeline via CLI: --kind pipeline, --parent/--depends-on/--phase, task ready and list --parent", () => {
    const newTask = (...a: string[]) => {
      const r = vlad(["task", "new", "--project", "alpha", "--title", "T", ...a, "--json"]);
      expect(r.code, r.err).toBe(0);
      return JSON.parse(r.out).id as string;
    };
    const p = newTask("--kind", "pipeline");
    const a = newTask("--kind", "research", "--parent", p, "--phase", "spec");
    const b = newTask("--kind", "research", "--parent", p, "--depends-on", `${a}, ,`, "--phase", "plan");
    const ready = JSON.parse(vlad(["task", "ready", "--parent", p, "--json"]).out);
    expect(ready.tasks.map((t: { id: string }) => t.id)).toEqual([a]);
    const l = JSON.parse(vlad(["task", "list", "--parent", p, "--json"]).out);
    expect(l.tasks.map((t: { id: string; depends_on: string[] }) => [t.id, t.depends_on])).toEqual([[a, []], [b, [a]]]);
  });
  it("task deps: --set/--clear, json shape, one mode required, cycle error leaves stderr JSON", () => {
    const newTask = (...a: string[]) => JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", ...a, "--json"]).out).id as string;
    const p = newTask("--kind", "pipeline");
    const a = newTask("--kind", "research", "--parent", p);
    const b = newTask("--kind", "research", "--parent", p, "--depends-on", a);
    const r = JSON.parse(vlad(["task", "deps", b, "--set", `${a}, `, "--json"]).out);
    expect(r).toEqual({ id: b, previous: [a], depends_on: [a], changed: false, dependencies_satisfied: false, warnings: [] });
    const c = JSON.parse(vlad(["task", "deps", b, "--clear", "--json"]).out);
    expect(c).toMatchObject({ depends_on: [], changed: true, dependencies_satisfied: true, warnings: [`faz bağımlılıksız kaldı: ${b}`] });
    expect(vlad(["task", "deps", b, "--json"]).code).toBe(1);
    expect(vlad(["task", "deps", a, "--set", b, "--json"]).code).toBe(0);
    const cyc = vlad(["task", "deps", b, "--set", a, "--json"]);
    expect(cyc.code).toBe(1);
    expect(JSON.parse(cyc.err).error).toMatch(/döngü/);
  });
  it("task session sets session_id without changing state", () => {
    const id = mkTask();
    const r = vlad(["task", "session", id, "sess-123", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ id, session_id: "sess-123" });
    const l = JSON.parse(vlad(["task", "list", "--json"]).out);
    expect(l.tasks[0]).toMatchObject({ id, state: "queued", session_id: "sess-123" });
    expect(vlad(["task", "session", "T00000000-99", "x", "--json"]).code).toBe(1);
  });
  it("project list --json and inbox list --json carry warnings", () => {
    writeFileSync(join(home, "kb", "projects", "bad.md"), "---\nslug: [oops\n---\n");
    writeFileSync(join(home, "kb", "inbox", "20261015T120000-bad.json"), "{bozuk");
    const p = JSON.parse(vlad(["project", "list", "--json"]).out);
    expect(p.projects).toEqual([]);
    expect(p.warnings).toHaveLength(1);
    const i = JSON.parse(vlad(["inbox", "list", "--json"]).out);
    expect(i.items).toEqual([]);
    expect(i.warnings).toHaveLength(1);
  });
  it("project set: valid, invalid, delete, unknown field, missing project", () => {
    writeCard(home);
    const file = join(home, "kb", "projects", "alpha.md");
    const before = readFileSync(file, "utf8");
    expect(vlad(["project", "set", "alpha", "exposure", "internet", "--json"]).code).toBe(0);
    expect(vlad(["project", "set", "alpha", "local_only", "true", "--json"]).code).toBe(0);
    const set = readFileSync(file, "utf8");
    expect(set).toMatch(/exposure: internet/);
    expect(set).toMatch(/local_only: true/);
    expect(set).toMatch(/name: Alpha/);
    expect(set.endsWith("## Özet\nx\n")).toBe(true);
    const bad = vlad(["project", "set", "alpha", "exposure", "mars", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err)).toHaveProperty("error");
    expect(readFileSync(file, "utf8")).toBe(set);
    expect(vlad(["project", "set", "alpha", "local_only", "evet", "--json"]).code).toBe(1);
    expect(vlad(["project", "set", "alpha", "path", "x", "--json"]).code).toBe(1);
    expect(vlad(["project", "set", "nope", "exposure", "local", "--json"]).code).toBe(1);
    expect(vlad(["project", "set", "alpha", "exposure", "", "--json"]).code).toBe(0);
    expect(readFileSync(file, "utf8")).not.toMatch(/exposure/);
    expect(vlad(["project", "set", "alpha", "local_only", "", "--json"]).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("inbox count --json", () => {
    const r = vlad(["inbox", "count", "--json"]);
    expect(JSON.parse(r.out)).toEqual({ count: 0 });
  });
  it("task ask/answer/log round trip and list", () => {
    const id = mkTask();
    // queued -> running normally needs a launch; flip the state in the file for this round trip
    const f = join(home, "kb", "tasks", readdirSync(join(home, "kb", "tasks")).find((n) => n.startsWith(id))!);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^state: queued\r?$/m, "state: running"));
    expect(vlad(["task", "log", id, "adım bir", "--json"]).code).toBe(0);
    expect(JSON.parse(vlad(["task", "ask", id, "hangi yol?", "--json"]).out)).toEqual({ id, state: "blocked" });
    expect(JSON.parse(vlad(["task", "answer", id, "şu yol", "--json"]).out)).toEqual({ id, state: "running" });
    const body = readFileSync(f, "utf8");
    expect(body).toContain("adım bir");
    expect(body).toContain("hangi yol?");
    expect(body).toContain("şu yol");
    expect(vlad(["task", "set", id, "cancelled", "--json"]).code).toBe(0);
    const l = JSON.parse(vlad(["task", "list", "--state", "cancelled", "--json"]).out);
    expect(l.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
  });
  it("integration: launch --dry-run, report, set done, cleanup", () => {
    const base = mkdtempSync(join(tmpdir(), "vlad-cli-repo-"));
    const repo = join(base, "alpha");
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
    g("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1");
    g("add", ".");
    g("commit", "-m", "first");
    writeCard(repo);
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ worktreeDir: join(base, "wt") }));
    const id = mkTask();

    const l = vlad(["task", "launch", id, "--dry-run", "--json"]);
    expect(l.code, l.err).toBe(0);
    const j = JSON.parse(l.out);
    expect(j.state).toBe("running");
    expect(j.branch).toBe(`vlad/${id}`);
    expect(existsSync(j.worktree)).toBe(true);

    const rep = join(home, "rapor.md");
    writeFileSync(rep, "## Özet\nbitti\n");
    expect(JSON.parse(vlad(["task", "report", id, "--file", rep, "--json"]).out).state).toBe("awaiting_approval");
    expect(JSON.parse(vlad(["task", "set", id, "done", "--json"]).out).state).toBe("done");
    expect(vlad(["task", "cleanup", id, "--json"]).code).toBe(0);
    expect(existsSync(j.worktree)).toBe(false);
  });
  it("bare `vlad` and a group without subcommand print help", () => {
    for (const args of [[], ["task"]]) {
      const r = vlad(args);
      expect(r.code).toBe(1);
      expect(r.err).toContain("Usage:");
      expect(r.err).not.toContain("outputHelp");
    }
    const h = vlad(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("install");
  });
  it("session register rejects a blank name", () => {
    const r = vlad(["session", "register", "   ", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/boş/);
    expect(existsSync(join(home, "kb", "vlad-session.txt"))).toBe(false);
  });
  describe("install", () => {
    let claude: string;
    beforeEach(() => {
      cpSync(join(root, "global"), join(home, "global"), { recursive: true });
      claude = join(mkdtempSync(join(tmpdir(), "vlad-claude-")), ".claude");
    });
    it("--dry-run lists actions and leaves the disk untouched", () => {
      const r = vlad(["install", "--dry-run", "--json"], undefined, { VLAD_CLAUDE_DIR: claude });
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out).actions.length).toBeGreaterThan(0);
      expect(existsSync(claude)).toBe(false);
    });
    it("writes the SessionEnd hook and the worker skill", () => {
      const r = vlad(["install"], undefined, { VLAD_CLAUDE_DIR: claude });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("SessionEnd");
      const s = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
      expect(s.hooks.SessionEnd[0].hooks[0].command).toContain("session-report.js");
      expect(existsSync(join(claude, "skills", "vlad-worker", "SKILL.md"))).toBe(true);
    });
  });
  it("session register/name round trip and missing file", () => {
    const miss = vlad(["session", "name", "--json"]);
    expect(miss.code).toBe(1);
    expect(JSON.parse(miss.err).error).toBeTruthy();
    expect(vlad(["session", "register", "  vlad-main  ", "--json"]).code).toBe(0);
    expect(JSON.parse(vlad(["session", "name", "--json"]).out)).toEqual({ name: "vlad-main" });
    expect(vlad(["session", "name"]).out.trim()).toBe("vlad-main");
    expect(existsSync(join(home, "kb", "vlad-session.txt"))).toBe(true);
  });
  it("project write rejects a bad slug", () => {
    const f = join(home, "c.md");
    writeFileSync(f, "---\nslug: x\n---\n");
    const r = vlad(["project", "write", "Bad/Slug", "--file", f, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/slug/);
  });
  it("decision add and journal append", () => {
    expect(vlad(["decision", "add", "--project", "p", "--title", "t", "--body-file", "-", "--json"], "- **Karar:** x").code).toBe(0);
    expect(readFileSync(join(home, "kb", "decisions", "p.md"), "utf8")).toContain(" — p — t");
    expect(vlad(["journal", "append", "2026-10-15", "--file", "-", "--json"], "- a").code).toBe(0);
    expect(existsSync(join(home, "kb", "journal", "2026-10-15.md"))).toBe(true);
  });
  it("task launch on unknown task exits 1", () => {
    const r = vlad(["task", "launch", "T20260101-01", "--dry-run", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/bulunamadı/);
  });
  it("kb maintain: dry-run changes nothing; archived done task still shows in task list/set and counts toward undigested", () => {
    const id = mkTask();
    const file = join(home, "kb", "tasks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace(/^state: .*$/m, "state: done").replace(/^updated: .*$/m, "updated: 2026-01-05T10:00:00+03:00"));
    const dry = JSON.parse(vlad(["kb", "maintain", "--dry-run", "--json"]).out);
    expect(dry.dry_run).toBe(true);
    expect(dry.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(vlad(["kb", "maintain", "--json"]).out).tasks).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(vlad(["task", "list", "--json"]).out).tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    expect(vlad(["status", "--summary"]).out).toContain("İşlenmemiş 1 rapor");
    expect(vlad(["task", "digested", id, "--json"]).code).toBe(0);
    expect(vlad(["status", "--summary"]).out).toContain("İşlenmemiş 0 rapor");
    expect(JSON.parse(vlad(["kb", "maintain", "--json"]).out).tasks).toEqual([]);
  });
});

