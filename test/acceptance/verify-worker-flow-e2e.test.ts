// Doğrulama fazı (T20261026-16): A (rapor koruma + ingest ölçümü), C (canlılık, launcher koruması) birleşik uçtan uca.
// Yalnızca CLI/dışa açık arayüz üzerinden; geçici kb. Gerçek launcher açılmaz.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, getSection, nowIso, writeDoc } from "../../src/kb/index.js";
import { realLauncherBlocked } from "../../src/launcher/index.js";
import { getTask, setState } from "../../src/tasks/index.js";
import { markSilentWorkers, type LivenessProbe } from "../../src/tasks/liveness.js";
import { makeHome } from "../helpers.js";
import { forceRunning, newTask, readTask, taskState, vlad, writeCard } from "./cloud-helpers.js";

let home: string;
let id: string;
beforeEach(() => {
  home = makeHome();
  writeCard(home, "alpha", { repo: "iamhankaya/vlad" });
  id = newTask(home);
  forceRunning(home, id);
});

const reportFile = (name: string, body: string) => {
  const f = join(home, name);
  writeFileSync(f, body);
  return f;
};
const report = (body: string, name = "r.md") => vlad(home, ["task", "report", id, "--file", reportFile(name, body), "--json"]);
const section = (name: string) => getSection(readTask(home, id), name);

