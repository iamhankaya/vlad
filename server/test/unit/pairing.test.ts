import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCode, PAIR_TTL_MS, PairingCodes } from "../../src/auth/pairing.ts";
import { Clock, tmpState } from "../helpers/client.ts";

const mk = () => {
  const clock = new Clock();
  const dir = tmpState();
  return { clock, dir, codes: new PairingCodes(dir, clock.now) };
};

describe("pairing codes", () => {
  it("issues 8 Crockford base32 characters (no I L O U)", () => {
    const { codes } = mk();
    for (let i = 0; i < 200; i++) expect(codes.issue().code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("stores only the hash, never the code", () => {
    const { codes, dir } = mk();
    const { code } = codes.issue();
    const files = readdirSync(join(dir, "pairing"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain(code);
    expect(statSync(join(dir, "pairing", files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "pairing")).mode & 0o777).toBe(0o700);
  });

  it("is single use", () => {
    const { codes } = mk();
    const { code } = codes.issue();
    expect(codes.redeem(code)).toBe(true);
    expect(codes.redeem(code)).toBe(false);
  });

  it("accepts lower case and Crockford look-alikes", () => {
    expect(normalizeCode("o1il0abc")).toBe("01110ABC");
    const { codes } = mk();
    const { code } = codes.issue();
    expect(codes.redeem(code.toLowerCase())).toBe(true);
  });

  it("expires after 10 minutes (the boundary is exclusive)", () => {
    const { codes, clock } = mk();
    const a = codes.issue().code;
    clock.t += PAIR_TTL_MS - 1;
    expect(codes.redeem(a)).toBe(true);
    const b = codes.issue().code;
    clock.t += PAIR_TTL_MS;
    expect(codes.redeem(b)).toBe(false);
  });

  it("burns after 5 wrong attempts; the correct code no longer works", () => {
    const { codes } = mk();
    const { code } = codes.issue();
    for (let i = 0; i < 4; i++) expect(codes.redeem("AAAAAAAA")).toBe(false);
    expect(codes.redeem("AAAAAAAA")).toBe(false); // 5th wrong attempt
    expect(codes.redeem(code)).toBe(false);
  });

  it("4 wrong attempts do not burn it", () => {
    const { codes } = mk();
    const { code } = codes.issue();
    for (let i = 0; i < 4; i++) codes.redeem("AAAAAAAA");
    expect(codes.redeem(code)).toBe(true);
  });

  it("counts malformed codes as failures too", () => {
    const { codes } = mk();
    const { code } = codes.issue();
    for (let i = 0; i < 5; i++) codes.redeem("UUUUUUUU");
    expect(codes.redeem(code)).toBe(false);
  });

  it("deletes expired files", () => {
    const { codes, clock, dir } = mk();
    codes.issue();
    clock.t += PAIR_TTL_MS + 1;
    codes.redeem("AAAAAAAA");
    expect(existsSync(join(dir, "pairing")) && readdirSync(join(dir, "pairing"))).toEqual([]);
  });
});
