// Bulut temizliği dilimi C (T20261102-09): F-vlad-098/100/070/103/101/110/111/097/081/036/052/112 kırmızı-yeşil testleri.
// Her şey makeHome() geçici dizininde koşar; gerçek kb/ ve ~/.claude'a dokunulmaz.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getJournal } from "../../src/kb/journal.js";
import { addDecision, listDecisions, setDecisionStatus } from "../../src/kb/decisions.js";
import { readDoc, validate } from "../../src/kb/index.js";
import { commitKb } from "../../src/kb/commit.js";
import { resolveLaunchMode } from "../../src/launcher/index.js";
import { createTask, getTask, listTasks, setState } from "../../src/tasks/index.js";
import { markSilentWorkers, parseProcessList, soleTranscriptSession, type LivenessProbe } from "../../src/tasks/liveness.js";
import { parsedTaskCacheSize } from "../../src/tasks/store.js";
import { probeIntegrationBranch, prepareCloudLaunch } from "../../src/tasks/cloud.js";
import { trustWorktree } from "../../src/tasks/trust.js";
import { makeHome } from "../helpers.js";
import { isolatedEnv } from "../isolate-env.js";

let home: string;
beforeEach(() => { home = makeHome(); });

describe("F-vlad-098 journal get kod çiti", () => {
  it("çit içindeki '## ' satırı başlık sayılmaz", () => {
    mkdirSync(join(home, "kb", "journal"), { recursive: true });
    writeFileSync(join(home, "kb", "journal", "2026-11-02.md"), "# 2026-11-02\n\n## vlad\n- a\n\n```md\n## sahte\n```\n- b\n\n## diger\n- c\n");
    const j = getJournal("2026-11-02");
    expect(j.sections.map((s) => s.project)).toEqual(["vlad", "diger"]);
    expect(j.sections[0].content).toContain("## sahte");
    expect(j.sections[0].content).toContain("- b");
  });
});

describe("F-vlad-100 karar meta satırı yalnız başlık altındaki ilk blokta", () => {
  it("gövdedeki '- **Durum:** geçersiz' satırı durumu değiştirmez", () => {
    const id = addDecision({ project: "alpha", title: "x", body: "- **Karar:** a\n- **Durum:** geçersiz (metin içinde)\n- **Geçersiz kılan:** D-alpha-099" }, new Date(2026, 10, 2));
    const d = listDecisions({ project: "alpha", all: true }).find((r) => r.id === id)!;
    expect(d.status).toBe("geçerli");
    expect(d.superseded_by).toBeUndefined();
  });
  it("durum değiştirme gövdedeki benzer satıra değil gerçek meta satırına yazar", () => {
    const id = addDecision({ project: "alpha", title: "x", body: "- **Karar:** a\n- **Durum:** gövde" }, new Date(2026, 10, 2));
    setDecisionStatus(id, "geçersiz");
    const text = readFileSync(join(home, "kb", "decisions", "alpha.md"), "utf8");
    expect(text).toContain("- **Durum:** geçersiz\n");
    expect(text).toContain("- **Durum:** gövde");
    expect(listDecisions({ project: "alpha", all: true })[0].status).toBe("geçersiz");
  });
});

describe("F-vlad-070 opus gerekçesi şemada zorunlu", () => {
  const base = () => createTask({ project: "alpha", title: "t", kind: "dev", body: "" }).data;
  it("model opus + model_reason yok → şema reddeder; gerekçeyle geçer", () => {
    expect(() => validate("task", { ...base(), model: "opus", model_reason: null })).toThrow();
    expect(() => validate("task", { ...base(), model: "opus" })).toThrow();
    expect(() => validate("task", { ...base(), model: "opus", model_reason: "kritik" })).not.toThrow();
    expect(() => validate("task", { ...base(), model: "sonnet" })).not.toThrow();
  });
});

