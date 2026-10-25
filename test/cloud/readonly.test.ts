import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/kb/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, prepareCloudLaunch, reportTask, setState } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

const ADD = "mcp__claude-code-remote__add_repo";
const REG = "mcp__claude-code-remote__register_repo_root";

let home: string;
const cfg = (o: object) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(o));
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
  writeProject("alpha", `---
slug: alpha
name: alpha
path: "C:\\\\dev\\\\alpha"
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
repo: owner/alpha
gate: npm run gate
---

## Özet
x

## Çalışma notları
- 2026-10-22: NOT-METNİ
`);
});

const body = "## Tanım\nTANIM-METNİ\n\n## Kabul kriterleri\n- [ ] KRİTER\n\n## Bağlam\nBAĞLAM-METNİ\n";
const mk = (o: object = {}) => createTask({ project: "alpha", title: "İş", kind: "dev", body, role: "developer", ...o });

describe("cloudKb config", () => {
  it("defaults to readonly; accepts inline; rejects other values", () => {
    expect(loadConfig(home).cloudKb ?? "readonly").toBe("readonly");
    cfg({ cloudKb: "inline" });
    expect(loadConfig(home).cloudKb).toBe("inline");
    cfg({ cloudKb: "nope" });
    expect(() => loadConfig(home)).toThrow();
  });
});

describe("readonly cloud prompt", () => {
  it("omits task text, dependency reports, work notes and gate; keeps identity, protocol and role", () => {
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "## Tanım\nCATI-METNİ\n" });
    const spec = createTask({ project: "alpha", title: "spec", kind: "research", body: "", parent: pipe.data.id });
    setState(spec.data.id, "running");
    reportTask(spec.data.id, "### Amaç\nSPEC-RAPORU");
    const t = mk({ parent: pipe.data.id, dependsOn: [spec.data.id] });
    const r = prepareCloudLaunch(t.data.id, { remoteBranch: () => "exists" });
    for (const s of ["TANIM-METNİ", "KRİTER", "BAĞLAM-METNİ", "CATI-METNİ", "SPEC-RAPORU", "NOT-METNİ", "npm run gate"]) {
      expect(r.prompt).not.toContain(s);
    }
    expect(r.prompt).toContain(`Görev ${t.data.id}`);
    expect(r.prompt).toContain("VLAD bulut protokolü");
    expect(r.prompt).toContain("## Entegrasyon öncesi kontrol");
    expect(r.prompt).toContain("ROL-GÖVDESİ sorumluluk");
  });

  it("has the opening steps, the read-only rule and the fallback", () => {
    const { prompt: p } = prepareCloudLaunch(mk().data.id);
    expect(p).toContain(ADD);
    expect(p).toContain("iamhankaya");
    expect(p).toContain("vlad-kb");
    expect(p).toContain("access");
    expect(p).toContain("read");
    expect(p).toContain("register_repo_root");
    expect(p).toContain("429");
    expect(p).toContain("5 sn");
    expect(p).toContain("tasks/T");
    expect(p).toContain("## Çalışma notları");
    expect(p).toContain("gate");
    expect(p).toContain("pull --ff-only");
    expect(p).toMatch(/commit\/push yok/);
    expect(p).toContain("[VLAD:LOG #n] kb erişimi yok");
    expect(p).toContain("[VLAD:ASK #n]");
  });

  it("stays under 15 KB for a sample task", () => {
    expect(Buffer.byteLength(prepareCloudLaunch(mk().data.id).prompt)).toBeLessThan(15 * 1024);
  });

  it("extra_allowed_tools, kb_access and the push step in next", () => {
    const r = prepareCloudLaunch(mk().data.id);
    expect(r.kb_access).toBe("readonly");
    expect(r.extra_allowed_tools).toEqual([ADD, REG]);
    expect(r.next[0]).toContain("vlad kb commit --push");
    expect(r.next.findIndex((n) => n.includes("kb commit --push"))).toBeLessThan(r.next.findIndex((n) => n.startsWith("create_session(")));
  });
});

describe("readonly details", () => {
  it("o.cloudKb overrides the config; opening lists parent and dependency files; protocol keeps the task file readable", () => {
    cfg({ cloudKb: "inline" });
    const pipe = createTask({ project: "alpha", title: "P", kind: "pipeline", body: "" });
    const spec = createTask({ project: "alpha", title: "spec", kind: "research", body: "", parent: pipe.data.id });
    const t = mk({ parent: pipe.data.id, dependsOn: [spec.data.id] });
    const { prompt: p, kb_access } = prepareCloudLaunch(t.data.id, { cloudKb: "readonly", remoteBranch: () => "exists" });
    expect(kb_access).toBe("readonly");
    for (const f of [t.data.id, pipe.data.id, spec.data.id]) expect(p).toContain(`<kb>/tasks/${f}.md`);
    expect(p).toContain("`<kb>/projects/alpha.md`");
    expect(p).toContain("kb klonundan (`<kb>/…`, salt okuma) okursun");
    expect(p).not.toContain("görev dosyası ve worktree adımlarını geçersiz kılar");
    expect(p).toContain(`tasks/${t.data.id}.md\` klonda yoksa`);
  });

  it("an invalid cloudKb leaves the task queued with error set", () => {
    const t = mk();
    cfg({ cloudKb: "nope" });
    expect(() => prepareCloudLaunch(t.data.id)).toThrow();
    expect(getTask(t.data.id).data).toMatchObject({ state: "queued" });
  });
});

describe("inline cloud launch", () => {
  it("keeps task text and work notes in the prompt, no extra tools", () => {
    cfg({ cloudKb: "inline" });
    const r = prepareCloudLaunch(mk().data.id);
    expect(r.kb_access).toBe("inline");
    expect(r.extra_allowed_tools).toEqual([]);
    expect(r.prompt).toContain("TANIM-METNİ");
    expect(r.prompt).toContain("NOT-METNİ");
    expect(r.prompt).toContain("npm run gate");
    expect(r.prompt).not.toContain(ADD);
    expect(r.next.join("\n")).not.toContain("kb commit --push");
  });
});
