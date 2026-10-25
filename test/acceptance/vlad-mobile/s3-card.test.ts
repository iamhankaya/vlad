// T1 kabul: S3a (card) — plan §Kayıt şemaları `card`, §S3a. Hata sözleşmesi: stderr {"error","details"} + çıkış 1.
// Plan sapması (açık nokta): `card new --kind action_request` plan arayüzünde `--sha` yok; uygulama 40 haneli `--sha`'yı zorunlu kılıyor
// (güvenlik incelemesi sonrası). Testler bunu `ACTION` yardımcısında verir; sapma raporda.
import { beforeEach, describe, expect, it } from "vitest";
import { fail, newHome, ok, runAsync, sha40, writeProjectCard, run } from "./helpers.js";

let home: string;
beforeEach(() => { home = newHome(); writeProjectCard(home); });

// Plan sapması: action_request kartı `--option` kabul etmez (sabit approve/reject); diğer türler seçenek alır.
const newCard = (extra: string[] = [], kind = "vlad_question", title = "Soru") =>
  ok<{ id: string }>(home, ["card", "new", "--kind", kind, "--project", "alpha", "--title", title,
    ...(kind === "action_request" ? [] : ["--option", "a=Evet", "--option", "b=Hayır"]), ...extra]).id;
const ACTION = (repo = "acme/alpha") => ["--action-kind", "merge_phase", "--sha", sha40(), "--repo", repo, "--pr", "42", "--base", "vlad/T20261024-94"];
const show = (id: string) => ok<any>(home, ["card", "show", id]);

describe("records: card new/list/show/answer/resolve (S3a)", () => {
  it("records: card new/list/answer — open card with options, listed, answered with by_device", () => {
    const id = newCard();
    expect(id).toMatch(/^C-\d{8}-\d{2}$/);
    const c = show(id);
    expect(c).toMatchObject({ id, kind: "vlad_question", project: "alpha", state: "open", title: "Soru", answer: null });
    expect(c.options).toEqual([{ id: "a", label: "Evet" }, { id: "b", label: "Hayır" }]);
    expect(Number.isNaN(Date.parse(c.created))).toBe(false);
    expect(Number.isNaN(Date.parse(c.updated))).toBe(false);
    expect(ok<any>(home, ["card", "list"]).cards.map((x: any) => x.id)).toEqual([id]);

    ok(home, ["card", "answer", id, "--option", "a", "--by-device", "dev-1"]);
    const a = show(id);
    expect(a.answer).toMatchObject({ option: "a", by_device: "dev-1" });
    expect(Number.isNaN(Date.parse(a.answer.at))).toBe(false);
  });
  it("answer with free text only", () => {
    const id = newCard();
    ok(home, ["card", "answer", id, "--text", "Şöyle yapalım: ığüşöç", "--by-device", "dev-1"]);
    expect(show(id).answer.text).toBe("Şöyle yapalım: ığüşöç");
  });
  it("answer needs --option or --text", () => {
    const id = newCard();
    fail(home, ["card", "answer", id, "--by-device", "dev-1"]);
    expect(show(id).answer).toBeNull();
  });
  it("records: card answer twice -> zaten cevaplandı (second answer rejected, first kept)", () => {
    const id = newCard();
    ok(home, ["card", "answer", id, "--option", "a", "--by-device", "dev-1"]);
    const e = fail(home, ["card", "answer", id, "--option", "b", "--by-device", "dev-2"]);
    expect(e.error).toContain("zaten cevaplandı");
    expect(show(id).answer).toMatchObject({ option: "a", by_device: "dev-1" });
  });
  it("answering an unknown card errors", () => {
    fail(home, ["card", "answer", "C-19990101-01", "--option", "a", "--by-device", "d"]);
    fail(home, ["card", "show", "C-19990101-01"]);
  });
  it("resolve closes an open card (state resolved) and filters work", () => {
    const a = newCard(), b = newCard([], "ci_red", "Kırmızı");
    ok(home, ["card", "resolve", a]);
    expect(show(a).state).toBe("resolved");
    expect(ok<any>(home, ["card", "list", "--state", "open"]).cards.map((x: any) => x.id)).toEqual([b]);
    expect(ok<any>(home, ["card", "list", "--state", "resolved"]).cards.map((x: any) => x.id)).toEqual([a]);
    expect(ok<any>(home, ["card", "list", "--state", "open,resolved"]).cards).toHaveLength(2);
    expect(ok<any>(home, ["card", "list", "--kind", "ci_red"]).cards.map((x: any) => x.id)).toEqual([b]);
    expect(ok<any>(home, ["card", "list", "--project", "alpha"]).cards).toHaveLength(2);
    expect(ok<any>(home, ["card", "list", "--project", "yok"]).cards).toEqual([]);
  });
  it("list filters reject unknown states and kinds", () => {
    fail(home, ["card", "list", "--state", "bogus"]);
    fail(home, ["card", "list", "--kind", "bogus"]);
  });
  it("records: card invalid kind rejected (all five valid kinds accepted)", () => {
    const e = fail(home, ["card", "new", "--kind", "bogus", "--project", "alpha", "--title", "x"]);
    expect(e.error).toContain("bogus");
    for (const k of ["ci_red", "conflict", "vlad_question", "kb_conflict"]) newCard([], k);
    newCard(ACTION(), "action_request");
    expect(ok<any>(home, ["card", "list"]).cards).toHaveLength(5);
  });
  it("card new requires --project, --title and --kind", () => {
    fail(home, ["card", "new", "--project", "alpha", "--title", "x"]);
    fail(home, ["card", "new", "--kind", "ci_red", "--title", "x"]);
    fail(home, ["card", "new", "--kind", "ci_red", "--project", "alpha"]);
  });
  it("card for a task keeps the task link", () => {
    const tid = ok<any>(home, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-"], { input: "## Tanım\nx\n" }).id;
    const id = newCard(["--task", tid]);
    expect(show(id).task).toBe(tid);
  });
  it("hostile title text is stored verbatim (no frontmatter/shell injection)", () => {
    const title = "x\n---\nstate: resolved\n--- `$(id)` ; İ";
    const r = run(home, ["card", "new", "--kind", "vlad_question", "--project", "alpha", "--title", title, "--json"]);
    if (r.code === 0) {
      const c = show(JSON.parse(r.out).id);
      expect(c.state).toBe("open");
      expect(c.title.replace(/\s+/g, " ")).toContain("state: resolved");
    } else {
      expect(JSON.parse(r.err).error).toBeTruthy(); // reddetmek de kabul edilebilir
    }
  });
});

describe("records: card ids and concurrency (S3a)", () => {
  it("records: card id rolls past 99/day (C-YYYYMMDD-100, three digits) ", async () => {
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const rs = await Promise.all(Array.from({ length: 10 }, () =>
        runAsync(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "t", "--json"])));
      for (const r of rs) { expect(r.code, r.err).toBe(0); ids.push(JSON.parse(r.out).id); }
    }
    expect(new Set(ids).size).toBe(100);
    const days = new Map<string, string[]>();
    for (const id of ids) {
      const m = /^C-(\d{8})-(\d{2,3})$/.exec(id);
      expect(m, id).not.toBeNull();
      days.set(m![1], [...(days.get(m![1]) ?? []), m![2]]);
    }
    // gece yarısı koşu sırasında geçerse (çok nadir) yalnız biçim/tekillik doğrulanır
    if (days.size === 1) {
      const suffixes = [...days.values()][0].sort();
      expect(suffixes).toContain("99");
      expect(suffixes).toContain("100");
      expect(suffixes.filter((s) => s.length === 3)).toEqual(["100"]);
      expect(suffixes.filter((s) => s.length === 2)).toHaveLength(99);
    }
  }, 180_000);
  it("records: concurrent card new unique ids", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      runAsync(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", `t${i}`, "--json"])));
    expect(rs.filter((r) => r.code !== 0).map((r) => r.err)).toEqual([]);
    const ids = rs.map((r) => JSON.parse(r.out).id);
    expect(new Set(ids).size).toBe(20);
    expect(ok<any>(home, ["card", "list"]).cards).toHaveLength(20);
  }, 120_000);
  it("records: concurrent card answer one wins", async () => {
    const id = newCard();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      runAsync(home, ["card", "answer", id, "--text", `cevap-${i}`, "--by-device", `dev-${i}`, "--json"])));
    const winners = rs.map((r, i) => ({ r, i })).filter((x) => x.r.code === 0);
    expect(winners).toHaveLength(1);
    for (const x of rs.filter((x) => x.code !== 0)) expect(JSON.parse(x.err).error).toContain("zaten cevaplandı");
    const a = show(id).answer;
    expect(a.text).toBe(`cevap-${winners[0].i}`);
    expect(a.by_device).toBe(`dev-${winners[0].i}`);
  }, 120_000);
});

