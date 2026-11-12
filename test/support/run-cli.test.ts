import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { runCli } from "./run-cli.js";
import { spawnVlad } from "./spawn-vlad.js";

let home: string;
beforeEach(() => { home = makeHome(); });

describe("runCli (in-process CLI, F-vlad-071)", () => {
  it("returns the same code/stdout as the dist child for a real command", async () => {
    const env = { VLAD_HOME: home };
    const a = await runCli(["mode", "status"], { env });
    const b = spawnVlad({ args: ["mode", "status"], env });
    expect({ code: a.code, out: a.out }).toEqual({ code: b.status, out: b.stdout });
    expect(a.out).toMatch(/mod kapalı/);
  });

  it("maps a failing command to exit 1 with the error on stderr (no throw)", async () => {
    const r = await runCli(["mode", "watch", "maybe", "--json"], { env: { VLAD_HOME: home } });
    const child = spawnVlad({ args: ["mode", "watch", "maybe", "--json"], env: { VLAD_HOME: home } });
    expect(r.code).toBe(1);
    expect(r).toMatchObject({ code: child.status, err: child.stderr });
    expect(r.err).toContain("on ya da off ver");
  });

  it("restores process.env after the call", async () => {
    const before = process.env.VLAD_HOME;
    await runCli(["mode", "status"], { env: { VLAD_HOME: home } });
    expect(process.env.VLAD_HOME).toBe(before);
  });

  it("rejects stdin input instead of hanging", async () => {
    await expect(runCli(["mode", "status"], { input: "x" })).rejects.toThrow(/stdin/);
  });
});
