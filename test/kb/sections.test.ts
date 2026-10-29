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
  it("a '## ' line inside a code fence does not end the section (F-vlad-075)", () => {
    const fenced = "## A\na1\n```md\n## not a heading\n```\na2\n\n## B\nb1\n";
    expect(getSection(fenced, "## A")).toBe("a1\n```md\n## not a heading\n```\na2");
    expect(getSection(fenced, "## B")).toBe("b1");
    expect(getSection(fenced, "## not a heading")).toBeNull();
  });
  it("an unclosed fence does not hide later headings", () => {
    const t = "## A\na1\n```\ntruncated log\n\n## B\nb1\n";
    expect(getSection(t, "## B")).toBe("b1");
  });
  it("a longer outer fence and a different fence char nest correctly", () => {
    const t = "## A\n````md\n```\n## x\n~~~\n````\n\n## B\nb1\n";
    expect(getSection(t, "## A")).toBe("````md\n```\n## x\n~~~\n````");
    expect(getSection(t, "## B")).toBe("b1");
  });
});
