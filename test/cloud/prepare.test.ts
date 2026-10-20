import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { writeProject } from "../../src/projects/store.js";
import {
  createTask, getTask, logTask, nextTaskId, prepareCloudLaunch, reportTask, saveTask, setState,
} from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

const card = (slug: string, extra = "") => `---
slug: ${slug}
name: ${slug}
path: "C:\\\\dev\\\\${slug}"
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
${extra}---

## Özet
x
`;

let home: string;
beforeEach(() => {
  home = makeHome();
  mkdirSync(join(home, "roles"), { recursive: true });
  writeFileSync(join(home, "roles", "developer.md"), `---
slug: developer
title: Senior Developer
kind: executor
summary: x
model: sonnet
skills:
  - superpowers:test-driven-development
---

ROL-GÖVDESİ sorumluluk
`);
  writeProject("alpha", card("alpha", "repo: owner/alpha\n"));
  writeProject("noremote", card("noremote"));
  writeProject("winonly", card("winonly", "repo: owner/win\nlocal_only: true\nlocal_only_reason: WPF derlenmez\n"));
});

const body = "## Tanım\nTANIM-METNİ\n\n## Kabul kriterleri\n- [ ] KRİTER\n\n## Bağlam\nBAĞLAM-METNİ\n";
const mk = (project = "alpha", o: object = {}) =>
  createTask({ project, title: "İş", kind: "dev", body, role: "developer", ...o });

