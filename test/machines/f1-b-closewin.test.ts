import { describe, expect, it } from "vitest";
import { remoteMachineOf } from "../../src/tasks/launch.js";
import type { Task } from "../../src/tasks/store.js";
import type { VladConfig } from "../../src/kb/index.js";

const cfg = { brain: "mac", machines: [{ name: "mac" }, { name: "windows" }] } as unknown as VladConfig;
const task = (machine: string | null) => ({ data: { machine } }) as unknown as Task;

describe("F-vlad-149: remoteMachineOf işçide kendi görevini uzak saymaz", () => {
  it("beyinde: görev başka makinedeyse o makine", () => expect(remoteMachineOf(task("windows"), cfg)).toBe("windows"));
  it("işçide (self=windows): görev kendi makinesindeyse null → yerel pencere kapatılır", () => expect(remoteMachineOf(task("windows"), cfg, "windows")).toBeNull());
  it("işçide başka makinenin görevi hâlâ uzaktır", () => expect(remoteMachineOf(task("linux"), cfg, "windows")).toBe("linux"));
});
