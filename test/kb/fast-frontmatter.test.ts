import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { fastFrontmatter } from "../../src/kb/frontmatter-fast.js";
import { parseDoc } from "../../src/kb/index.js";

// T20261126-25: the fast path must give exactly what `yaml` (core schema) gives, or step aside (undefined)
const viaYaml = (src: string): unknown => parse(src, { schema: "core", logLevel: "error" }) ?? {}; // fuzz input triggers tag warnings; the fast path steps aside for those anyway
const same = (src: string): void => {
  const fast = fastFrontmatter(src);
  let ref: unknown;
  try { ref = viaYaml(src); } catch { expect(fast, `yaml rejects: ${JSON.stringify(src)}`).toBeUndefined(); return; }
  if (fast !== undefined) expect(fast, JSON.stringify(src)).toStrictEqual(ref);
};

describe("fastFrontmatter", () => {
  it("handles the shapes the kb writes", () => {
    const src = [
      "id: T20261126-25", "project: vlad", "kind: dev", "state: running", "worktree: /Users/x/dev/vlad-wt/T1", "session_id: null",
      "created: 2026-11-26T21:08:08+03:00", "error: null", "depends_on: []", "digested: true", "fixed: false", "count: 12", "zero: 0",
      "title: \"VLAD CLI hızlandırma (TS): status --summary tek geçiş, kb search\n  normalize, tembel import\"",
      "model_reason: Kullanıcı açık onayı 2026-11-26 (limit kullanımı, performans işi)", "path: C:\\dev\\vlad", "q: 'tek tırnak'",
      "stack:", "  - typescript", "  - \"node: 22\"", "roots:", "- /a", "- b c",
    ].join("\n");
    expect(fastFrontmatter(src)).toBeDefined();
    same(src);
  });

  it("handles folded plain strings and one-level maps (findings, older tasks)", () => {
    const src = [
      "title: Agent journal sonuç boyutu sınırsız (3 MiB'a kadar exec çıktısı 14 gün);", "  ~64 KiB kırpılmalı",
      "experiment:", "  ponytail: off", "  n: 2", "  note: \"a b\"", "fixed_by: T20261102-07",
    ].join("\n");
    expect(fastFrontmatter(src)).toStrictEqual({
      title: "Agent journal sonuç boyutu sınırsız (3 MiB'a kadar exec çıktısı 14 gün); ~64 KiB kırpılmalı",
      experiment: { ponytail: "off", n: 2, note: "a b" }, fixed_by: "T20261102-07",
    });
    same(src);
  });

  it("agrees with yaml on what the serializer produces (folded long strings included)", () => {
    const words = "kısa uzun ve: başka 'tırnak' \"çift\" - # ok, [x] {y} %z @w `b` a:b ı İ ş ğ ü ö ç".split(" ");
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 400; n++) {
      const o: Record<string, unknown> = {};
      const keys = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < keys; k++) {
        const r = rnd();
        const str = Array.from({ length: Math.floor(rnd() * 30) }, () => words[Math.floor(rnd() * words.length)]).join(rnd() < 0.1 ? "  " : " ");
        o[`k${k}`] = r < 0.1 ? null : r < 0.2 ? rnd() < 0.5 : r < 0.3 ? Math.floor(rnd() * 1000) : r < 0.4 ? [str, "x"] : r < 0.45 ? [] : str;
      }
      const src = stringify(o, { schema: "core" }).replace(/\n$/, "");
      same(src);
    }
  });

  it("steps aside for anything outside the narrow grammar", () => {
    for (const src of [
      "", "a: 1\na: 2", "a: ~", "a: Null", "a: TRUE", "a: 1.5", "a: 0x1f", "a: 007", "a: .inf", "a: -3", "a: +3", "a: 12345678901234567",
      "a: b: c", "a: x # c", "# c\na: 1", "a: |\n  x", "a: >\n  x", "a: \"x\\ny\"", "a: 'it''s'", "a: [x, y]", "a: {}", "a: &x 1", "a: *x",
      "a: !t x", "a: x\n  y: z", "\"a\": 1", "a:  x\t", "a: \"x\n\n  y\"", "a: 'x\n  y'", "a:\n  -", "a:\n  - [x]", "__proto__: x",
      "a: @x", "a: `x`", "a: %x", "a: -", "a: ? x", "a: \"unterminated", "a: x\n\nb: y", "a: \"x\" y",
      "a: x\n  b: c", "a: x\n  # c", "a: x\n  - y", "a: 1\n  2", "a: null\n  x", "a: x\n\ty", "a:\n  b: 1\n   c: 2", "a:\n  b: 1\n  b: 2",
      "a:\n  b:\n    c: 1", "a:\n  b: 1\n  - c", "a:\n  __proto__: 1", "a:\n  b: x\n    y",
      "null: x", "a:\n  null: 1", // yaml resolves a `null` key to "" (review T20261126-25)
    ]) {
      same(src);
      if (src !== "") expect(fastFrontmatter(src), src).toBeUndefined();
    }
  });

  it("fuzz: random lines over a risky alphabet never disagree with yaml", () => {
    const pieces = ["a: ", "b: ", "c:", "  ", " ", "\t", "\n", "\n  ", "\n  - ", "\n- ", "x", "ş", "1", "0", "-", ":", "#", "'", "\"", "\\", "[", "]", "{", "}", ",", "~", "null", "true", "|", ">", "&", "*", "!", "%", "@", "`", "?", ".", "e", "İ"];
    let seed = 99;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let hits = 0;
    for (let n = 0; n < 6000; n++) {
      let src = rnd() < 0.5 ? "a: " : "a:\n  ";
      const len = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < len; i++) src += pieces[Math.floor(rnd() * pieces.length)];
      same(src);
      if (fastFrontmatter(src) !== undefined) hits++;
    }
    expect(hits).toBeGreaterThan(100); // the fuzz must exercise the fast path, not only the fallback
  });

  it("agrees with yaml on hand-picked folding edge cases", () => {
    for (const src of [
      "a: x\n  y", "a: x \n  y", "a: x\n\t y", "a: x\n  y\n  z", "a: \"x \n  y \"", "a: \"x\n  y\n  z\"", "a: x\n  y\nb: 1",
      "a:\n  b: 1", "a:\n  b: on\n  c: \"q\"\nd: e", "a:\n  - x\nb:\n  c: 1", "a: x\n  ~y", "a: x\n  1",
    ]) same(src);
  });

  it("parseDoc gives the same document with and without the fast path", () => {
    const text = "---\nid: T1\ntitle: \"uzun\n  başlık\"\ndepends_on: []\n---\n\n## Tanım\nx\n";
    const { data, body } = parseDoc(text);
    expect(data).toStrictEqual({ id: "T1", title: "uzun başlık", depends_on: [] });
    expect(body).toBe("## Tanım\nx\n");
  });
});
