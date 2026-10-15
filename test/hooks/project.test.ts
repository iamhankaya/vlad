import { describe, expect, it } from "vitest";
import { inferProject } from "../../src/hooks/project.js";

const projects = [{ slug: "watchparty", path: "C:\\dev\\watchparty" }];
const home = "C:\\dev\\vlad";

describe("inferProject", () => {
  it("matches case/separator-insensitively", () => {
    expect(inferProject("c:/dev/watchparty/src", projects, home)).toBe("watchparty");
  });
  it("matches worktree dir", () => {
    expect(inferProject("C:\\dev\\watchparty-wt\\T20261015-01", projects, home)).toBe("watchparty");
  });
  it("does not match sibling prefix", () => {
    expect(inferProject("C:\\dev\\watchpartyx", projects, home)).toBeNull();
  });
  it("vlad home", () => {
    expect(inferProject("C:\\dev\\vlad\\kb", projects, home)).toBe("vlad");
  });
  it("longest match wins", () => {
    const ps = [...projects, { slug: "inner", path: "C:\\dev\\watchparty\\inner" }];
    expect(inferProject("C:\\dev\\watchparty\\inner\\x", ps, home)).toBe("inner");
  });
});
