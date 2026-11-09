import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWrite } from "../../src/agent/ops/apply-write.js";
import { askTask, createTask, getTask, saveTask, setState } from "../../src/tasks/index.js";
import { makeHome, rmTemp } from "../helpers.js";

// F-vlad-279: the worker's `task report` is forwarded to the brain (applyWrite → CLI); it must work for a blocked task too.
let home: string;
beforeEach(() => {
  home = makeHome();
  process.env.VLAD_AGENT_TEST = "1";
  process.env.VLAD_AGENT_CLI = resolve(__dirname, "../../dist/cli.js"); // gate builds first
});
afterEach(() => { delete process.env.VLAD_AGENT_TEST; delete process.env.VLAD_AGENT_CLI; rmTemp(home); });

describe("uzak yol: blocked çalışan raporu beyinde awaiting_approval olur (F-vlad-279)", () => {
  it("task.report from a blocked windows task", async () => {
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
    t.data.machine = "windows";
    saveTask(t);
    setState(t.data.id, "running");
    askTask(t.data.id, "push edeyim mi?");
    const r = await applyWrite({ cmd: "task.report", id: t.data.id, text: "### Yapılanlar\n- bitti\n", json: true }, { from: "windows", opId: "op-1" });
    expect(r.exit, r.stderr).toBe(0);
    expect(getTask(t.data.id).data.state).toBe("awaiting_approval");
    expect(getTask(t.data.id).body).toContain("Rapor açık soru varken yazıldı");
  }, 30_000);
});
