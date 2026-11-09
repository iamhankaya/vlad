import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { kbPaths } from "../../src/kb/index.js";
import { addFinding, setFindingState } from "../../src/findings/store.js";
import { relatedOpenFindings, similarOpenFindings, titleSimilarity, SIMILAR_MIN_MATCHES, SIMILAR_THRESHOLD } from "../../src/findings/similar.js";
import { makeHome } from "../helpers.js";

// real pair (F-vlad-desktop-166 / F-177): same root cause, F-177 was closed and its twin stayed open
const T166 = "Ses: iptal edilen yakalama açılışı wake dinlemesini kapalı bırakabiliyor";
const T177 = "Ses: WakeSessionTests yük altında kararsız (gate kırmızısı)";

const add = (title: string, o: { project?: string; state?: string } = {}) => {
  const project = o.project ?? "alpha";
  writeFileSync(join(kbPaths().projects, `${project}.md`), "---\nslug: x\n---\n");
  return addFinding({ project, severity: "orta", source: "T20261022-01", title, state: o.state });
};

describe("titleSimilarity", () => {
  it("flags the F-166/F-177 pair (turkish folding + prefix match)", () => {
    const s = titleSimilarity(T166, T177);
    expect(s.matches).toBeGreaterThanOrEqual(SIMILAR_MIN_MATCHES);
    expect(s.score).toBeGreaterThanOrEqual(SIMILAR_THRESHOLD);
  });
  it("does not flag unrelated titles", () => {
    const s = titleSimilarity(T166, "Gate: build.ps1 izin reddi nedeniyle Windows koşusu başarısız");
    expect(s.matches < SIMILAR_MIN_MATCHES || s.score < SIMILAR_THRESHOLD).toBe(true);
  });
  it("is case/diacritic-insensitive", () => {
    expect(titleSimilarity("KIRMIZI Gate Hatası", "kirmizi gate hatasi").score).toBe(1);
  });
});

describe("similarOpenFindings / relatedOpenFindings", () => {
  beforeEach(() => { makeHome(); });
  it("returns open twins, skips closed ones and other projects", () => {
    const a = add(T177);
    add(T177, { project: "beta" });
    const closed = add(T177);
    setFindingState(closed.data.id, "fixed");
    const r = similarOpenFindings("alpha", T166);
    expect(r.map((f) => f.data.id)).toEqual([a.data.id]);
  });
  it("related: matches findings by file/module words in the task text, else newest N", () => {
    add("wake dinlemesi kapalı kalıyor");
    const b = add("tamamen başka konu: parser");
    expect(relatedOpenFindings("alpha", "parser modülünü düzelt").map((f) => f.data.id)).toEqual([b.data.id]);
    for (let i = 0; i < 20; i++) add(`ilgisiz bulgu ${i}`);
    const fallback = relatedOpenFindings("alpha", "hiçbir eşleşme yok zzzz", 15);
    expect(fallback).toHaveLength(15);
    expect(relatedOpenFindings("alpha", "hiçbir eşleşme yok zzzz", 15)[0]!.data.title).toBe("ilgisiz bulgu 19");
  });
});
