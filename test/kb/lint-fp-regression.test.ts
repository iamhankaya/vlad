// Regression fixtures from the T20261103-14 TP/FP table (real kb lines, shortened): 35 flags, 21 false positives → the FP classes must stay quiet, the TPs must stay flagged.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDecision } from "../../src/kb/decisions.js";
import { lintKb } from "../../src/audit/lint.js";
import { makeHome } from "../helpers.js";

let home: string;
const kb = (...p: string[]) => join(home, "kb", ...p);
const NOW = new Date("2026-11-03T12:00:00+03:00");
const FRESH = "## Durum özeti\n_Güncel: 2026-11-03T11:00:00+03:00_\n\n";
const card = (sections: string) => `---\nslug: vlad\nname: vlad\npath: "/yok"\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n${sections}`;
const writeCard = (sections: string) => writeFileSync(kb("projects", "vlad.md"), card(sections));
const task = (id: string, state: string) =>
  writeFileSync(kb("tasks", `${id}.md`), `---\nid: ${id}\nproject: vlad\ntitle: t\nkind: dev\nstate: ${state}\nautonomy: commit\ncreated: "2026-10-01T10:00:00+03:00"\nupdated: "2026-11-01T10:00:00+03:00"\n---\n\n## Tanım\nx\n`);
const finding = (id: string, state: string) =>
  writeFileSync(kb("findings", `${id}.md`), `---\nid: ${id}\nproject: vlad\ntitle: f\nseverity: orta\nstate: ${state}\nsource_task: T20261001-01\ncreated: "2026-10-01T10:00:00+03:00"\nupdated: "2026-11-01T10:00:00+03:00"\n---\n\nbody\n`);
const flagged = (sections: string) => { writeCard(FRESH + sections); return lintKb({ now: NOW }).flags.map((f) => `${f.code}:${f.id}`); };

beforeEach(() => {
  home = makeHome();
  for (const d of ["findings", "decisions", "tasks", "projects"]) mkdirSync(kb(d), { recursive: true });
});

describe("finished_task_listed_active: false-positive classes stay quiet", () => {
  const finished = ["T20261027-07", "T20261027-06", "T20261030-15", "T20261028-17", "T20261022-82", "T20261022-83", "T20261030-14", "T20261030-35", "T20261030-26", "T20261024-94"];
  beforeEach(() => finished.forEach((id) => task(id, "done")));

  it("parenthesised (T…) source references in Açık konular (#2, #3, #9, #10, #13)", () => {
    expect(flagged("## Açık konular\n- Dağıtım kanalı ve pazarlama kararları kullanıcıda (T20261027-07): kapalı APK / itch.io.\n")).toEqual([]);
    expect(flagged("## Açık konular\n- Piyasa yol haritası (T20261027-06): denge v2.1'de; sırada 3. karakter, belki 2. harita.\n")).toEqual([]);
    expect(flagged("## Açık konular\n- APK imzalama: kalıcı keystore önerildi; kullanıcı kararı bekliyor. Keystore kullanıcıda. (T20261022-82, T20261022-83)\n")).toEqual([]);
    expect(flagged("## Açık konular\n- Yerel ortam: PostgreSQL/WSL/Docker yok; tam suite yalnız CI'da. (T20261030-14)\n")).toEqual([]);
    // even with a running word inside the parentheses the id is only a reference
    expect(flagged("## Açık konular\n- Kilitli worktree (+ kilitli T20261030-35 sürüyor sanılıyor).\n")).toEqual([]);
  });
  it("user-pending / unfinished-chore items without a running claim (#6, #7, #29)", () => {
    expect(flagged("## Açık konular\n- Yerel kurulum: T20261030-15 sonrası yeniden publish yapılmadı; bekliyor.\n")).toEqual([]);
    expect(flagged("## Açık konular\n- Operasyonel: T20261028-17 worktree'leri silinemedi, bekliyor.\n")).toEqual([]);
    expect(flagged("## Açık konular\n- Yanıtsız kullanıcı soruları kullanıcıda: T20261030-26 kararı bekliyor.\n")).toEqual([]);
  });
  it("a fact sentence in Açık konular that never says the task runs (#33)", () => {
    expect(flagged("## Açık konular\n- Kod yalnızca entegrasyon dalı vlad/T20261024-94'te; main'de ilk commit var.\n")).toEqual([]);
  });
  it("still flags the id named as running work, in or out of Açık konular (TP #31)", () => {
    expect(flagged("## Açık konular\n- Pi alınmıyor. T20261024-94 kayıtta running görünür ama bilinçli bekletiliyor; D0B açılmaz.\n")).toEqual(["finished_task_listed_active:T20261024-94"]);
    expect(flagged("## Açık konular\n- T20261027-07 sürüyor\n")).toEqual(["finished_task_listed_active:T20261027-07"]);
    expect(flagged("T20261027-06 hâlâ çalışıyor.\n")).toEqual(["finished_task_listed_active:T20261027-06"]);
  });
});

