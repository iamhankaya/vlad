import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { swallowEpipe } from "../src/stdout.js";

describe("swallowEpipe", () => {
  it("swallows EPIPE on the stream (a closed reader must not crash the CLI)", () => {
    const s = new PassThrough();
    swallowEpipe(s);
    expect(() => s.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });
  it("still surfaces other errors", () => {
    const s = new PassThrough();
    swallowEpipe(s);
    expect(() => s.emit("error", Object.assign(new Error("disk"), { code: "EIO" }))).toThrow("disk");
  });
});
