import { describe, expect, it } from "vitest";
import { inputBoxHolds, nudgeWorker, type NudgeDeps } from "../../src/tasks/nudge.js";

/** Sahte tmux: pane'i betikten okur; her Enter bir sonraki pane'e geçer (son pane tekrarlanır = Enter yutuldu). */
function fake(panes: string[], o: { hasSession?: boolean } = {}) {
  const calls: string[][] = [];
  let i = 0;
  const deps: NudgeDeps = {
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "has-session") { if (o.hasSession === false) throw new Error("no session"); return ""; }
      if (args[0] === "capture-pane") return panes[Math.min(i, panes.length - 1)];
      if (args[0] === "send-keys" && args.at(-1) === "Enter") i++;
      return "";
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

const BOX = (text: string) => `● önceki çıktı\n╭──────────╮\n│ > ${text}\n╰──────────╯\n  ? for shortcuts`;

describe("inputBoxHolds", () => {
  it("istem kutusunda metnin kuyruğu varsa true, yoksa false", () => {
    expect(inputBoxHolds(BOX("lütfen testleri çalıştır"), "lütfen testleri çalıştır")).toBe(true);
    expect(inputBoxHolds(BOX(""), "lütfen testleri çalıştır")).toBe(false);
  });
  it("sözcük içinde sarılmış metin (çalı⏎ştır) kutuda sayılır (T20261121-32)", () => {
    const pane = "● önceki\n╭──────────╮\n│ > lütfen testleri çalı\n│ ştır\n╰──────────╯";
    expect(inputBoxHolds(pane, "lütfen testleri çalıştır")).toBe(true);
  });
  it("yalnız son satırlara bakar: eski çıktıda geçen metin kutu sayılmaz", () => {
    const pane = `> lütfen testleri çalıştır\n${"x\n".repeat(30)}${BOX("")}`;
    expect(inputBoxHolds(pane, "lütfen testleri çalıştır")).toBe(false);
  });
});

describe("nudgeWorker (F-vlad-361)", () => {
  it("capture-pane -J ile sarılmış satırları birleştirir (T20261121-32)", async () => {
    const { deps, calls } = fake([BOX("x"), BOX("")]);
    await nudgeWorker("T1", "x", deps);
    expect(calls.find((c) => c[0] === "capture-pane")).toContain("-J");
  });
  it("metni -l ile yazar, Enter yollar, kutu boşalınca teslim sayar", async () => {
    const { deps, calls } = fake([BOX("merhaba dünya"), BOX("")]);
    const r = await nudgeWorker("T1", "merhaba dünya", deps);
    expect(r).toEqual({ delivered: true, enters: 1 });
    expect(calls[1]).toEqual(["send-keys", "-t", "vlad-T1", "-l", "--", "merhaba dünya"]);
  });
  it("meşgul çalışanda Enter yutulursa kutu dolu kaldığı sürece Enter'ı tekrarlar", async () => {
    const { deps } = fake([BOX("merhaba dünya"), BOX("merhaba dünya"), BOX("")]);
    expect(await nudgeWorker("T1", "merhaba dünya", deps)).toEqual({ delivered: true, enters: 2 });
  });
  it("deneme sınırında teslim edilmediyse delivered=false döner (metni yeniden yazmaz)", async () => {
    const { deps, calls } = fake([BOX("merhaba dünya")]);
    const r = await nudgeWorker("T1", "merhaba dünya", deps, { maxEnters: 3 });
    expect(r).toEqual({ delivered: false, enters: 3 });
    expect(calls.filter((c) => c.includes("-l")).length).toBe(1);
  });
  it("tmux oturumu yoksa açık hata verir", async () => {
    const { deps } = fake([], { hasSession: false });
    await expect(nudgeWorker("T1", "x", deps)).rejects.toThrow(/tmux oturumu yok/);
  });
  it("çok satırlı metni reddeder (Enter istemi bölerdi)", async () => {
    const { deps } = fake([BOX("")]);
    await expect(nudgeWorker("T1", "a\nb", deps)).rejects.toThrow(/tek satır/);
  });
});
