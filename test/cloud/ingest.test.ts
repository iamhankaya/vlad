import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commitKb } from "../../src/kb/commit.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, eventList, getTask, ingestEvents, parseMarkers, setState } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

const asst = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const user = (text: string) => ({ type: "user", message: { content: text } });
const SHA = "abcdef1234567890";

let id: string;
beforeEach(() => {
  makeHome();
  writeProject("alpha", `---
slug: alpha
name: alpha
path: "C:\\\\dev\\\\alpha"
stack: [ts]
status: active
autonomy: commit
repo: owner/alpha
last_activity: null
last_scanned: null
---

## Özet
x
`);
  id = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" }).data.id;
  setState(id, "running");
});

const report = (n: number, head = SHA) =>
  `[VLAD:REPORT #${n} branch=vlad/${id} head=${head}]\n### Yapılanlar\n- a\n### Test sonuçları\n- ok\n[VLAD:END #${n}]`;
const remote = (sha: string | null) => ({ remoteHead: () => sha });

describe("parseMarkers", () => {
  it("reads markers at line start, ignores ANSWER, fenced and inline ones", () => {
    const text = [
      "giriş [VLAD:LOG #9] satır başında değil",
      "[VLAD:LOG #1] ilk adım",
      "```", "[VLAD:LOG #2] çit içinde", "```",
      "[VLAD:ANSWER #3] cevap",
      "[VLAD:FAIL #4] patladı",
    ].join("\n");
    expect(parseMarkers(text)).toEqual([
      { kind: "LOG", seq: 1, text: "ilk adım" },
      { kind: "FAIL", seq: 4, text: "patladı" },
    ]);
  });

  it("collects a multi-line REPORT including fenced code with marker-like lines", () => {
    const text = `[VLAD:REPORT #5 branch=vlad/T1-01 head=abc1234]\n### Yapılanlar\n\`\`\`\n[VLAD:END #5]\n\`\`\`\nson\n[VLAD:END #5]\nsonrası`;
    const [m] = parseMarkers(text);
    expect(m).toMatchObject({ kind: "REPORT", seq: 5, branch: "vlad/T1-01", head: "abc1234" });
    expect(m.text).toContain("[VLAD:END #5]\n```\nson");
    expect(m.text).not.toContain("sonrası");
  });

  it("warns on an unterminated REPORT", () => {
    const w: string[] = [];
    expect(parseMarkers("[VLAD:REPORT #2 head=abc1234]\n### x", w)).toEqual([]);
    expect(w[0]).toMatch(/kapanmamış/);
  });
});

