import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addFinding } from "../../src/findings/store.js";
import { addDecision } from "../../src/kb/decisions.js";
import { appendJournal } from "../../src/kb/journal.js";
import { maintainKb } from "../../src/kb/maintain.js";
import { normalize, searchKb } from "../../src/kb/search.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, setState } from "../../src/tasks/store.js";
import { makeHome } from "../helpers.js";

const card = (slug: string) => `---\nslug: ${slug}\nname: ${slug}\npath: C:\\dev\\${slug}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`;
const NOW = new Date(2026, 9, 30, 12, 0, 0);
beforeEach(() => {
  makeHome();
  writeProject("watchparty", card("watchparty"));
  writeProject("vlad", card("vlad"));
});

describe("normalize", () => {
  it("folds Turkish case and diacritics char by char (length kept)", () => {
    expect(normalize("İŞLEM Dönüştürme IĞDIR")).toBe("islem donusturme igdir");
    expect(normalize("ÇAĞRI üç")).toHaveLength(8);
  });
  // T20261126-25: the fast path must stay byte-identical to the original per-character fold
  const reference = (s: string): string => {
    let out = "";
    for (const ch of s) {
      const c = ch === "İ" || ch === "I" || ch === "ı" ? "i" : ch.toLowerCase();
      out += c.normalize("NFD")[0];
    }
    return out;
  };
  it("matches the per-character reference on Turkish, combining, astral and odd input", () => {
    const samples = [
      "", "abc XYZ 123 _-./:", "İŞLEM ığdır IĞDIR ıi Iİ", "ŞşĞğÜüÖöÇç Ââ Îî Ûû", "Straße ẞ ǅ ǈ Σς ΣΑΣ", "é Å ñ",
      "😀 emoji 👍🏽 🇹🇷 ok", "\ud800 lone \udc00 surrogates", "ﬁ ﬀ ŉ ǰ ΐ", "Ⅻ ⅻ Ⓐ ＡＢＣ", "tab\tnew\nline\r\n", "İIı",
    ];
    for (const s of samples) expect(normalize(s)).toBe(reference(s));
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      let s = "";
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i++) s += String.fromCharCode(rnd() < 0.5 ? Math.floor(rnd() * 128) : Math.floor(rnd() * 0xffff));
      expect(normalize(s)).toBe(reference(s));
    }
  });
});

