import { beforeEach, describe, expect, it } from "vitest";
import { getSection } from "../../src/kb/index.js";
import { writeProject } from "../../src/projects/store.js";
import {
  createTask, eventList, getTask, ingestEvents, reportReferencesPrior, reportTask, setState,
} from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

const SHA = "abcdef1234567890";
let id: string;
beforeEach(() => {
  makeHome();
  writeProject("alpha", `---
slug: alpha
name: alpha
path: "C:/dev/alpha"
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

describe("rapor ezilmesi", () => {
  it("ikinci rapor gelince ilki '### Önceki rapor #1' olarak saklanır, son rapor tek başına kalır", () => {
    reportTask(id, "### Yapılanlar\n- birinci");
    setState(id, "running"); // değişiklik turu
    reportTask(id, "### Yapılanlar\n- ikinci");
    const body = getTask(id).body;
    expect(getSection(body, "## Kapanış raporu")).toBe("### Yapılanlar\n- ikinci");
    expect(getSection(body, "## Önceki raporlar")).toContain("### Önceki rapor #1");
    expect(getSection(body, "## Önceki raporlar")).toContain("- birinci");
  });

  it("üçüncü rapor #2 olarak ikinciyi de saklar", () => {
    for (const t of ["bir", "iki", "üç"]) { reportTask(id, `- ${t}`); setState(id, "running"); }
    const prior = getSection(getTask(id).body, "## Önceki raporlar")!;
    expect(prior).toContain("### Önceki rapor #1");
    expect(prior).toContain("### Önceki rapor #2");
    expect(prior).toContain("- bir");
    expect(prior).toContain("- iki");
  });

  it("ilk raporda Önceki raporlar bölümü açılmaz", () => {
    reportTask(id, "- bir");
    expect(getSection(getTask(id).body, "## Önceki raporlar")).toBeNull();
  });

  it("atıf kalıbı uyarı üretir, tam metin üretmez", () => {
    expect(reportReferencesPrior("### Yapılanlar\nBu rapor önceki raporun yerine geçer")).toBe(true);
    expect(reportReferencesPrior("Önceki rapora üstüne ekler: düzeltme")).toBe(true);
    expect(reportReferencesPrior("Rapor #1 aynen geçerlidir")).toBe(true);
    expect(reportReferencesPrior("### Yapılanlar\n- tam metin")).toBe(false);
  });

  it("ingest atıf kalıplı raporda uyarı verir ve raporu yine de işler", () => {
    const text = `[VLAD:REPORT #1 branch=vlad/${id} head=${SHA}]\n### Yapılanlar\nÖnceki raporun üstüne ekler.\n[VLAD:END #1]`;
    const r = ingestEvents(id, [{ type: "assistant", message: { content: [{ type: "text", text }] } }], { head: SHA });
    expect(r.warnings.join("\n")).toMatch(/atıf|yerine geçer|üstüne ekler/);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });
});

const cc = (key: string, inner: object, created_at?: string) => ({ ...(created_at ? { created_at } : {}), [key]: { internal_anthropic_catchall: inner } });
const asst = (text: string, at?: string) => cc("assistant", { message: { content: [{ type: "text", text }] } }, at);
const res = (text: string, extra: object, at?: string) =>
  cc("result", { subtype: "success", result: text, ...extra }, at);

describe("ingest ölçümü", () => {
  it("log satırı olayın created_at'ini taşır (yoksa şimdiki zaman)", () => {
    const at = "2020-05-01T08:29:37Z";
    ingestEvents(id, [asst("[VLAD:LOG #1] eski olay", at), asst("[VLAD:LOG #2] zamansız")], {});
    const p = getSection(getTask(id).body, "## İlerleme")!;
    const l1 = p.split("\n").find((l) => l.includes("[cloud #1]"))!;
    const l2 = p.split("\n").find((l) => l.includes("[cloud #2]"))!;
    expect(l1.startsWith(`- ${new Date(at).getFullYear()}-05-01T`)).toBe(true);
    expect(l1).not.toBe(l2);
    expect(l2.startsWith(`- ${new Date().getFullYear()}-`)).toBe(true);
  });

  it("result olayındaki maliyet/tur/süre İlerleme'ye yazılır ve tekrar çalıştırmada çiftlenmez", () => {
    const ev = [res("[VLAD:LOG #1] x", { total_cost_usd: 0.4231, num_turns: 12, duration_ms: 34000 }, "2026-10-20T08:30:00Z")];
    ingestEvents(id, ev, {});
    ingestEvents(id, ev, {});
    const lines = getSection(getTask(id).body, "## İlerleme")!.split("\n").filter((l) => l.includes("ölçüm"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0.4231");
    expect(lines[0]).toContain("12");
    expect(lines[0]).toContain("34");
  });

  it("result olayında ölçüm alanı yoksa satır yazılmaz", () => {
    ingestEvents(id, [res("[VLAD:LOG #1] x", {})], {});
    expect(getSection(getTask(id).body, "## İlerleme") ?? "").not.toContain("ölçüm");
  });

  it("yalnızca result olaylı (result-first) sayfa işaretleri işler", () => {
    const r = ingestEvents(id, eventList({ ccr: { data: [res("[VLAD:LOG #1] adım", { num_turns: 3 })], has_more: false } }), {});
    expect(r.processed).toEqual([{ seq: 1, kind: "LOG" }]);
  });
});
