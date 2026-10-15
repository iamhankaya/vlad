import { describe, expect, it } from "vitest";
import { parseDoc, serializeDoc } from "../../src/kb/index.js";

describe("doc", () => {
  it("parses frontmatter and body", () => {
    const { data, body } = parseDoc<{ id: string }>("---\nid: T1\n---\n\n## Tanım\nx\n");
    expect(data.id).toBe("T1");
    expect(body).toBe("## Tanım\nx\n");
  });
  it("round-trips", () => {
    const text = serializeDoc({ id: "T1", n: 2 }, "## A\nx\n");
    const again = parseDoc(text);
    expect(again.data).toEqual({ id: "T1", n: 2 });
    expect(serializeDoc(again.data as object, again.body)).toBe(text);
  });
  it("handles CRLF", () => {
    const { data, body } = parseDoc<{ id: string }>("---\r\nid: T1\r\n---\r\n\r\nbody\r\n");
    expect(data.id).toBe("T1");
    expect(body).toBe("body\n");
  });
  it("keeps ISO dates as strings", () => {
    const { data } = parseDoc<{ created: string }>("---\ncreated: 2026-10-15T21:10:00+03:00\n---\n\nx\n");
    expect(typeof data.created).toBe("string");
  });
  it("throws plain Error without frontmatter", () => {
    expect(() => parseDoc("no front")).toThrow("frontmatter yok");
  });
});