describe("REPORT/END number mismatches", () => {
  it("parseMarkers accepts a differing END number with a warning", () => {
    const w: string[] = [];
    const [m] = parseMarkers("[VLAD:REPORT #6 head=abc1234]\n### x\n[VLAD:END #7]\nsonrası", w);
    expect(m).toMatchObject({ kind: "REPORT", seq: 6, text: "### x" });
    expect(w[0]).toMatch(/REPORT #6 için END #6 bulunamadı \(END #7 var\)/);
  });

  it("ingest processes REPORT #6 / END #7 and warns", () => {
    const text = `[VLAD:REPORT #6 branch=vlad/${id} head=${SHA}]\n### Yapılanlar\n- a\n[VLAD:END #7]`;
    const r = ingestEvents(id, [asst(text)], remote(SHA));
    expect(r.warnings.join("\n")).toMatch(/END #7 var/);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("REPORT sharing a number with a processed LOG warns and is still processed; rerun is idempotent", () => {
    const evs = [asst(`[VLAD:LOG #1] x\n${report(1)}`)];
    const r = ingestEvents(id, evs, remote(SHA));
    expect(r.warnings.join("\n")).toMatch(/REPORT #1 daha önce işlenmiş #1 ile çakışıyor/);
    expect(getTask(id).data.state).toBe("awaiting_approval");
    const before = getTask(id).body;
    const r2 = ingestEvents(id, evs, remote(SHA));
    expect(r2.processed).toEqual([]);
    expect(r2.skipped).toEqual([1, 1]);
    expect(getTask(id).body).toBe(before);
  });
});

describe("eventList", () => {
  it("accepts an array or data/events/items wrappers", () => {
    expect(eventList([1])).toEqual([1]);
    expect(eventList({ data: [2] })).toEqual([2]);
    expect(eventList({ events: [3] })).toEqual([3]);
    expect(() => eventList({ foo: 1 })).toThrow();
  });
});

describe("ingestEvents", () => {
  it("logs and processes ASK → blocked, with [cloud #n] tags", () => {
    const r = ingestEvents(id, [asst("[VLAD:LOG #1] başladım"), asst("[VLAD:ASK #2] A mı B mi?")]);
    expect(r.processed).toEqual([{ seq: 1, kind: "LOG" }, { seq: 2, kind: "ASK" }]);
    const t = getTask(id);
    expect(t.data.state).toBe("blocked");
    expect(t.body).toContain("[cloud #1] başladım");
    expect(t.body).toContain("**Soru:** [cloud #2] A mı B mi?");
  });

  it("is idempotent: a second run adds nothing", () => {
    const evs = [asst("[VLAD:LOG #1] x\n[VLAD:ASK #2] q")];
    ingestEvents(id, evs);
    const before = getTask(id).body;
    const r = ingestEvents(id, evs);
    expect(r.processed).toEqual([]);
    expect(r.skipped).toEqual([1, 2]);
    expect(getTask(id).body).toBe(before);
  });

  it("ignores user events (prompt contains protocol examples)", () => {
    const r = ingestEvents(id, [user("[VLAD:LOG #1] örnek"), { type: "system", text: "[VLAD:FAIL #2] x" }]);
    expect(r.processed).toEqual([]);
    expect(getTask(id).data.state).toBe("running");
  });

  it("accepts plain string content and role/kind field variants", () => {
    ingestEvents(id, [{ role: "assistant", content: "[VLAD:LOG #1] düz" }, { kind: "assistant", message: { content: "[VLAD:LOG #2] iki" } }]);
    expect(getTask(id).body).toContain("[cloud #1] düz");
    expect(getTask(id).body).toContain("[cloud #2] iki");
  });

  it("FAIL logs the reason and fails the task", () => {
    ingestEvents(id, [asst("[VLAD:FAIL #3] derleme patladı")]);
    const t = getTask(id);
    expect(t.data).toMatchObject({ state: "failed", error: "derleme patladı" });
    expect(t.body).toContain("[cloud #3] FAIL: derleme patladı");
  });

  it("REPORT with a matching head writes the report and moves to awaiting_approval", () => {
    const r = ingestEvents(id, [asst(report(5))], remote(SHA));
    expect(r.warnings).toEqual([]);
    const t = getTask(id);
    expect(t.data.state).toBe("awaiting_approval");
    expect(t.body).toContain("### Yapılanlar\n- a");
    expect(t.body).toContain("[cloud #5] kapanış raporu işlendi");
  });

  it("accepts a short sha against the full remote sha", () => {
    ingestEvents(id, [asst(report(5, "abcdef1"))], remote(SHA));
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("REPORT with a mismatching head does not advance; warns; a later correct report is processed", () => {
    const r = ingestEvents(id, [asst(report(5, "1111111"))], remote(SHA));
    expect(r.processed).toEqual([]);
    expect(r.warnings[0]).toMatch(/eşleşmiyor/);
    expect(getTask(id).data.state).toBe("running");
    ingestEvents(id, [asst(report(6))], remote(SHA));
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("REPORT does not advance when the remote head cannot be read, unless --remote-head is given", () => {
    const r = ingestEvents(id, [asst(report(5))], remote(null));
    expect(r.warnings[0]).toMatch(/okunamadı/);
    expect(getTask(id).data.state).toBe("running");
    ingestEvents(id, [asst(report(5))], { head: SHA });
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("REPORT for another branch or without head is refused", () => {
    const wrong = report(5).replace(`vlad/${id}`, "vlad/T20260101-09");
    expect(ingestEvents(id, [asst(wrong)], remote(SHA)).warnings[0]).toMatch(/beklenen/);
    const nohead = `[VLAD:REPORT #6 branch=vlad/${id}]\nx\n[VLAD:END #6]`;
    expect(ingestEvents(id, [asst(nohead)], remote(SHA)).warnings[0]).toMatch(/head=/);
    expect(getTask(id).data.state).toBe("running");
  });

  it("an invalid transition becomes a warning, other markers still run", () => {
    ingestEvents(id, [asst("[VLAD:ASK #1] q1")]);
    const r = ingestEvents(id, [asst("[VLAD:ASK #2] q2\n[VLAD:LOG #3] devam")]);
    expect(r.warnings[0]).toMatch(/#2 ASK/);
    expect(r.processed).toEqual([{ seq: 3, kind: "LOG" }]);
  });
});

describe("commitKb push without upstream", () => {
  it("pushes a fresh session branch with -u origin <branch>", () => {
    const ident = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
    Object.assign(process.env, ident);
    const home = makeHome();
    const bare = mkdtempSync(join(tmpdir(), "vlad-bare-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    g(bare, "init", "--bare", "-b", "main");
    g(home, "init", "-b", "main");
    writeFileSync(join(home, ".gitignore"), "schemas/\n");
    g(home, "add", ".gitignore");
    g(home, "commit", "-m", "init");
    g(home, "remote", "add", "origin", bare);
    g(home, "push", "-q", "origin", "main");
    g(home, "checkout", "-q", "-b", "ccr-session");
    mkdirSync(join(home, "kb", "tasks"), { recursive: true });
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("bulut", { push: true });
    expect(r.pushed).toBe(true);
    expect(g(bare, "rev-parse", "ccr-session")).toBe(g(home, "rev-parse", "HEAD"));
    expect(g(home, "rev-parse", "--abbrev-ref", "@{u}")).toBe("origin/ccr-session");
  });

  it("still refuses to push non-kb commits when there is no upstream", () => {
    const ident = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
    Object.assign(process.env, ident);
    const home = makeHome();
    const g = (...a: string[]) => execFileSync("git", a, { cwd: home, encoding: "utf8", stdio: "pipe" }).trim();
    g("init", "-b", "main");
    writeFileSync(join(home, "code.ts"), "1");
    writeFileSync(join(home, ".gitignore"), "schemas/\n");
    g("add", ".");
    g("commit", "-m", "init");
    writeFileSync(join(home, "kb", "tasks", "T1.md"), "x");
    const r = commitKb("x", { push: true });
    expect(r.pushed).toBe(false);
    expect(r.warning).toMatch(/code\.ts/);
  });
});

describe("ingestEvents: assistant olayı tanıma", () => {
  const real = (text: string) => ({ assistant: { internal_anthropic_catchall: { message: { content: [{ type: "text", text }] } } } });
  const result = (text: string) => ({ result: { internal_anthropic_catchall: { result: text } } });

  it("hiç assistant olayı yoksa uyarı verir", () => {
    const r = ingestEvents(id, [user("[VLAD:LOG #1] x"), { foo: 1 }]);
    expect(r.processed).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/assistant olayı bulunamadı/);
  });

  it("anahtar adıyla gelen gerçek şekil okunur; result olayı çift işlemez", () => {
    const r = ingestEvents(id, [real("[VLAD:LOG #1] a"), result("[VLAD:LOG #1] a")]);
    expect(r.processed).toEqual([{ seq: 1, kind: "LOG" }]);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("assistant yoksa result yedek olur (uyarıyla)", () => {
    const r = ingestEvents(id, [result("[VLAD:LOG #1] a")]);
    expect(r.processed).toEqual([{ seq: 1, kind: "LOG" }]);
    expect(r.warnings.join("\n")).toMatch(/assistant olayı bulunamadı/);
  });

  it("eventList ccr sarmalayıcısını açar", () => {
    expect(eventList({ ccr: { data: [1, 2] } })).toEqual([1, 2]);
  });
});

describe("ingestEvents: idempotans yalnızca İlerleme/Sorular'da aranır", () => {
  it("kapanış raporu gövdesindeki '[cloud #2]' LOG #2'yi atlatmaz", () => {
    const t = getTask(id);
    writeFileSync(t.file, readFileSync(t.file, "utf8").replace("## Kapanış raporu", "## Kapanış raporu\nönceki not: [cloud #2] metni"), "utf8");
    const r = ingestEvents(id, [asst("[VLAD:LOG #2] gerçek adım")]);
    expect(r.processed).toEqual([{ seq: 2, kind: "LOG" }]);
    expect(r.skipped).toEqual([]);
    expect(getTask(id).body).toContain("[cloud #2] gerçek adım");
  });
});
