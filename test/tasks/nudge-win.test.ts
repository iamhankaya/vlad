import { describe, expect, it } from "vitest";
import { nudgeVia } from "../../src/tasks/nudge.js";
import { winPane, winScriptPattern, type WinRun } from "../../src/tasks/nudge-win.js";

// F-vlad-370: Windows tarafı. Gerçek pencere/powershell yok: `run` sahte konsolu oynar (find/type/enter/screen çıktı sözleşmesi).
const box = (text: string) => `● önceki çıktı\n╭──────────╮\n│ > ${text}\n╰──────────╯`;

/** Sahte pencere: type kutuya yazar; Enter, `swallow` kadar yutulur, sonra kutuyu boşaltır. */
function fakeWindow(o: { exists?: boolean; swallow?: number; err?: string } = {}) {
  const calls: { mode: string; env: Record<string, string>; args: string[] }[] = [];
  let typed = ""; let enters = 0;
  const run: WinRun = (file, args, env) => {
    calls.push({ mode: env.VLAD_NUDGE_MODE!, env, args });
    expect(file).toBe("powershell.exe");
    if (o.err) return `ERR ${o.err}\r\n`;
    switch (env.VLAD_NUDGE_MODE) {
      case "find": return o.exists === false ? "NONE\r\n" : "PID 4242\r\n";
      case "type": typed = Buffer.from(env.VLAD_NUDGE_TEXT_B64!, "base64").toString("utf8"); return "OK\r\n";
      case "enter": enters++; if (enters > (o.swallow ?? 0)) typed = ""; return "OK\r\n";
      case "screen": return `SCREEN ${Buffer.from(box(typed), "utf8").toString("base64")}\r\n`;
      default: return "ERR mod\r\n";
    }
  };
  return { run, calls };
}

describe("winPane + nudgeVia (Windows konsolu)", () => {
  it("metni bir kez yazar, Enter yollar, ekran boşalınca teslim sayar", async () => {
    const w = fakeWindow();
    const r = await nudgeVia(winPane("T1", w.run), "merhaba dünya ğüşiöç", async () => {});
    expect(r).toEqual({ delivered: true, enters: 1 });
    expect(w.calls.map((c) => c.mode)).toEqual(["find", "type", "enter", "screen"]);
    expect(Buffer.from(w.calls[1]!.env.VLAD_NUDGE_TEXT_B64!, "base64").toString("utf8")).toBe("merhaba dünya ğüşiöç");
  });
  it("Enter yutulursa kutu dolu kaldığı sürece Enter'ı tekrarlar, metni yeniden yazmaz", async () => {
    const w = fakeWindow({ swallow: 2 });
    expect(await nudgeVia(winPane("T1", w.run), "x y z", async () => {})).toEqual({ delivered: true, enters: 3 });
    expect(w.calls.filter((c) => c.mode === "type")).toHaveLength(1);
  });
  it("sınırda boşalmazsa delivered=false", async () => {
    const w = fakeWindow({ swallow: 99 });
    expect(await nudgeVia(winPane("T1", w.run), "x y z", async () => {}, { maxEnters: 2 })).toEqual({ delivered: false, enters: 2 });
  });
  it("pencere bulunamazsa açık hata; hiçbir şey yazılmaz", async () => {
    const w = fakeWindow({ exists: false });
    await expect(nudgeVia(winPane("T1", w.run), "x", async () => {})).rejects.toThrow(/çalışan penceresi yok: T1/);
    expect(w.calls.map((c) => c.mode)).toEqual(["find"]);
  });
  it("betik ERR satırı hata olarak yükselir", async () => {
    const w = fakeWindow({ err: "AttachConsole 5" });
    await expect(nudgeVia(winPane("T1", w.run), "x", async () => {})).rejects.toThrow(/AttachConsole 5/);
  });
  it("metin komut satırına girmez (ortamda taşınır); betik EncodedCommand ile gider ve konsol API'lerini içerir", async () => {
    const w = fakeWindow();
    await nudgeVia(winPane("T1", w.run), "tırnak\" ve ' $x `y", async () => {});
    for (const c of w.calls) expect(c.args.join(" ")).not.toContain("tırnak");
    const enc = w.calls[0]!.args[w.calls[0]!.args.indexOf("-EncodedCommand") + 1]!;
    const script = Buffer.from(enc, "base64").toString("utf16le");
    for (const needle of ["AttachConsole", "WriteConsoleInputW", "ReadConsoleOutputCharacterW", "CONIN$", "CONOUT$", "VLAD_NUDGE_SCRIPT"]) expect(script).toContain(needle);
    expect(w.calls[0]!.env.VLAD_NUDGE_SCRIPT).toBe(winScriptPattern("T1"));
    expect(winScriptPattern("T20261121-50")).toBe("\\vlad\\t20261121-50.ps1");
  });
  it("satır sonu içeren metin reddedilir", async () => {
    await expect(nudgeVia(winPane("T1", fakeWindow().run), "a\nb", async () => {})).rejects.toThrow(/tek satır/);
  });
});
