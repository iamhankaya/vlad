import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RemoteError, TRANSIENT_CODES, type AgentCode } from "../../src/machines/index.js";
import { exitCodeFor, remoteErrorDetails } from "../../src/machines/exit.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => { home = makeHome(); });
const vlad = (args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("machines:S exit codes", () => {
  it.each([...TRANSIENT_CODES])("transient RemoteError %s -> 75", (code) => {
    expect(exitCodeFor(new RemoteError(code, "x", "windows"))).toBe(75);
  });
  it.each(["forbidden", "failed", "bad_request", "not_found", "conflict", "uncertain", "too_large"] as AgentCode[])("permanent RemoteError %s -> 1", (code) => {
    expect(exitCodeFor(new RemoteError(code, "x"))).toBe(1);
  });
  it("other errors stay 1 (kb lock timeout stays 1: existing tests assert it)", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(1);
  });
  it("RemoteError details carry code and machine", () => {
    expect(remoteErrorDetails(new RemoteError("auth", "auth: imza geçersiz", "windows"))).toEqual(["code: auth", "machine: windows"]);
    expect(remoteErrorDetails(new Error("x"))).toEqual([]);
  });
});

describe("machines:S cli skeleton", () => {
  it("--help lists the new command groups", () => {
    const r = vlad(["--help"]); const h = r.out + r.err;
    for (const g of ["agent", "queue", "machine", "remote"]) expect(h).toMatch(new RegExp(`^ +${g} `, "m"));
  });
  it("task list --fields accepts the machine fields", () => {
    const r = vlad(["task", "list", "--fields", "id,machine,machine_reserved,launch_op", "--json"]);
    expect(r.code).toBe(0);
  });
});
