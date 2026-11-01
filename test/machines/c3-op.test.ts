import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { livenessResults } from "../../src/agent/ops/liveness.js";
import { OP_TABLE } from "../../src/agent/ops/index.js";
import { claudeProjectDir, transcriptMtime, type LivenessProbe } from "../../src/tasks/liveness.js";

describe("machines:C3 liveness op (işçi)", () => {
  it("ageMs = agentNow - transcriptMtime; hasProcess = probe.alive; worktree çözülemezse ageMs null", () => {
    const now = 1_000_000_000;
    const probe: LivenessProbe = { alive: (id) => id === "T1", transcriptMtime: (wt) => (wt === "W/T1" ? now - 90_000 : null) };
    const r = livenessResults(
      [{ id: "T1", project: "p", repoName: "r" }, { id: "T2", project: "p", repoName: "r" }, { id: "T3", project: "p", repoName: "yok" }],
      { now, probe, worktreeOf: (t) => (t.repoName === "yok" ? null : `W/${t.id}`) },
    );
    expect(r).toEqual({ T1: { ageMs: 90_000, hasProcess: true }, T2: { ageMs: null, hasProcess: false }, T3: { ageMs: null, hasProcess: false } });
  });

  it("süreç listesi alınamazsa (alive null) op hata verir: yanlış 'süreç yok' kararı üretilmez", () => {
    const probe: LivenessProbe = { alive: () => null, transcriptMtime: () => null };
    expect(() => livenessResults([{ id: "T1", project: "p", repoName: "r" }], { now: 1, probe, worktreeOf: () => "W" })).toThrow(/süreç listesi/);
  });

  it("ageMs negatif olamaz (transcript işçi saatinden ileri): 0'a kırpılır", () => {
    const probe: LivenessProbe = { alive: () => true, transcriptMtime: () => 2000 };
    expect(livenessResults([{ id: "T1", project: "p", repoName: "r" }], { now: 1000, probe, worktreeOf: () => "W" }).T1.ageMs).toBe(0);
  });

  it("gerçek transcriptMtime ile uyum: geçici claude dizini", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "vlad-c3-"));
    const wt = join(cfgDir, "wt", "T9");
    const dir = join(cfgDir, "projects", claudeProjectDir(wt));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.jsonl"), "{}");
    utimesSync(join(dir, "a.jsonl"), 1000, 1000);
    expect(transcriptMtime(wt, cfgDir)).toBe(1_000_000);
  });

  it("op tablosunda liveness artık notImplemented değil; bozuk argüman bad_request benzeri hata", async () => {
    await expect(OP_TABLE.liveness({ tasks: "bozuk" }, { from: "mac", opId: "x" })).rejects.not.toMatchObject({ name: "NotImplementedOp" });
  });
});
