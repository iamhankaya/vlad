import { describe, expect, it } from "vitest";
import { appendToSection, getSection, setSection } from "../../src/kb/index.js";

const body = "## A\na1\n\n## B\nb1\n";

describe("sections", () => {
  it("getSection", () => {
    expect(getSection(body, "## A")).toBe("a1");
    expect(getSection(body, "## Z")).toBeNull();
  });
  it("appendToSection appends before next heading", () => {
    const out = appendToSection(body, "## A", "a2");
    expect(getSection(out, "## A")).toBe("a1\na2");
    expect(getSection(out, "## B")).toBe("b1");
  });
  it("appendToSection creates missing section", () => {
    const out = appendToSection(body, "## C", "c1");
    expect(getSection(out, "## C")).toBe("c1");
    expect(getSection(out, "## B")).toBe("b1");
  });
  it("setSection replaces only that section", () => {
    const out = setSection(body, "## A", "new");
    expect(getSection(out, "## A")).toBe("new");
    expect(getSection(out, "## B")).toBe("b1");
  });
});