describe("iki rapor turu: ilk rapor korunur, atıf uyarılır", () => {
  it("ikinci rapor 'yerine geçer' diyorsa ilki '## Önceki raporlar'da kalır, uyarı JSON'da ve rapor yine işlenir", () => {
    const r1 = report("### Yapılanlar\n- BIRINCI-RAPOR-ICERIGI\n### Açık noktalar\n- [orta] eski nokta — x\n");
    expect(r1.code, r1.err).toBe(0);
    expect(taskState(home, id)).toBe("awaiting_approval");
    const back = vlad(home, ["task", "set", id, "running", "--json"]);
    expect(back.code, back.err).toBe(0);

    const r2 = report("### Yapılanlar\n- Bu rapor önceki raporun yerine geçer; ayrıntı #1'de.\n", "r2.md");
    expect(r2.code, r2.err).toBe(0);
    expect(JSON.parse(r2.out).warnings?.length ?? 0).toBeGreaterThan(0);
    expect(taskState(home, id)).toBe("awaiting_approval");

    const cur = section("## Kapanış raporu")!;
    expect(cur).toContain("yerine geçer");
    expect(cur).not.toContain("BIRINCI-RAPOR-ICERIGI");
    const prev = section("## Önceki raporlar")!;
    expect(prev).toContain("### Önceki rapor #1");
    expect(prev).toContain("BIRINCI-RAPOR-ICERIGI");
  });

  it("atıfsız tam metin ikinci rapor uyarı üretmez; aynı metin yeniden gelirse birikmez", () => {
    report("### Yapılanlar\n- bir\n");
    vlad(home, ["task", "set", id, "running"]);
    const r2 = report("### Yapılanlar\n- iki, tam metin\n", "r2.md");
    expect(JSON.parse(r2.out).warnings ?? []).toEqual([]);
    vlad(home, ["task", "set", id, "running"]);
    report("### Yapılanlar\n- iki, tam metin\n", "r3.md");
    expect((section("## Önceki raporlar") ?? "").match(/### Önceki rapor #/g)).toHaveLength(1);
  });
});

describe("gerçek biçimli result fixture'ı ile ingest", () => {
  // T20261025-63 gerçek iki turlu result olayları: kümülatif total_cost_usd + model_usage_since_last_result
  const SHA = "a".repeat(40);
  const body = (n: number) => `[VLAD:LOG #${n}] tur ${n} adımı`;
  const result = (uuid: string, at: string, text: string, c: object) => ({
    created_at: at,
    result: { uuid, internal_anthropic_catchall: { is_error: false, subtype: "success", result: text, ...c } },
  });
  const events = {
    ccr: {
      data: [
        result("u-1", "2026-10-20T08:30:00Z", body(1), {
          num_turns: 42, duration_ms: 2690855, total_cost_usd: 1.0554,
          model_usage_since_last_result: { "claude-sonnet-5-5": { costUSD: 1.0554 } },
        }),
        result("u-2", "2026-10-20T09:15:00Z", body(2), {
          num_turns: 16, duration_ms: 823646, total_cost_usd: 1.4975,
          model_usage_since_last_result: { "claude-sonnet-5-5": { costUSD: 0.442 } },
        }),
      ],
      has_more: false,
    },
  };
  const ingest = () => {
    const f = join(home, "ev.json");
    writeFileSync(f, JSON.stringify(events));
    return vlad(home, ["task", "ingest", id, "--events-file", f, "--remote-head", SHA, "--json"]);
  };

  it("log satırı olay zamanını taşır, tur başına maliyet kümülatiften ayrı yazılır, ikinci ingest çiftlemez", () => {
    expect(ingest().code).toBe(0);
    expect(ingest().code).toBe(0);
    const lines = section("## İlerleme")!.split("\n");
    expect(lines.find((l) => l.includes("[cloud #1]"))).toMatch(/^- 2026-10-20T/);
    expect(lines.find((l) => l.includes("[cloud #2]"))).toMatch(/^- 2026-10-20T/);
    const m = lines.filter((l) => l.includes("ölçüm"));
    expect(m).toHaveLength(2);
    expect(m[0]).toContain("maliyet=$1.0554");
    expect(m[1]).toContain("maliyet=$0.442");
    expect(m[1]).not.toContain("maliyet=$1.4975");
    expect(m[1]).toContain("toplam=$1.4975");
    expect(m[1]).toContain("tur=16");
  });
});

describe("sahte süreç listesiyle stalled tespiti (kb üzerinde)", () => {
  const now = new Date("2026-10-26T12:00:00+03:00");
  const MIN = 60_000;
  const probe = (o: Partial<LivenessProbe>): LivenessProbe => ({ alive: () => true, transcriptMtime: () => null, ...o });
  const localRunning = (ageMin: number) => {
    const t = getTask(newTask(home));
    setState(t.data.id, "running", { worktree: "C:\\x\\wt\\" + t.data.id });
    const cur = getTask(t.data.id);
    writeDoc(cur.file, { ...cur.data, updated: nowIso(new Date(now.getTime() - ageMin * MIN)) }, cur.body);
    return t.data.id;
  };

  it("süreç yok + sessiz → stalled; süreç var ve taze transcript → running; bulut görevi dokunulmaz", () => {
    const dead = localRunning(7); // 5-15 dk penceresi: yalnız "süreç yok" yolu stalled yapar
    const live = localRunning(7);
    const cloudStill = getTask(id); // forceRunning bulut kurulumu: worktree yok
    const out = markSilentWorkers(
      now, defaultConfig(),
      probe({ alive: (tid) => tid === live, transcriptMtime: (wt) => (wt.endsWith(live) ? now.getTime() - MIN : null) }),
      "win32",
    ).map((t) => t.data.id);
    expect(out).toEqual([dead]);
    expect(getTask(dead).data.state).toBe("stalled");
    expect(getTask(live).data.state).toBe("running");
    expect(cloudStill.data.state).toBe("running");
  });

  it("Windows dışında hiçbir şeyi stalled yapmaz", () => {
    localRunning(500);
    expect(markSilentWorkers(now, defaultConfig(), probe({ alive: () => false }), "linux")).toEqual([]);
  });
});

describe("test ortamında gerçek launcher reddi", () => {
  const countClaude = () => {
    const r = spawnSync("tasklist", { encoding: "utf8" });
    return (r.stdout.match(/claude/gi) ?? []).length;
  };

  it("vitest ortamında koruma açık; VLAD_ALLOW_REAL_LAUNCHER yalnız '1' ile kalkar", () => {
    expect(process.env.VLAD_LAUNCHER).toBe("noop");
    expect(realLauncherBlocked()).toBe(true);
    expect(realLauncherBlocked({ VLAD_LAUNCHER: "noop", VLAD_ALLOW_REAL_LAUNCHER: "true" })).toBe(true);
    expect(realLauncherBlocked({ VLAD_LAUNCHER: "noop", VLAD_ALLOW_REAL_LAUNCHER: "1" })).toBe(false);
  });

  it("`task launch --dry-run` (korumadan muaf) süreç açmaz: claude süreç sayısı aynı", () => {
    const before = countClaude();
    const r = vlad(home, ["task", "launch", id, "--dry-run", "--json"], { env: { VLAD_LAUNCHER: "noop" } });
    expect(r.err).not.toMatch(/ENOENT.*claude/);
    expect(countClaude()).toBe(before);
  });
});