describe("prepareCloudLaunch", () => {
  it("returns the create_session arguments, moves to running, opens no worktree", () => {
    const t = mk();
    const r = prepareCloudLaunch(t.data.id);
    expect(r).toMatchObject({
      id: t.data.id, state: "running", mode: "cloud", action: "create_session", repo: "owner/alpha",
      source_url: "https://github.com/owner/alpha", source_revision: "master", base_branch: "master",
      outcome_branch: `vlad/${t.data.id}`, branch: `vlad/${t.data.id}`, worktree: null, integration: null,
      model: "sonnet", title: `VLAD ${t.data.id} — İş`, permission_mode: "auto",
    });
    expect(r.tags).toEqual(["vlad", `vlad-task:${t.data.id}`, "vlad-project:alpha"]);
    expect(r.next.join("\n")).toContain(`vlad task session ${t.data.id}`);
    const g = getTask(t.data.id);
    expect(g.data).toMatchObject({ state: "running", branch: `vlad/${t.data.id}`, worktree: null, error: null });
  });

  it("inlines task sections, role file and the [VLAD:*] protocol", () => {
    const t = mk();
    const p = prepareCloudLaunch(t.data.id).prompt;
    for (const s of ["TANIM-METNİ", "KRİTER", "BAĞLAM-METNİ", "ROL-GÖVDESİ", "superpowers:test-driven-development",
      "[VLAD:LOG #n]", "[VLAD:ASK #n]", `[VLAD:REPORT #n branch=vlad/${t.data.id}`, "[VLAD:END #n]", "[VLAD:FAIL #n]",
      `git push -u origin vlad/${t.data.id}`, "kb/` altına yazma",
      "son tur mesajında tüm işaretlerini (LOG'lar dahil) tekrar et", "tek doğru kaynak"]) expect(p).toContain(s);
  });

  it("next lists permission_mode among the create_session arguments", () => {
    const r = prepareCloudLaunch(mk().data.id);
    expect(r.next.find((n) => n.startsWith("create_session("))).toContain("permission_mode");
  });

  it("autonomy plan forbids pushing in the prompt", () => {
    const t = mk();
    const g = getTask(t.data.id);
    writeFileSync(g.file, readBack(g.file).replace("autonomy: commit", "autonomy: plan"));
    expect(prepareCloudLaunch(t.data.id).prompt).toContain("push etme");
  });

  it("pipeline phase: base is vlad/<parent>, needs_remote_create until the branch is recorded, dependency reports inlined", () => {
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "" });
    const spec = createTask({ project: "alpha", title: "spec", kind: "research", body: "", parent: pipe.data.id, role: undefined });
    setState(spec.data.id, "running");
    reportTask(spec.data.id, "### Amaç\nSPEC-RAPORU");
    setState(spec.data.id, "done");
    const a = createTask({ project: "alpha", title: "a", kind: "dev", body, role: "developer", parent: pipe.data.id, dependsOn: [spec.data.id] });
    const b = createTask({ project: "alpha", title: "b", kind: "dev", body, role: "developer", parent: pipe.data.id });
    const probe = (state: "exists" | "missing" | "unknown") => ({ remoteBranch: () => state });
    const ra = prepareCloudLaunch(a.data.id, probe("missing"));
    const int = `vlad/${pipe.data.id}`;
    expect(ra).toMatchObject({ source_revision: int, base_branch: int, integration: { branch: int, needs_remote_create: true, from: "master" }, warnings: [] });
    expect(ra.prompt).toContain("SPEC-RAPORU");
    // launch no longer records the unverified branch on the parent
    expect(getTask(pipe.data.id).data.branch).not.toBe(int);
    // a stale record does not matter: the remote decides
    const pg = getTask(pipe.data.id);
    pg.data.branch = int;
    saveTask(pg);
    expect(prepareCloudLaunch(b.data.id, probe("missing")).integration?.needs_remote_create).toBe(true);
  });

  it("pipeline phase: branch present on the remote means no creation; unreachable remote assumes creation and warns", () => {
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "" });
    const a = createTask({ project: "alpha", title: "a", kind: "dev", body, role: "developer", parent: pipe.data.id });
    const b = createTask({ project: "alpha", title: "b", kind: "dev", body, role: "developer", parent: pipe.data.id });
    const seen: string[][] = [];
    const rb = prepareCloudLaunch(a.data.id, { remoteBranch: (r, br) => (seen.push([r, br]), "exists") });
    expect(rb.integration?.needs_remote_create).toBe(false);
    expect(rb.warnings).toEqual([]);
    expect(seen).toEqual([["owner/alpha", `vlad/${pipe.data.id}`]]);
    const ru = prepareCloudLaunch(b.data.id, { remoteBranch: () => "unknown" });
    expect(ru.integration?.needs_remote_create).toBe(true);
    expect(ru.warnings.join()).toMatch(/kontrol edilemedi/);
  });

  it("pipeline phase prompt inlines the parent's sections without Fazlar/Kapılar; a phaseless task has no parent section", () => {
    const pbody = "## Tanım\nCATI-TANIM\n\n### Fazlar\nFAZ-LISTESI\n\n### Gerekçe\nCATI-GEREKCE\n\n## Kabul kriterleri\n- [ ] CATI-KRITER\n\n### Kapılar\nKAPI-LISTESI\n\n## Bağlam\nCATI-BAGLAM\n";
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: pbody });
    const ph = createTask({ project: "alpha", title: "faz", kind: "dev", body, role: "developer", parent: pipe.data.id });
    const { prompt } = prepareCloudLaunch(ph.data.id, { remoteBranch: () => "exists" });
    expect(prompt).toContain(`## Çatı görev (${pipe.data.id})`);
    for (const m of ["CATI-TANIM", "CATI-GEREKCE", "CATI-KRITER", "CATI-BAGLAM", "TANIM-METNİ"]) expect(prompt).toContain(m);
    for (const m of ["FAZ-LISTESI", "KAPI-LISTESI"]) expect(prompt).not.toContain(m);
    expect(prepareCloudLaunch(mk().data.id).prompt).not.toContain("## Çatı görev");
  });

  it("prompt carries VLAD's session id and the one-shot notification instruction; omitted without a session", () => {
    const withSession = prepareCloudLaunch(mk().data.id, { vladSession: "session_VLAD123" });
    for (const needle of ["session_VLAD123", "create_trigger", "persistent_session_id", "run_once_at", "VLAD görev T", "ingest et", "yalnızca bir `[VLAD:LOG #n]`"]) {
      expect(withSession.prompt).toContain(needle);
    }
    const none = prepareCloudLaunch(mk().data.id, { vladSession: "" });
    expect(none.prompt).not.toContain("create_trigger");
  });

  it.each([
    ["noremote", /repo: owner\/name/],
    ["winonly", /yalnızca yerel.*WPF derlenmez/],
  ])("project %s: clear error, task stays queued with error set", (project, re) => {
    const t = mk(project);
    expect(() => prepareCloudLaunch(t.data.id)).toThrow(re);
    expect(getTask(t.data.id).data).toMatchObject({ state: "queued" });
    expect(getTask(t.data.id).data.error).toMatch(re);
  });

  it("research tasks and non-queued tasks are refused", () => {
    const r = createTask({ project: "alpha", title: "r", kind: "research", body: "" });
    expect(() => prepareCloudLaunch(r.data.id)).toThrow(/yalnızca dev/);
    const t = mk();
    prepareCloudLaunch(t.data.id);
    expect(() => prepareCloudLaunch(t.data.id)).toThrow(/queued değil/);
  });

  it("unknown project card is an error, not a crash", () => {
    const t = mk();
    const g = getTask(t.data.id);
    writeFileSync(g.file, readBack(g.file).replace("project: alpha", "project: ghost"));
    expect(() => prepareCloudLaunch(t.data.id)).toThrow(/proje kartı bulunamadı/);
  });
});

import { readFileSync } from "node:fs";
const readBack = (f: string) => readFileSync(f, "utf8");

describe("cloud task id range", () => {
  afterEach(() => { process.env.CLAUDE_CODE_REMOTE = ""; });

  it("starts at 51 in the cloud, 01 locally, and continues above existing ids", () => {
    const dir = kbPaths().tasks;
    const day = new Date(2026, 9, 20);
    expect(nextTaskId(dir, day)).toBe("T20261020-01");
    process.env.CLAUDE_CODE_REMOTE = "true";
    expect(nextTaskId(dir, day)).toBe("T20261020-51");
    writeFileSync(join(dir, "T20261020-51.md"), "x");
    expect(nextTaskId(dir, day)).toBe("T20261020-52");
  });

  it("createTask uses the cloud range", () => {
    process.env.CLAUDE_CODE_REMOTE = "true";
    expect(mk().data.id).toMatch(/-51$/);
  });
});
