import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { addCard, answerCard, getCard, listCardsWithWarnings, nextCardId, resolveCard } from "../../src/cards/store.js";
import { makeHome } from "../helpers.js";

const SHA = "a".repeat(40);
const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;

const projectCard = (slug: string, repo?: string) =>
  writeFileSync(join(kbPaths().projects, `${slug}.md`), `---\nslug: ${slug}\n${repo ? `repo: ${repo}\n` : ""}---\n`);

beforeEach(() => {
  home = makeHome();
  projectCard("alpha", "o/alpha");
});

const mk = (o: Partial<Parameters<typeof addCard>[0]> = {}, now?: Date) =>
  addCard({ kind: "vlad_question", project: "alpha", title: "Soru?", options: o.kind === "action_request" ? undefined : [{ id: "a", label: "Evet" }, { id: "b", label: "Hayır" }], ...o }, now);

const run = (args: string[]) => new Promise<{ code: number; out: string; err: string }>((res) => {
  const p = spawn("node", [cli, ...args], { env: { ...process.env, VLAD_HOME: home } });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("exit", (code) => res({ code: code ?? -1, out, err }));
});

describe("records: card", () => {
  it("records: card new/list/answer", () => {
    const c = mk({ task: "T20261024-105" }, new Date(2026, 9, 24, 10, 0, 0));
    expect(c.data).toMatchObject({ id: "C-20261024-01", state: "open", answer: null, task: "T20261024-105", project: "alpha" });
    expect(existsSync(join(kbPaths().cards, "C-20261024-01.md"))).toBe(true);
    expect(mk({}, new Date(2026, 9, 24, 11, 0, 0)).data.id).toBe("C-20261024-02");
    const a = answerCard("C-20261024-01", { option: "a", by_device: "dev-1" });
    expect(a.data.answer).toMatchObject({ option: "a", by_device: "dev-1" });
    expect(a.data.state).toBe("open");
    expect(getCard("C-20261024-01").data.answer?.option).toBe("a");
    expect(listCardsWithWarnings().cards.map((x) => x.data.id)).toEqual(["C-20261024-01", "C-20261024-02"]);
    expect(listCardsWithWarnings({ kind: ["ci_red"] }).cards).toEqual([]);
    expect(resolveCard("C-20261024-02").data.state).toBe("resolved");
    expect(listCardsWithWarnings({ state: ["open"] }).cards.map((x) => x.data.id)).toEqual(["C-20261024-01"]);
    expect(() => resolveCard("C-20261024-02")).toThrow(/kapalı/);
  });

  it("records: card answer twice -> zaten cevaplandı", () => {
    const c = mk();
    answerCard(c.data.id, { text: "tamam", by_device: "d1" });
    expect(() => answerCard(c.data.id, { option: "a", by_device: "d2" })).toThrow("zaten cevaplandı");
    expect(getCard(c.data.id).data.answer).toMatchObject({ text: "tamam", by_device: "d1" });
  });

  it("answer needs option or text, an existing option, and an open card", () => {
    const c = mk();
    expect(() => answerCard(c.data.id, { by_device: "d" })).toThrow(/--option ya da --text/);
    expect(() => answerCard(c.data.id, { option: "zzz", by_device: "d" })).toThrow(/geçersiz seçenek/);
    expect(() => answerCard(c.data.id, { text: "x", by_device: "bad id;" })).toThrow();
    resolveCard(c.data.id, "dismissed");
    expect(() => answerCard(c.data.id, { text: "x", by_device: "d" })).toThrow(/açık değil/);
  });

  it("records: card invalid kind rejected", () => {
    expect(() => mk({ kind: "merge_now" })).toThrow(/geçersiz tür/);
    expect(() => mk({ project: "yok" })).toThrow(/proje kartı bulunamadı/);
    expect(() => mk({ project: "A b" })).toThrow(/slug/);
    expect(() => mk({ title: "  " })).toThrow();
    expect(() => mk({ task: "görev" })).toThrow();
    expect(() => mk({ options: [{ id: "a", label: "x" }, { id: "a", label: "y" }] })).toThrow(/yinelenen/);
    expect(existsSync(kbPaths().cards) ? readdirSync(kbPaths().cards) : []).toEqual([]);
  });

  it("records: card id rolls past 99/day and at midnight", () => {
    const day = new Date(2026, 9, 24, 23, 59, 58);
    for (let i = 1; i <= 99; i++) expect(mk({}, day).data.id).toBe(`C-20261024-${String(i).padStart(2, "0")}`);
    expect(mk({}, day).data.id).toBe("C-20261024-100");
    expect(mk({}, day).data.id).toBe("C-20261024-101");
    expect(nextCardId(kbPaths().cards, day)).toBe("C-20261024-102");
    // list orders numerically, not lexically (100 after 99)
    const ids = listCardsWithWarnings().cards.map((c) => c.data.id);
    expect(ids.indexOf("C-20261024-100")).toBe(ids.indexOf("C-20261024-99") + 1);
    // one second later it is the next day and numbering restarts
    expect(mk({}, new Date(2026, 9, 25, 0, 0, 0)).data.id).toBe("C-20261025-01");
    expect(mk({}, new Date(2026, 9, 25, 0, 0, 1)).data.id).toBe("C-20261025-02");
  });

  it("records: concurrent card new unique ids", async () => {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      run(["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", `k${i}`, "--json"])));
    expect(rs.map((r) => r.code)).toEqual(Array(12).fill(0));
    const ids = rs.map((r) => JSON.parse(r.out).id as string);
    expect(new Set(ids).size).toBe(12);
    expect(readdirSync(kbPaths().cards)).toHaveLength(12);
    expect(listCardsWithWarnings().warnings).toEqual([]);
  }, 60_000);

  it("records: concurrent card answer one wins", async () => {
    const id = mk().data.id;
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      run(["card", "answer", id, "--option", i % 2 ? "a" : "b", "--by-device", `dev-${i}`, "--json"])));
    const ok = rs.filter((r) => r.code === 0);
    const bad = rs.filter((r) => r.code !== 0);
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(19);
    for (const r of bad) expect(JSON.parse(r.err).error).toBe("zaten cevaplandı");
    const winner = JSON.parse(ok[0].out).answer;
    expect(getCard(id).data.answer).toEqual(winner);
  }, 60_000);

  it("records: action_request repo outside project allowlist rejected", () => {
    const action = { kind: "merge_phase", repo: "o/alpha", sha: SHA, pr: 7, base: "main" };
    const c = mk({ kind: "action_request", action });
    expect(c.data.action).toEqual(action);
    expect(c.data.options).toEqual([{ id: "approve", label: "Onayla" }, { id: "reject", label: "Reddet" }]);
    for (const repo of ["o/other", "evil/alpha", "o/alpha2", "O/alpha"]) {
      expect(() => mk({ kind: "action_request", action: { ...action, repo } })).toThrow("repo izin listesinde değil");
    }
    // project without a registered repo: nothing is allowed
    projectCard("norepo");
    expect(() => mk({ project: "norepo", kind: "action_request", action })).toThrow("repo izin listesinde değil");
    // action only on action_request, and action_request requires one
    expect(() => mk({ kind: "ci_red", action })).toThrow(/yalnızca action_request/);
    expect(() => mk({ kind: "action_request" })).toThrow();
    // malformed repo / pr never reach the file
    expect(() => mk({ kind: "action_request", action: { kind: "merge_phase", repo: "o/alpha;rm", sha: SHA, pr: 1 } })).toThrow();
    expect(() => mk({ kind: "action_request", action: { ...action, pr: 0 } })).toThrow();
    expect(readdirSync(kbPaths().cards)).toHaveLength(1);
  });

  it("records: card list warns on a corrupt file without crashing", () => {
    mk();
    writeFileSync(join(kbPaths().cards, "C-20261024-77.md"), "bozuk");
    const { cards, warnings } = listCardsWithWarnings();
    expect(cards).toHaveLength(1);
    expect(warnings[0]).toMatch(/C-20261024-77\.md/);
  });

  it("records: card CLI --json error shape {error, details} and exit 1", () => {
    const r = spawnSync("node", [cli, "card", "new", "--kind", "nope", "--project", "alpha", "--title", "x", "--json"], { env: { ...process.env, VLAD_HOME: home }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ error: expect.stringContaining("geçersiz tür"), details: [] });
    const v = spawnSync("node", [cli, "card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x", "--task", "bad", "--json"], { env: { ...process.env, VLAD_HOME: home }, encoding: "utf8" });
    expect(v.status).toBe(1);
    const e = JSON.parse(v.stderr);
    expect(e.error).toMatch(/doğrulama hatası/);
    expect(e.details.length).toBeGreaterThan(0);
    const s = spawnSync("node", [cli, "card", "show", "C-20260101-01", "--json"], { env: { ...process.env, VLAD_HOME: home }, encoding: "utf8" });
    expect(s.status).toBe(1);
    expect(JSON.parse(s.stderr).error).toMatch(/kart bulunamadı/);
  });

  it("records: card CLI new with repeated --option and action, then list/show/resolve", async () => {
    const n = await run(["card", "new", "--kind", "action_request", "--project", "alpha", "--title", "Merge?",
      "--action-kind", "merge_phase", "--repo", "o/alpha", "--sha", SHA, "--pr", "5", "--base", "main", "--json"]);
    expect(n.code).toBe(0);
    const id = JSON.parse(n.out).id;
    const shown = JSON.parse((await run(["card", "show", id, "--json"])).out);
    expect(shown.options).toEqual([{ id: "approve", label: "Onayla" }, { id: "reject", label: "Reddet" }]);
    expect(shown.action).toEqual({ kind: "merge_phase", repo: "o/alpha", sha: SHA, pr: 5, base: "main" });
    const rep = await run(["card", "new", "--kind", "vlad_question", "--project", "alpha", "--title", "S?", "--option", "yes=Evet", "--option", "no=Hayır", "--json"]);
    expect(JSON.parse((await run(["card", "show", JSON.parse(rep.out).id, "--json"])).out).options).toEqual([{ id: "yes", label: "Evet" }, { id: "no", label: "Hayır" }]);
    const bad = await run(["card", "new", "--kind", "action_request", "--project", "alpha", "--title", "x", "--action-kind", "merge_phase", "--repo", "o/zzz", "--sha", SHA, "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err).error).toBe("repo izin listesinde değil");
    const ar = await run(["card", "answer", id, "--option", "approve", "--by-device", "d1", "--json"]);
    expect(ar.code).toBe(1);
    expect(JSON.parse(ar.err).error).toBe("action_request kartı yalnız onay yolundan cevaplanır");
    expect((await run(["card", "resolve", id])).code).toBe(0);
    const list = JSON.parse((await run(["card", "list", "--state", "resolved", "--json"])).out);
    expect(list.cards.map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await run(["card", "list", "--state", "bogus"])).code).toBe(1);
  }, 60_000);

  it("records: action_request cannot be answered (store and CLI), even with a valid option", () => {
    const c = mk({ kind: "action_request", action: { kind: "merge_final", repo: "o/alpha", sha: SHA, pr: 1 } });
    expect(() => answerCard(c.data.id, { option: "approve", by_device: "evil" })).toThrow("action_request kartı yalnız onay yolundan cevaplanır");
    expect(() => answerCard(c.data.id, { text: "evet", by_device: "evil" })).toThrow(/onay yolundan/);
    expect(getCard(c.data.id).data.answer).toBeNull();
  });

  it("records: action_request options are fixed, agent-supplied options rejected", () => {
    const action = { kind: "tag", repo: "o/alpha", sha: SHA, ref: "v1.0.0" };
    expect(() => mk({ kind: "action_request", action, options: [{ id: "approve", label: "Onayla" }] })).toThrow(/seçenek verilemez/);
    expect(() => mk({ kind: "action_request" })).toThrow(/action gerekli/);
  });

  it("records: action schema: kind enum, sha required 40 hex, base/ref pattern", () => {
    const base = { kind: "push", repo: "o/alpha", sha: SHA };
    const ok = (a: object) => mk({ kind: "action_request", action: { ...base, ...a } });
    for (const k of ["merge_phase", "merge_final", "push", "tag"]) expect(ok({ kind: k }).data.action?.kind).toBe(k);
    expect(() => ok({ kind: "merge" })).toThrow();
    expect(() => ok({ kind: "delete_branch" })).toThrow();
    expect(() => ok({ sha: undefined })).toThrow();
    for (const sha of ["abc", "A".repeat(40), "a".repeat(39), "a".repeat(41), "g".repeat(40)]) expect(() => ok({ sha })).toThrow();
    for (const bad of ["-delete", "--force", "a..b", "..", "a/../b", "x y", "a;b", "a\nb", "", "a".repeat(201)]) {
      expect(() => ok({ base: bad }), `base ${bad}`).toThrow();
      expect(() => ok({ ref: bad }), `ref ${bad}`).toThrow();
    }
    expect(ok({ base: "vlad/T20261024-94", ref: "refs/tags/v1.0.0" }).data.action?.base).toBe("vlad/T20261024-94");
    expect(ok({ base: "a".repeat(200) }).data.action?.base).toHaveLength(200);
  });

  it("records: text limits and control/bidi characters rejected", () => {
    expect(mk({ title: "a".repeat(200) }).data.title).toHaveLength(200);
    expect(() => mk({ title: "a".repeat(201) })).toThrow();
    for (const ch of ["\n", "\u0007", "\u007f", "\u202e", "\u202a", "\u2066", "\u2069", "\u0085"]) {
      expect(() => mk({ title: `x${ch}y` }), JSON.stringify(ch)).toThrow();
      expect(() => mk({ options: [{ id: "a", label: `x${ch}y` }] }), JSON.stringify(ch)).toThrow();
    }
    expect(mk({ options: [{ id: "a", label: "a".repeat(80) }] }).data.options).toHaveLength(1);
    expect(() => mk({ options: [{ id: "a", label: "a".repeat(81) }] })).toThrow();
    const c = mk();
    expect(() => answerCard(c.data.id, { text: "a".repeat(2001), by_device: "d" })).toThrow();
    expect(() => answerCard(c.data.id, { text: "x\u202ey", by_device: "d" })).toThrow();
    expect(() => answerCard(c.data.id, { text: "x\u0007y", by_device: "d" })).toThrow();
    expect(getCard(c.data.id).data.answer).toBeNull();
    expect(answerCard(c.data.id, { text: "a".repeat(1000) + "\nsatır", by_device: "d" }).data.answer?.text).toContain("\nsatır");
  });

  it("records: options max 8 and unique ids", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `L${i}` }));
    expect(mk({ options: opts(8) }).data.options).toHaveLength(8);
    expect(() => mk({ options: opts(9) })).toThrow();
    expect(() => mk({ options: [{ id: "a", label: "x" }, { id: "a", label: "y" }] })).toThrow(/yinelenen/);
  });

  it("records: per-card lock: a held lock makes answer/resolve fail, a stale one is taken over", () => {
    const c = mk();
    const lock = join(kbPaths().cards, `${c.data.id}.lock`);
    writeFileSync(lock, "");
    expect(() => answerCard(c.data.id, { option: "a", by_device: "d" })).toThrow("kart meşgul");
    expect(() => resolveCard(c.data.id)).toThrow("kart meşgul");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(answerCard(c.data.id, { option: "a", by_device: "d" }).data.answer?.option).toBe("a");
    expect(existsSync(lock)).toBe(false);
    expect(listCardsWithWarnings().warnings).toEqual([]);
  });

  it("records: --pr/--base/--ref/--sha without --action-kind/--repo is an error", async () => {
    for (const extra of [["--pr", "3"], ["--base", "main"], ["--ref", "v1"], ["--sha", SHA]]) {
      const r = await run(["card", "new", "--kind", "ci_red", "--project", "alpha", "--title", "x", ...extra, "--json"]);
      expect(r.code, extra[0]).toBe(1);
      expect(JSON.parse(r.err).error).toMatch(/yalnız --action-kind ve --repo ile/);
    }
    const half = await run(["card", "new", "--kind", "action_request", "--project", "alpha", "--title", "x", "--repo", "o/alpha", "--sha", SHA, "--json"]);
    expect(half.code).toBe(1);
    expect(JSON.parse(half.err).error).toMatch(/birlikte/);
    expect(existsSync(kbPaths().cards) ? readdirSync(kbPaths().cards) : []).toEqual([]);
  }, 60_000);
});
