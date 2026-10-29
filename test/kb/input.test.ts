import { describe, expect, it } from "vitest";
import { readStdinSync } from "../../src/kb/input.js";

const eagain = () => Object.assign(new Error("EAGAIN: resource temporarily unavailable, read"), { code: "EAGAIN" });

describe("F-vlad-008/ readStdinSync", () => {
  it("retries reads that fail with EAGAIN on a non-blocking pipe", () => {
    const chunks = [eagain(), "ab", eagain(), "cd", null];
    const read = () => { const c = chunks.shift(); if (c instanceof Error) throw c; return c ? Buffer.from(c) : Buffer.alloc(0); };
    expect(readStdinSync(read, () => {})).toBe("abcd");
  });

  it("rethrows other errors", () => {
    expect(() => readStdinSync(() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); }, () => {})).toThrow(/EIO/);
  });

  it("gives up when EAGAIN never clears", () => {
    expect(() => readStdinSync(() => { throw eagain(); }, () => {})).toThrow(/EAGAIN/);
  });

  it("EAGAIN budget counts consecutive waits, not total", () => {
    let i = 0;
    const read = () => { if (i++ >= 6000) return Buffer.alloc(0); if (i % 2) throw eagain(); return Buffer.from("x"); };
    expect(readStdinSync(read, () => {})).toHaveLength(3000);
  });
});
