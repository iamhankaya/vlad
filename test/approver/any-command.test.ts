import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { renderNotification, validateRequest } from "../../src/approver/request.js";
import type { PendingRecord } from "../../src/approver/types.js";

// Telefon onayı her vlad alt komutunu çalıştırabilir (T20261120-22; karar 2026-11-20 seçenek A). Saf doğrulama/bildirim testleri; ağ/süreç yok.
const CID = "a".repeat(26);
const mk = (argv: string[], op: string, over: Record<string, unknown> = {}) => ({ v: 1, cid: CID, op, argv, requestedAt: "2026-11-16T14:20:00+03:00", requester: "vlad-07", ...over });
const reason = (raw: unknown) => { const r = validateRequest(raw); return r.ok ? "ok" : r.reason; };
const BLOCKED = new Set(["mode request", "mode token","approver run", "approver uninstall", "approver rotate", "approver unlock"]);

describe("approver: her manifest komut yolu kabul edilir", () => {
  it("manifestteki her yol (engelli döngü komutları hariç) op = yol ile geçerlidir", () => {
    for (const s of COMMANDS) {
      const path = s.path.join(" ");
      if (BLOCKED.has(path)) continue;
      const argv = [...s.path];
      // eski beş işlem kendi şemasıyla sıkı kalır (örn. `mode watch` argümansız geçersiz); onlar için şemaya uygun argüman ver
      if (path === "mode watch") argv.push("on");
      if (path === "setup") argv.push("--upgrade");
      expect(reason(mk(argv, path)), path).toBe("ok");
    }
  });
  it("genel komut serbest argümanlarla geçer", () => {
    expect(reason(mk(["monitor", "install", "--server", "x y"], "monitor install"))).toBe("ok");
    expect(reason(mk(["task", "set", "T20261120-22", "cancelled", "--reason", "neden"], "task set"))).toBe("ok");
    expect(reason(mk(["approver", "install"], "approver install"))).toBe("ok");
  });
  it("bilinmeyen komut yolu ve op/argv uyuşmazlığı not_allowlisted", () => {
    expect(reason(mk(["rm", "-rf", "/"], "rm"))).toBe("not_allowlisted");
    expect(reason(mk(["monitor", "nope"], "monitor nope"))).toBe("not_allowlisted");
    expect(reason(mk(["monitor", "install"], "monitor"))).toBe("not_allowlisted");
    expect(reason(mk(["monitor", "install"], "task set"))).toBe("not_allowlisted");
    expect(reason(mk(["--help"], "--help"))).toBe("not_allowlisted");
  });
  it("kendini isteyen döngü reddedilir: mode request ve approver servis yönetimi", () => {
    for (const p of BLOCKED) expect(reason(mk(p.split(" "), p)), p).toBe("not_allowlisted");
    expect(reason(mk(["mode", "request", "night"], "mode request"))).toBe("not_allowlisted");
  });
  it("genel komutta da boyut ve kontrol karakteri sınırı geçerli", () => {
    expect(reason(mk(["task", "log", "T20261120-22", "x".repeat(201)], "task log"))).toBe("too_large");
    expect(reason(mk(["task", "log", "T20261120-22", "a\nb"], "task log"))).toBe("control_char");
  });
  it("--note sınırı yalnız mode night'a özgü: başka komutta aynı ad serbest", () => {
    expect(reason(mk(["task", "log", "T20261120-22", "--note", "x".repeat(100)], "task log"))).toBe("ok");
    expect(reason(mk(["mode", "night", "--note", "x".repeat(61)], "mode night"))).toBe("too_large");
  });
  it("eski işlemlerin sıkı şemaları korunur", () => {
    expect(reason(mk(["mode", "night", "--bogus"], "mode night"))).toBe("bad_flag");
    expect(reason(mk(["setup"], "setup"))).toBe("setup_answers_unsupported");
  });
});

const pending = (argv: string[], op: string): PendingRecord => ({
  v: 1, id: "mfrggzdfmztwq2lknnwg23tpoa", shortId: "mfrggzdf", cid: CID, op, argv, requestedAt: "2026-11-16T14:20:00+03:00", expiresAt: "2026-11-16T14:25:00+03:00",
  nonce: "0".repeat(32), respTopic: "vlad-r-" + "a".repeat(26), digest: "0".repeat(64), ctx: { home: "/h", kb: "/k", cli: "/c" }, keyGen: "0".repeat(16), status: "pending", requester: "vlad-07",
});

describe("approver: genel komut bildirimi çalışacak argv'yi birebir gösterir", () => {
  it("her argüman tek anlamlı: boşluklu/boş/tırnaklı değerler JSON tırnaklanır", () => {
    const m = renderNotification(pending(["task", "set", "T20261120-22", "cancelled", "--reason", "iki kelime", "", 'a"b'], "task set")).message;
    expect(m.split("\n")[0]).toBe('İşlem: vlad task set T20261120-22 cancelled --reason "iki kelime" "" "a\\"b"');
  });
  it("uzun argv kırpılmaz: istek reddedilir (too_large), bildirimde eksik gösterim olmaz", () => {
    const argv = ["task", "log", "T20261120-22", ...Array.from({ length: 12 }, () => "y".repeat(100))];
    expect(reason(mk(argv, "task log"))).toBe("too_large");
  });
});
