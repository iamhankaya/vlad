import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmpState } from "../helpers/client.ts";

const cli = new URL("../../src/cli.ts", import.meta.url).pathname;

describe("vlad-server pair", () => {
  it("prints a code the API process can redeem, keeps only a hash on disk", () => {
    const dir = tmpState();
    const out = spawnSync("node", [cli, "pair"], { env: { ...process.env, VLAD_SERVER_STATE_DIR: dir }, encoding: "utf8" });
    expect(out.status).toBe(0);
    const code = /Eşleştirme kodu: ([0-9A-Z]{8})/.exec(out.stdout)![1]!;
    const files = readdirSync(join(dir, "pairing"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(code);
    expect(statSync(join(dir, "pairing", files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("unknown command exits 2", () => {
    expect(spawnSync("node", [cli, "bogus"], { encoding: "utf8" }).status).toBe(2);
  });
});