describe("F-vlad-103 kb commit kilit altında", () => {
  it("canlı sahip kilidi tutarken commit kilidi bekler ve zaman aşımında hata verir", () => {
    const repo = home;
    const run = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe", env: { ...isolatedEnv(), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" } });
    run("init", "-b", "main");
    writeFileSync(join(repo, "kb", "tasks", "T1.md"), "x");
    writeFileSync(join(home, "kb", ".vlad.lock"), JSON.stringify({ pid: process.pid, started: Date.now(), token: "other" }));
    process.env.VLAD_LOCK_TIMEOUT_MS = "150";
    try {
      expect(() => commitKb("x")).toThrow(/kb kilidi alınamadı/);
    } finally { delete process.env.VLAD_LOCK_TIMEOUT_MS; }
  });
});

describe("F-vlad-101 görev ayrıştırma önbelleği", () => {
  it("silinen/değişen dosyaların girdisi listelemede önbellekten atılır", () => {
    const a = createTask({ project: "alpha", title: "a", kind: "dev", body: "" });
    createTask({ project: "alpha", title: "b", kind: "dev", body: "" });
    listTasks();
    expect(parsedTaskCacheSize()).toBe(2);
    unlinkSync(a.file);
    listTasks();
    expect(parsedTaskCacheSize()).toBe(1);
  });
});

describe("F-vlad-110 bulut hazırlığında ağ çağrısı kilit dışı", () => {
  it("probeIntegrationBranch uzak dalı bir kez sorar; prepareCloudLaunch aynı cevabı kullanır", () => {
    const pipe = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "" });
    const ph = createTask({ project: "alpha", title: "f", kind: "dev", body: "", parent: pipe.data.id });
    writeFileSync(join(home, "kb", "projects", "alpha.md"), `---\nslug: alpha\nname: Alpha\npath: "C:\\\\x"\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\nrepo: o/r\n---\n\n## Özet\nx\n`);
    const calls: string[] = [];
    const probe = probeIntegrationBranch(ph.data.id, (repo, br) => { calls.push(`${repo}@${br}`); return "exists"; });
    expect(calls).toEqual([`o/r@vlad/${pipe.data.id}`]);
    const r = prepareCloudLaunch(ph.data.id, { remoteBranch: probe, vladSession: undefined });
    expect(calls).toHaveLength(1);
    expect(r.integration?.needs_remote_create).toBe(false);
  });
});

describe("F-vlad-111 POSIX'te takılma tespiti", () => {
  const probe = (alive: boolean | null): LivenessProbe => ({ alive: () => alive, transcriptMtime: () => null });
  it("linux/darwin'de de ölü işçi stalled olur", () => {
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "" });
    setState(t.data.id, "running", { worktree: "/tmp/wt/T1" });
    const later = new Date(Date.now() + 60 * 60_000);
    const cfg = { workerSilentMinutes: 15 } as never;
    expect(markSilentWorkers(later, cfg, probe(false), "linux").map((x) => x.data.id)).toEqual([t.data.id]);
    expect(getTask(t.data.id).data.state).toBe("stalled");
  });
  it("parseProcessList: ps çıktısı küçük harfli komut satırlarına ayrılır, boş satırlar atılır", () => {
    expect(parseProcessList("claude --x T20261102-09\n\n  node Foo \n")).toEqual(["claude --x t20261102-09", "node foo"]);
  });
});

describe("F-vlad-097 resume --external yanlış oturum", () => {
  it("tek transkript varsa onun oturumu, birden çoksa/hiç yoksa null döner", () => {
    const cfg = mkdtempSync(join(tmpdir(), "vlad-cfg-"));
    const dir = join(cfg, "projects", "C--x-wt-T1");
    mkdirSync(dir, { recursive: true });
    expect(soleTranscriptSession("C:\\x\\wt\\T1", cfg)).toBeNull();
    writeFileSync(join(dir, "aaaa-1111.jsonl"), "{}");
    expect(soleTranscriptSession("C:\\x\\wt\\T1", cfg)).toBe("aaaa-1111");
    writeFileSync(join(dir, "bbbb-2222.jsonl"), "{}");
    expect(soleTranscriptSession("C:\\x\\wt\\T1", cfg)).toBeNull();
  });
});