describe("closed_finding_listed_open: false-positive classes stay quiet", () => {
  it("dated decision bodies are history (#15, #16)", () => {
    finding("F-vlad-006", "fixed");
    finding("F-vlad-007", "fixed");
    addDecision({ project: "vlad", title: "Sunucu çalışanları auto izin", body: "- **Karar:** kullanıcı kararı (2026-10-25): auto izin. Yine de yasak listesi eklenir (F-vlad-006, F-vlad-007 açık kalır, S2a'da uygulanır)." }, new Date(2026, 9, 25));
    writeCard(FRESH + "x\n");
    expect(lintKb({ now: NOW }).flags.map((f) => f.code)).toEqual([]);
  });
  it("Durum özeti 'Son doğrulanmış sonuç' is a dated account (#23–#27)", () => {
    for (const id of ["F-vlad-160", "F-vlad-169", "F-vlad-170", "F-vlad-171", "F-vlad-167"]) finding(id, "fixed");
    expect(flagged("**Son doğrulanmış sonuç (2026-11-03 gece):** master `42684fd`. T20261103-01 Codex son kapı düzeltmeleri: config testi (F-vlad-160), `kb refs` (F-vlad-169), zaman damgası (F-vlad-170), `task gate` (F-vlad-171, F-vlad-167). Kaynak: günlük.\n")).toEqual([]);
  });
  it("a sentence that reports the fix, or only the remainder of a partly closed finding (#23, #18)", () => {
    finding("F-vlad-160", "fixed");
    finding("F-vlad-168", "fixed");
    expect(flagged("## Açık konular\n- Codex düzeltmeleri: config testi (F-vlad-160).\n")).toEqual([]);
    expect(flagged("## Açık konular\n- **Yüksek:** testler kb'ye yazıyor. F-vlad-168 kalanı: kurulum denetimi #7 (süresi dolmuş yetki hafızaları).\n")).toEqual([]);
    expect(flagged("## Açık konular\n- F-vlad-160 giderildi, kapandı.\n")).toEqual([]);
  });
  it("still flags fixed/wontfix findings listed as open (TP #5, #17, #19–#21, #32, #34)", () => {
    for (const [id, st] of [["F-diskpilot-007", "fixed"], ["F-vlad-172", "fixed"], ["F-vlad-173", "fixed"], ["F-vlad-174", "fixed"], ["F-vlad-161", "fixed"], ["F-vlad-mobile-003", "wontfix"], ["F-watchparty-004", "fixed"]] as const) finding(id, st);
    expect(flagged("## Açık konular\n- [kritik] F-diskpilot-007: doğrulama mutasyonu gerçek Geri Dönüşüm'ü boşalttı; kurtarma yalnız winfr ile.\n")).toEqual(["closed_finding_listed_open:F-diskpilot-007"]);
    expect(flagged("## Açık konular\n- **Yüksek:** F-vlad-172 testler `VLAD_KB_DIR` tanımlıyken gerçek kb'ye yazıyor. F-vlad-168 kalanı: kurulum denetimi #7.\n")).toEqual(["closed_finding_listed_open:F-vlad-172"]);
    expect(flagged("## Açık konular\n- Açık orta: F-vlad-173 (kb-context testi), F-vlad-174 (K04 golden), F-vlad-161 (ponytail off kolu).\n")).toEqual(["closed_finding_listed_open:F-vlad-173", "closed_finding_listed_open:F-vlad-174", "closed_finding_listed_open:F-vlad-161"]);
    expect(flagged("## Açık konular\n- **Açık bulgular:** yüksek F-vlad-mobile-003 (Bugün koyu tema zemini), -004 — S8b girdisi.\n")).toEqual(["closed_finding_listed_open:F-vlad-mobile-003"]);
    expect(flagged("## Açık konular\n- yüksek (deferred): F-watchparty-004 SignalR.Common GHSA; ayrı paket güncelleme görevi önerildi.\n")).toEqual(["closed_finding_listed_open:F-watchparty-004"]);
  });
});

describe("memory_stale_task: note that says the authority ended (#1)", () => {
  const mem = (text: string) => {
    mkdirSync(join(home, "mem"), { recursive: true });
    writeFileSync(join(home, "mem", "n.md"), text);
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ roots: ["/yok/root"], ignore: [], defaultAutonomy: "commit", staleAfterHours: 6, launcher: "auto", memoryDirs: [join(home, "mem")] }));
  };
  it("is skipped with 'sona erdi' and still flagged without it", () => {
    task("T20261027-15", "done");
    mem("Ashen gate'i CI'da koşuyordu (v2.1 branch push yetkisi T20261027-15 ile sona erdi).\n");
    writeCard(FRESH + "x\n");
    expect(lintKb({ now: NOW }).flags).toEqual([]);
    mem("v2.1 branch push yetkisi yalnız T20261027-15 çatısı için.\n");
    expect(lintKb({ now: NOW }).flags.map((f) => f.code)).toEqual(["memory_stale_task"]);
  });
});