describe("records: action_request (S3a)", () => {
  it("records: action_request repo outside project allowlist rejected ('repo izin listesinde değil')", () => {
    const e = fail(home, ["card", "new", "--kind", "action_request", "--project", "alpha", "--title", "m", ...ACTION("evil/other")]);
    expect(e.error).toBe("repo izin listesinde değil");
    expect(ok<any>(home, ["card", "list"]).cards).toEqual([]);
  });
  it("action_request for the project's own repo is accepted and carries action {kind, repo, pr, base}", () => {
    const id = newCard(ACTION(), "action_request", "Merge et");
    const c = show(id);
    expect(c.kind).toBe("action_request");
    expect(c.action).toMatchObject({ kind: "merge_phase", repo: "acme/alpha", pr: 42, base: "vlad/T20261024-94" });
  });
  it("action field is only allowed on action_request", () => {
    fail(home, ["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x", ...ACTION()]);
  });
  it("action_request with an unknown action kind is rejected", () => {
    fail(home, ["card", "new", "--kind", "action_request", "--project", "alpha", "--title", "m", "--action-kind", "format_disk",
      "--sha", sha40(), "--repo", "acme/alpha", "--pr", "1", "--base", "main"]);
  });
  it("repo allowlist cannot be bypassed by case or look-alike repo names", () => {
    for (const r of ["ACME/ALPHA", "acme/alpha ", "acme/alpha/x", "acme/alph"]) {
      fail(home, ["card", "new", "--kind", "action_request", "--project", "alpha", "--title", "m", ...ACTION(r)]);
    }
  });
  it("project without a recorded repo cannot get action_request", () => {
    writeProjectCard(home, "norepo", { repo: null });
    const r = run(home, ["card", "new", "--kind", "action_request", "--project", "norepo", "--title", "m", ...ACTION("acme/alpha"), "--json"]);
    expect(r.code).toBe(1);
  });
});