describe("F-vlad-081 resume güven kaydını yeniler", () => {
  it("trustWorktree zaten güvenli kaydı bozmadan tekrar çağrılabilir (idempotent)", () => {
    const f = join(home, "claude.json");
    writeFileSync(f, JSON.stringify({ projects: { "C:/x/wt": { hasTrustDialogAccepted: false, keep: 1 } } }));
    expect(trustWorktree("C:\\x\\wt", f)).toBeNull();
    expect(trustWorktree("C:\\x\\wt", f)).toBeNull();
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j.projects["C:/x/wt"]).toEqual({ hasTrustDialogAccepted: true, keep: 1 });
  });
});

describe("F-vlad-036 kb okuma symlink izlemez", () => {
  it("readDoc symlink dosyayı reddeder, gerçek dosyayı okur", () => {
    const outside = mkdtempSync(join(tmpdir(), "vlad-out-"));
    const target = join(outside, "x.md");
    writeFileSync(target, "---\na: 1\n---\n\nb\n");
    const link = join(home, "kb", "tasks", "link.md");
    try { symlinkSync(target, link, "file"); } catch { return; } // Windows'ta ayrıcalık yoksa atla
    expect(() => readDoc(link)).toThrow(/symlink/);
    expect(readDoc(target).data).toEqual({ a: 1 });
  });
});

describe("F-vlad-112 Linux launcher=auto", () => {
  it("bulut dışı Linux'ta auto tmux seçer (noop korumasıyla)", () => {
    expect(resolveLaunchMode("auto", "linux", {})).toBe("tmux");
    expect(resolveLaunchMode("auto", "linux", { VLAD_LAUNCHER: "noop" })).toBe("noop");
    expect(resolveLaunchMode("auto", "linux", { CLAUDE_CODE_REMOTE: "true" })).toBe("cloud");
  });
});

describe("F-vlad-052 status özeti yazılamayan kb'de düşmez", () => {
  it("salt okunur görev dosyası işaretlemeyi atlatır, statusSummary hata atmaz", async () => {
    const { statusSummary } = await import("../../src/tasks/launch.js");
    const { defaultConfig, nowIso, writeDoc } = await import("../../src/kb/index.js");
    const { chmodSync } = await import("node:fs");
    const t = createTask({ project: "alpha", title: "old", kind: "dev", body: "" });
    setState(t.data.id, "running");
    const cur = getTask(t.data.id);
    writeDoc(cur.file, { ...cur.data, updated: nowIso(new Date(Date.now() - 5 * 24 * 3600_000)) }, cur.body);
    chmodSync(cur.file, 0o444); // Windows: read-only attribute → the atomic rename over it fails
    try {
      expect(() => statusSummary(defaultConfig(), new Date())).not.toThrow();
    } finally { chmodSync(cur.file, 0o644); }
  });
});

describe("F-vlad-099 status --no-mark mod penceresini temizlemez", () => {
  it("mark:false süresi dolmuş gece penceresini dosyada bırakır; mark:true temizler", async () => {
    const { statusSummary } = await import("../../src/tasks/launch.js");
    const { defaultConfig } = await import("../../src/kb/index.js");
    const modeFile = join(home, "kb", "mode.json");
    writeFileSync(modeFile, JSON.stringify({ night: { until: "2020-01-01T00:00:00+03:00", started: "2020-01-01T00:00:00+03:00", projects: [], note: null }, watch: false }));
    const before = readFileSync(modeFile, "utf8");
    statusSummary(defaultConfig(), new Date(), undefined, undefined, { mark: false });
    expect(readFileSync(modeFile, "utf8")).toBe(before);
    statusSummary(defaultConfig(), new Date());
    expect(() => readFileSync(modeFile, "utf8")).toThrow(); // cleared (file removed)
  });
});

describe("F-vlad-090 --since yalnız-tarih yerel gün başı", () => {
  it("parseSince: YYYY-MM-DD yerel gece yarısı; tam zaman damgası olduğu gibi; çöp NaN", async () => {
    const { parseSince } = await import("../../src/audit/skills.js");
    expect(parseSince("2026-11-02")).toBe(new Date(2026, 10, 2).getTime());
    expect(parseSince("2026-11-02T10:00:00+03:00")).toBe(Date.parse("2026-11-02T10:00:00+03:00"));
    expect(Number.isNaN(parseSince("dün"))).toBe(true);
  });
});
