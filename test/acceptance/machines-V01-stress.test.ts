// V01 doğrulama: eşzamanlı yerleştirme stres turları (20 tur; K12 6 turluydu).
// Duvar saati eşiği yok; sonuç sayımı + NOOP_LOG (işçide açılan pencere sayısı). Tümü geçici dünyada, sahte kaynakla.
import { afterEach, describe, expect, it } from "vitest";
import { front, makeWorld, runVlad, type World } from "./machines-world.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });
const ROUNDS = 20;

describe("machines:V — eşzamanlı yerleştirme stres", () => {
  it("[windows], tek slot, 3 paralel launch × 20 tur: her turda tam 1 başarılı; windows'ta tam 1 yeni pencere", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    for (let i = 0; i < ROUNDS; i++) {
      const ids = [await w.newTask(), await w.newTask(), await w.newTask()];
      const before = w.noop(w.worker).length;
      const rs = await Promise.all(ids.map((id) => runVlad(w!.brain, ["task", "launch", id])));
      const ok = rs.filter((r) => r.code === 0).length;
      expect(ok, `tur ${i}: ${rs.map((r) => r.err).join(" | ")}`).toBe(1);
      expect(w.noop(w.worker).length - before, `tur ${i} pencere`).toBe(1);
      const states = ids.map((id) => front(w!.readTask(w!.brain, id), "state")).sort();
      expect(states, `tur ${i}`).toEqual(["queued", "queued", "running"]);
      for (const id of ids) w.setFront(id, { state: "done", machine: "windows" });
    }
  }, 600_000);

  it("[windows] kartı + mac boşken 20 tur: hiçbir görev mac'e yerleşmez (machine yalnız windows)", async () => {
    w = await makeWorld({ cardMachines: ["windows"] });
    await w.startAgents(["worker"]);
    for (let i = 0; i < ROUNDS; i++) {
      const ids = [await w.newTask(), await w.newTask()];
      await Promise.all(ids.map((id) => runVlad(w!.brain, ["task", "launch", id])));
      for (const id of ids) {
        const m = front(w.readTask(w.brain, id), "machine");
        expect(["windows", undefined, "null", "~", ""], `tur ${i} ${id}`).toContain(m);
        w.setFront(id, { state: "done", machine: "windows" });
      }
    }
  }, 600_000);
});
