import { cpSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHome, rmTemp } from "../helpers.js";
import { createPipeline, getTask } from "../../src/tasks/index.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
const BODY = "## Tanım\nBüyük iş\n\n## Kabul kriterleri\n- [ ] çalışır\n\n## Bağlam\nkaynak\n";
let home: string;

beforeEach(() => {
  home = makeHome();
  cpSync(resolve(__dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true });
});
afterEach(() => rmTemp(home));

const run = (cycle: string, extra: Partial<Parameters<typeof createPipeline>[0]> = {}) =>
  createPipeline({ project: "p", title: "T", cycle, body: BODY, ...extra }, D);
const shape = (r: ReturnType<typeof run>) =>
  r.phases.map((p) => `${p.phase}:${p.role}:${p.kind}<${p.depends_on.map((d) => r.phases.find((x) => x.id === d)!.phase).join(",")}`);
const taskFiles = () => readdirSync(join(home, "kb", "tasks")).filter((f) => f.endsWith(".md"));

describe("createPipeline", () => {
  it("tam", () => {
    expect(shape(run("tam"))).toEqual([
      "spec:analyst:research<", "plan:architect:research<spec", "sözleşme:developer:dev<plan",
      "kabul:tester:dev<sözleşme", "uygulama:developer:dev<sözleşme", "doğrulama:tester:dev<kabul,uygulama",
    ]);
  });
  it("özellik", () => {
    expect(shape(run("özellik"))).toEqual([
      "spec:analyst:research<", "sözleşme:developer:dev<spec", "kabul:tester:dev<sözleşme",
      "uygulama:developer:dev<sözleşme", "doğrulama:tester:dev<kabul,uygulama",
    ]);
  });
  it("kısa", () => {
    expect(shape(run("kısa"))).toEqual(["uygulama:developer:dev<", "doğrulama:tester:dev<uygulama"]);
  });
  it("--ui adds designer phases (tam: tasarım before plan, denetim beside doğrulama)", () => {
    expect(shape(run("tam", { ui: true }))).toEqual([
      "spec:analyst:research<", "tasarım:designer:dev<spec", "plan:architect:research<spec,tasarım",
      "sözleşme:developer:dev<plan,tasarım", "kabul:tester:dev<sözleşme", "uygulama:developer:dev<sözleşme",
      "doğrulama:tester:dev<kabul,uygulama", "denetim:designer:dev<kabul,uygulama",
    ]);
    expect(shape(run("kısa", { ui: true }))).toEqual([
      "uygulama:developer:dev<", "doğrulama:tester:dev<uygulama", "denetim:designer:dev<uygulama",
    ]);
  });
  it("--prova adds devops phase after uygulama", () => {
    expect(shape(run("kısa", { prova: true }))).toContain("prova:devops:dev<uygulama");
  });
  it("--skip sözleşme drops it, rewires dependents and records the reason in the çatı", () => {
    const r = run("özellik", { skip: ["sözleşme"], skipReason: "arayüz değişmiyor" });
    expect(shape(r)).toEqual([
      "spec:analyst:research<", "kabul:tester:dev<spec", "uygulama:developer:dev<spec", "doğrulama:tester:dev<kabul,uygulama",
    ]);
    expect(getTask(r.id).body).toContain("sözleşme atlandı: arayüz değişmiyor");
  });
  it("--skip needs a reason, only sözleşme, only where it exists", () => {
    expect(() => run("tam", { skip: ["sözleşme"] })).toThrow(/skip-reason/);
    expect(() => run("tam", { skip: ["spec"], skipReason: "x" })).toThrow(/yalnız sözleşme/);
    expect(() => run("kısa", { skip: ["sözleşme"], skipReason: "x" })).toThrow(/sözleşme fazı yok/);
    expect(taskFiles()).toEqual([]);
  });
  it("creates the çatı with parent links, phases and derived default bodies", () => {
    const r = run("kısa", { ui: true });
    const c = getTask(r.id);
    expect(c.data.kind).toBe("pipeline");
    expect(c.body).toContain("Büyük iş");
    const u = getTask(r.phases[0]!.id);
    expect(u.data).toMatchObject({ parent: r.id, phase: "uygulama", role: "developer", kind: "dev", title: "T — uygulama" });
    expect(u.body).toContain("Büyük iş");
    expect(u.body).toContain(r.id);
    expect(u.body).toContain("ekran görüntüsüyle öz-kontrol"); // UI'lı uygulama
    expect(getTask(r.phases[1]!.id).body).not.toContain("öz-kontrol");
  });
  it("--phase-body overrides one phase; unknown phase is rejected before anything is written", () => {
    const r = run("kısa", { phaseBodies: { uygulama: "## Tanım\nÖZEL\n" } });
    expect(getTask(r.phases[0]!.id).body).toContain("ÖZEL");
    expect(getTask(r.phases[1]!.id).body).not.toContain("ÖZEL");
    const before = taskFiles().length;
    expect(() => run("kısa", { phaseBodies: { spec: "x" } })).toThrow(/faz yok: spec/);
    expect(taskFiles().length).toBe(before);
  });
  it("free-text çatı body (no ## Tanım) is used whole as the definition", () => {
    const r = run("kısa", { body: "sadece serbest metin" });
    expect(getTask(r.phases[0]!.id).body).toContain("sadece serbest metin");
  });
  it("rejects an unknown cycle", () => {
    expect(() => run("tek")).toThrow(/geçersiz döngü/);
    expect(taskFiles()).toEqual([]);
  });
  it("all-or-nothing: a failing phase rolls back çatı and earlier phases", () => {
    let n = 0;
    expect(() => createPipeline({ project: "p", title: "T", cycle: "özellik", body: BODY }, D, (c) => {
      if (++n === 3) throw new Error("boom");
      return c();
    })).toThrow(/boom/);
    expect(taskFiles()).toEqual([]);
  });
});