describe("searchKb", () => {
  it("finds a decision block with id, status, snippet and real path", () => {
    addDecision({ project: "watchparty", title: "Ses dönüştürme yalnız yerel", body: "- **Karar:** Tarayıcıda çalmayan ses yalnız yerelde dönüştürülür" }, NOW);
    addDecision({ project: "vlad", title: "Başka", body: "- **Karar:** alakasız" }, NOW);
    const r = searchKb({ query: "SES DÖNÜŞTÜRME", project: "watchparty" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "D-watchparty-001", type: "decision", status: "geçerli", date: "2026-10-30" });
    expect(r[0].path.replace(/\\/g, "/")).toMatch(/kb\/decisions\/watchparty\.md$/);
    expect(r[0].snippet.length).toBeLessThanOrEqual(240);
  });
  it("matches without diacritics and with a Turkish suffix", () => {
    addDecision({ project: "watchparty", title: "Ses dönüştürme", body: "- **Karar:** dönüştürülür" }, NOW);
    expect(searchKb({ query: "donusturmeyi" }).map((h) => h.id)).toEqual(["D-watchparty-001"]);
    expect(searchKb({ query: "yokboyle" })).toEqual([]);
  });
  it("ranks a geçerli decision above a task that merely mentions the words", () => {
    createTask({ project: "vlad", title: "Ses dönüştürme işi", kind: "dev", body: "## Tanım\nses dönüştürme" });
    addDecision({ project: "vlad", title: "Ses dönüştürme yerel", body: "- **Karar:** yerel" }, NOW);
    expect(searchKb({ query: "ses dönüştürme" })[0].type).toBe("decision");
  });
  it("finds general decisions with --project genel and keeps same-day unmigrated blocks apart", () => {
    addDecision({ project: "Genel Kural", title: "Genel karar", body: "- **Karar:** kural" }, NOW);
    expect(searchKb({ query: "kural", project: "genel" }).map((h) => h.id)).toEqual(["D-genel-001"]);
    mkdirSync(join(process.env.VLAD_HOME!, "kb", "decisions"), { recursive: true });
    writeFileSync(join(process.env.VLAD_HOME!, "kb", "decisions", "vlad.md"), "# K\n\n### 2026-10-01 — vlad — Bir\n- **Karar:** zebra\n\n### 2026-10-01 — vlad — İki\n- **Karar:** zebra\n");
    expect(searchKb({ query: "zebra" })).toHaveLength(2);
  });
  it("requires every query word", () => {
    addDecision({ project: "vlad", title: "A", body: "- **Karar:** kedi köpek" }, NOW);
    addDecision({ project: "vlad", title: "B", body: "- **Karar:** kedi" }, NOW);
    expect(searchKb({ query: "kedi köpek" }).map((h) => h.id)).toEqual(["D-vlad-001"]);
  });
  it("finds tasks at section level, including archived ones", () => {
    const t = createTask({ project: "vlad", title: "Arşivlik görev", kind: "dev", body: "## Tanım\nzürafa yemi\n\n## Kabul kriterleri\n- [ ] x" }, new Date(2026, 8, 1));
    setState(t.data.id, "running"); setState(t.data.id, "awaiting_approval"); setState(t.data.id, "done");
    expect(searchKb({ query: "zürafa" })[0]).toMatchObject({ id: t.data.id, type: "task", section: "## Tanım" });
    // done tasks are archived only once digested; stamp it and age the task directly
    writeFileSync(t.file, readFileSync(t.file, "utf8").replace(/^updated: .*$/m, "updated: 2026-09-01T10:00:00+03:00\ndigested: 2026-09-02T10:00:00+03:00"));
    maintainKb({ now: NOW });
    const arch = searchKb({ query: "zürafa" });
    expect(arch[0].id).toBe(t.data.id);
    expect(arch[0].path.replace(/\\/g, "/")).toContain("/tasks/archive/2026-09/");
  });
  it("strips only known suffixes: kararları finds karar, basarisiz no longer finds basarili", () => {
    addDecision({ project: "vlad", title: "Karar", body: "- **Karar:** build basarili" }, NOW);
    expect(searchKb({ query: "kararları" }).map((h) => h.id)).toEqual(["D-vlad-001"]);
    expect(searchKb({ query: "basarisiz" })).toEqual([]);
  });
  it("finds findings and journal sections; type, project and limit narrow", () => {
    addFinding({ project: "vlad", severity: "orta", source: "T20261030-01", title: "Denetim eksik", detail: "yavaş liste" });
    appendJournal("2026-10-29", "## vlad\n- yavaş liste ölçüldü\n## watchparty\n- başka");
    const all = searchKb({ query: "yavaş liste" });
    expect(all.map((h) => h.type).sort()).toEqual(["finding", "journal"]);
    expect(searchKb({ query: "yavaş liste", type: "journal" })).toHaveLength(1);
    expect(searchKb({ query: "yavaş liste", project: "watchparty" })).toEqual([]);
    expect(searchKb({ query: "yavaş", limit: 1 })).toHaveLength(1);
  });
  it("project type: searches only Çalışma notları, Açık konular and Durum özeti of cards; project filter and section are reported (T20261126-09)", () => {
    writeProject("watchparty", `${card("watchparty")}\n## Mimari notlar\n- kuyruk kilidi burada\n\n## Açık konular\n- kuyruk kilidi yarış\n\n## Çalışma notları\n- test ortamında kuyruk sıfırlanır\n\n## Durum özeti\nson durum: kuyruk temiz\n`);
    writeProject("vlad", `${card("vlad")}\n## Çalışma notları\n- kuyruk farklı\n`);
    const r = searchKb({ query: "kuyruk", type: "project" });
    expect(r.map((h) => `${h.project}${h.section}`).sort()).toEqual(["vlad## Çalışma notları", "watchparty## Açık konular", "watchparty## Durum özeti", "watchparty## Çalışma notları"]);
    expect(r[0]).toMatchObject({ type: "project", id: expect.stringMatching(/^project:/) });
    expect(r[0]!.relative).toMatch(/^projects\/.+\.md$/);
    expect(searchKb({ query: "kuyruk", type: "project", project: "vlad" })).toHaveLength(1);
    expect(searchKb({ query: "kilidi", type: "project" }).map((h) => h.section)).toEqual(["## Açık konular"]); // Mimari notlar is not searched
  });
  it("rejects an empty query and an unknown type", () => {
    expect(() => searchKb({ query: "  " })).toThrow(/sorgu/);
    expect(() => searchKb({ query: "x", type: "bozuk" })).toThrow(/tür/);
  });
});
