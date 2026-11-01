import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTask, logTask, resumeInfo, resumeLocalCheck, resumePrepare, setState } from "../../src/tasks/index.js";
import { lockPolicyOf } from "../../src/machines/lock-policy.js";
import { defaultConfig } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

let id: string;
let gone: string;
beforeEach(() => {
  makeHome();
  gone = join(mkdtempSync(join(tmpdir(), "vlad-c1r-")), "olmayan-worktree");
  id = createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }, new Date(2026, 9, 15)).data.id;
  setState(id, "running", { branch: `vlad/${id}`, worktree: gone });
  logTask(id, "adım 1");
});

describe("machines:C1 resumePrepare / resumeLocalCheck", () => {
  it("resumePrepare worktree'ye dokunmaz: olmayan yolda bile plan döner", () => {
    const plan = resumePrepare(id);
    expect(plan).toMatchObject({ id, branch: `vlad/${id}`, worktree: gone });
    expect(plan.tail.join("\n")).toContain("adım 1");
    expect(plan.authority).toContain("Yetki seviyen");
  });

  it("resumeLocalCheck worktree denetimini yapar; resumeInfo ikisinin bileşimi (eski hata iletisi aynı)", () => {
    const plan = resumePrepare(id);
    expect(() => resumeLocalCheck(plan)).toThrow(`worktree yok: ${gone}`);
    expect(() => resumeInfo(id)).toThrow(`worktree yok: ${gone}`);
  });

  it("running/stalled dışı reddedilir (prepare'de)", () => {
    setState(id, "awaiting_approval");
    expect(() => resumePrepare(id)).toThrow(/yalnızca running\/stalled/);
  });

  it("worktree da session_id de yoksa sürdürülemez", () => {
    setState(id, "stalled", { worktree: null });
    expect(() => resumePrepare(id)).not.toThrow();
    expect(() => resumeLocalCheck(resumePrepare(id))).toThrow(/sürdürülemez/);
  });
});

describe("machines:C1 lockPolicyOf", () => {
  const writes = new Set(["task resume", "task cleanup", "task log", "task ready"]);
  const withMachines = { ...defaultConfig(), brain: "mac", machines: [{ name: "mac", os: "darwin" as const, agent: { port: 7437 } }] };
  it("machines yokken bugünkü davranış: KB_WRITES -> outer, diğerleri none", () => {
    expect(lockPolicyOf("task resume", writes, defaultConfig())).toBe("outer");
    expect(lockPolicyOf("task log", writes, defaultConfig())).toBe("outer");
    expect(lockPolicyOf("task close-window", writes, defaultConfig())).toBe("none");
  });
  it("machines varken resume/cleanup -> inner; diğer yazanlar outer kalır", () => {
    expect(lockPolicyOf("task resume", writes, withMachines)).toBe("inner");
    expect(lockPolicyOf("task cleanup", writes, withMachines)).toBe("inner");
    expect(lockPolicyOf("task log", writes, withMachines)).toBe("outer");
    expect(lockPolicyOf("task close-window", writes, withMachines)).toBe("none");
  });
});
