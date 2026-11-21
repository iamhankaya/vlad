import { describe, expect, it } from "vitest";
import { inputBoxHolds, nudgeWorker, type NudgeDeps } from "../../src/tasks/nudge.js";

// T20261121-19 doğrulama (F-vlad-361): nudge'ın kenar durumları. hatalar T20261121-28 ile düzeltildi;
function fake(panes: string[]) {
  const calls: string[][] = [];
  let i = 0;
  const deps: NudgeDeps = {
    tmux: (args) => {
      calls.push(args);
      if (args[0] === "capture-pane") return panes[Math.min(i, panes.length - 1)];
      if (args[0] === "send-keys" && args.at(-1) === "Enter") i++;
      return "";
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

describe("nudge doğrulama (F-vlad-361)", () => {
  // Kanıt (gerçek tmux 3.8, özel soket): `tmux send-keys -t s -l "-h dikkat"` → "command send-keys: unknown flag -h", çıkış 1;
  // `-l -- "-h dikkat"` çalışır. Tire ile başlayan metin ("- önce testleri çalıştır") bu yüzden gönderilemez.
  it("tire ile başlayan metin tmux bayrağı sanılmaz: -l'den sonra `--` gelir", async () => {
    const { deps, calls } = fake([""]);
    await nudgeWorker("T1", "- önce testleri çalıştır", deps);
    const lit = calls.find((c) => c[0] === "send-keys" && c.includes("-l"))!;
    expect(lit.slice(lit.indexOf("-l") + 1)).toEqual(["--", "- önce testleri çalıştır"]);
  });

  // Teslim sonrası çalışan kullanıcı mesajını dökümde ("> metin") yansıtır; kısa çıktıda bu, son 8 satır içinde kalır
  // ve kutu boş olsa da inputBoxHolds true döner → teslim edilmiş mesaj "edilmedi" sayılır (5 boş Enter + çıkış 1).
  it("teslimden sonra dökümdeki yansıma (kutu boş) 'kutuda' sayılmaz", () => {
    const text = "lütfen testleri çalıştır";
    const pane = ["> " + text, "", "✻ Çalışıyor… (3s)", "", "╭────────────╮", "│ >          │", "╰────────────╯", "  ? for shortcuts"].join("\n");
    expect(inputBoxHolds(pane, text)).toBe(false);
  });

  // Karakterizasyon (yeşil)
  it("kutu hâlâ doluysa (gerçek istem kutusu satırı) true", () => {
    const pane = ["● çıktı", "╭────────────╮", "│ > lütfen testleri çalıştır │", "╰────────────╯", "  ? for shortcuts"].join("\n");
    expect(inputBoxHolds(pane, "lütfen testleri çalıştır")).toBe(true);
  });
  it("boş metin hiçbir zaman 'kutuda' sayılmaz", () => {
    expect(inputBoxHolds("> x", "   ")).toBe(false);
  });
});
