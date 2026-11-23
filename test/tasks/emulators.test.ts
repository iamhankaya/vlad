import { describe, expect, it } from "vitest";
import { emulatorWarning, killTaskEmulators, listEmulators, orphanEmulators, parseEmulators, type EmuDeps } from "../../src/tasks/emulators.js";

// ps eww -axo pid=,etime=,command= (macOS): the command line is followed by the process environment
const QEMU = "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd taksi-36 -port";
const line = (pid: number, etime: string, port: number | null, env: string[]): string =>
  `${pid} ${etime} ${QEMU.replace(" -port", port === null ? "" : ` -port ${port}`)} -no-audio ${["HOME=/Users/x", ...env].join(" ")}`;
const PS = [
  "  100 05-01:00:00 /sbin/launchd",
  line(200, "00:30", 5700, ["VLAD_TASK_ID=T20261123-10"]),
  line(201, "03:10:00", 5702, ["VLAD_TASK_ID=T20261123-11"]),
  line(202, "01-02:00:00", 5704, []),
  "  203 00:40 /sdk/emulator/crashpad_handler --monitor-pid=200 VLAD_TASK_ID=T20261123-10",
  "  204 00:40 /sdk/emulator/netsimd --host-dns=1.1.1.1",
].join("\n");

type Calls = { adb: string[][]; kills: [number, string][]; alive: Set<number> };
function deps(o: { alive?: number[]; adbOk?: boolean | null; adbDies?: boolean; sigtermDies?: boolean; platform?: NodeJS.Platform } = {}): { d: EmuDeps; c: Calls } {
  const c: Calls = { adb: [], kills: [], alive: new Set(o.alive ?? [200, 201, 202]) };
  const d: EmuDeps = {
    platform: o.platform ?? "darwin",
    ps: () => PS,
    adb: (args) => {
      c.adb.push(args);
      if (o.adbOk === null) return null; // adb missing
      const port = Number(args[1]!.replace("emulator-", ""));
      if (o.adbDies !== false && o.adbOk !== false) for (const e of parseEmulators(PS)) if (e.port === port) c.alive.delete(e.pid);
      return o.adbOk !== false;
    },
    kill: (pid, sig) => { c.kills.push([pid, sig]); if (sig === "SIGKILL" || (sig === "SIGTERM" && o.sigtermDies !== false)) c.alive.delete(pid); },
    alive: (pid) => c.alive.has(pid),
    sleep: () => {},
  };
  return { d, c };
}

describe("parseEmulators (F-vlad-384)", () => {
  it("reads port, age and the owning task from the qemu process environment; helper processes are not emulators", () => {
    const e = parseEmulators(PS);
    expect(e.map((x) => [x.pid, x.port, x.owner])).toEqual([[200, 5700, "T20261123-10"], [201, 5702, "T20261123-11"], [202, 5704, null]]);
    expect(e.map((x) => x.ageSec)).toEqual([30, 3 * 3600 + 600, 86400 + 2 * 3600]);
  });
  it("no -port means the default 5554", () => {
    expect(parseEmulators(line(300, "10:00", null, ["VLAD_TASK_ID=T20261123-12"]))[0]).toMatchObject({ pid: 300, port: 5554, owner: "T20261123-12" });
  });
});

describe("listEmulators", () => {
  it("Windows (and an unreadable process list) is a silent no-op", () => {
    expect(listEmulators({ ...deps({ platform: "win32" }).d })).toEqual([]);
    expect(listEmulators({ ...deps().d, ps: () => null })).toEqual([]);
  });
});

describe("test guard", () => {
  it("VLAD_NO_NATIVE=1 keeps the default process list off the real machine (a test task id must never match a live worker's emulator)", () => {
    const old = process.env.VLAD_NO_NATIVE;
    process.env.VLAD_NO_NATIVE = "1";
    try {
      let called = false;
      expect(listEmulators({ platform: "darwin", ps: undefined })).toEqual([]);
      expect(killTaskEmulators("T20261123-38", { platform: "darwin", kill: () => { called = true; } })).toEqual([]);
      expect(called).toBe(false);
    } finally { if (old === undefined) delete process.env.VLAD_NO_NATIVE; else process.env.VLAD_NO_NATIVE = old; }
  });
});

describe("killTaskEmulators (F-vlad-384)", () => {
  it("kills only the task's own emulator through adb -s emulator-<port> emu kill", () => {
    const { d, c } = deps();
    const r = killTaskEmulators("T20261123-10", d);
    expect(c.adb).toEqual([["-s", "emulator-5700", "emu", "kill"]]);
    expect(c.kills).toEqual([]);
    expect(r).toEqual([{ port: 5700, pid: 200, action: "adb" }]);
  });
  it("another task's and the user's emulators are never touched", () => {
    const { d, c } = deps();
    expect(killTaskEmulators("T20261123-99", d)).toEqual([]);
    expect(c.adb).toEqual([]);
    expect(c.kills).toEqual([]);
  });
  it("adb missing: falls back to SIGTERM of that qemu pid only, without an error", () => {
    const { d, c } = deps({ adbOk: null });
    expect(killTaskEmulators("T20261123-11", d)).toEqual([{ port: 5702, pid: 201, action: "sigterm" }]);
    expect(c.kills).toEqual([[201, "SIGTERM"]]);
  });
  it("no answer to SIGTERM: last resort SIGKILL", () => {
    const { d, c } = deps({ adbOk: false, sigtermDies: false });
    expect(killTaskEmulators("T20261123-10", d)).toEqual([{ port: 5700, pid: 200, action: "sigkill" }]);
    expect(c.kills).toEqual([[200, "SIGTERM"], [200, "SIGKILL"]]);
  });
  it("a kill error is reported, not thrown", () => {
    const { d } = deps({ adbOk: null, sigtermDies: false });
    d.kill = () => { throw new Error("EPERM"); };
    expect(killTaskEmulators("T20261123-10", d)).toEqual([{ port: 5700, pid: 200, action: "failed", error: "EPERM" }]);
  });
  it("Windows: nothing is called", () => {
    const { d, c } = deps({ platform: "win32" });
    expect(killTaskEmulators("T20261123-10", d)).toEqual([]);
    expect(c.adb).toEqual([]);
    expect(c.kills).toEqual([]);
  });
});

describe("orphanEmulators / emulatorWarning (F-vlad-384)", () => {
  const TWO_H = 2 * 3600;
  it("lists emulators not bound to an active task that have been open for at least the threshold", () => {
    const { d } = deps();
    // T-10 active (young anyway), T-11 finished (3 h), unowned 202 (26 h)
    const o = orphanEmulators(new Set(["T20261123-10"]), d, TWO_H);
    expect(o.map((x) => x.port)).toEqual([5702, 5704]);
  });
  it("an emulator of an active task is never an orphan, however old", () => {
    const { d } = deps();
    expect(orphanEmulators(new Set(["T20261123-11", "T20261123-10"]), d, TWO_H).map((x) => x.port)).toEqual([5704]);
  });
  it("one warning line with port and age; null when nothing is orphaned or on Windows", () => {
    const { d } = deps();
    const w = emulatorWarning(new Set(["T20261123-10"]), d)!;
    expect(w.text).toContain("5702");
    expect(w.text).toContain("3 sa");
    expect(w.text).toContain("5704");
    expect(w.text).not.toContain("\n");
    expect(emulatorWarning(new Set(["T20261123-10", "T20261123-11"]), { ...d, ps: () => line(1, "00:10", 5700, []) })).toBeNull();
    expect(emulatorWarning(new Set(), { ...d, platform: "win32" })).toBeNull();
  });
});
