import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/commands/manifest.js";
import { PROTECTED_OPS, renderNotification, validateRequest } from "../../src/approver/request.js";
import type { PendingRecord } from "../../src/approver/types.js";

// Telefon onayı komut kapsamı (T20261120-22; karar 2026-11-20 seçenek A + güvenlik incelemesi): engelli küme manifest türevi.
const CID = "a".repeat(26);
const mk = (argv: string[], op: string, over: Record<string, unknown> = {}) => ({ v: 1, cid: CID, op, argv, requestedAt: "2026-11-16T14:20:00+03:00", requester: "vlad-07", ...over });
const reason = (raw: unknown) => { const r = validateRequest(raw); return r.ok ? "ok" : r.reason; };
/** Bilinçli izin kümesi (açık liste): bunlar console:none olsa da istenebilir. */
const ALLOW = ["mode night", "mode watch", "mode off", "install", "setup", "monitor install", "monitor uninstall"];
const blockedByManifest = (s: (typeof COMMANDS)[number]) => !ALLOW.includes(s.path.join(" ")) && (s.console.kind === "none" || ["remote", "agent"].includes(s.path[0]!));

describe("approver: komut kapsamı manifestten türer", () => {
  it("her manifest yolu: console:none/remote/agent engelli (izin kümesi hariç), diğerleri kabul", () => {
    let blocked = 0, ok = 0;
    for (const s of COMMANDS) {
      const path = s.path.join(" ");
      const argv = [...s.path];
      if (path === "mode watch") argv.push("on");
      if (path === "setup") argv.push("--upgrade");
      const want = blockedByManifest(s) ? "not_allowlisted" : "ok";
      expect(reason(mk(argv, path)), path).toBe(want);
      if (want === "ok") ok++; else blocked++;
    }
    expect(blocked).toBeGreaterThan(10); expect(ok).toBeGreaterThan(40);
  });
  it("izin kümesi açık ve tam: protected = bu liste; kendini isteyen/servis/kimlik komutları engelli", () => {
    expect([...PROTECTED_OPS].sort()).toEqual([...ALLOW].sort());
    for (const p of ["mode request", "mode token", "approver run", "approver install", "approver uninstall", "approver rotate", "approver unlock", "task close", "task release", "agent start", "remote"])
      expect(reason(mk(p.split(" "), p)), p).toBe("not_allowlisted");
    for (const p of ["approver status", "approver requests", "task list", "task set"]) expect(reason(mk(p.split(" "), p)), p).toBe("ok");
  });
  it("genel komut serbest argümanlarla geçer; bilinmeyen yol ve op uyuşmazlığı not_allowlisted", () => {
    expect(reason(mk(["monitor", "install", "--server", "x y"], "monitor install"))).toBe("ok");
    expect(reason(mk(["task", "set", "T20261120-22", "cancelled", "--reason", "neden"], "task set"))).toBe("ok");
    expect(reason(mk(["rm", "-rf", "/"], "rm"))).toBe("not_allowlisted");
    expect(reason(mk(["monitor", "nope"], "monitor nope"))).toBe("not_allowlisted");
    expect(reason(mk(["monitor", "install"], "monitor"))).toBe("not_allowlisted");
    expect(reason(mk(["monitor", "install"], "task set"))).toBe("not_allowlisted");
  });
  it("genel komutta boyut ve kontrol karakteri sınırı; --note sınırı yalnız mode night'a özgü", () => {
    expect(reason(mk(["task", "log", "T20261120-22", "x".repeat(201)], "task log"))).toBe("too_large");
    expect(reason(mk(["task", "log", "T20261120-22", "a\nb"], "task log"))).toBe("control_char");
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
const line0 = (argv: string[], op: string) => renderNotification(pending(argv, op)).message.split("\n")[0];

describe("approver: genel komut bildirimi çalışacak argv'yi birebir ve ASCII gösterir", () => {
  it("boşluklu/boş/tırnaklı değerler JSON tırnaklı", () => {
    expect(line0(["task", "set", "T20261120-22", "cancelled", "--reason", "iki kelime", "", 'a"b'], "task set")).toBe('İşlem: vlad task set T20261120-22 cancelled --reason "iki kelime" "" "a\\"b"');
  });
  it("ASCII dışı karakterler \\uXXXX gösterilir (benzer harf/birleştirici işaret aldatmacası görünür olur), metin bayrakları dahil", () => {
    expect(line0(["task", "log", "T20261120-22", "gеçiş"], "task log")).toBe('İşlem: vlad task log T20261120-22 "g\\u0435\\u00e7i\\u015f"'); // U+0435 Kiril 'е'
    expect(line0(["task", "log", "T20261120-22", "--note", "é"], "task log")).toBe('İşlem: vlad task log T20261120-22 --note "e\\u0301"');
    expect(line0(["task", "log", "T20261120-22", "\u{1F600}"], "task log")).toBe('İşlem: vlad task log T20261120-22 "\\ud83d\\ude00"');
    expect(/^[\x20-\x7e]*$/.test(line0(["task", "log", "T20261120-22", "ıİ"], "task log")!.replace(/^İşlem/, "Islem"))).toBe(true);
  });
  it("eski işlemlerin bildirimi değişmez: --note okunur kalır", () => {
    expect(renderNotification(pending(["mode", "night", "--note", "gece işi"], "mode night")).message).toContain('--note "gece işi"');
  });
  it("uzun argv kırpılmaz: istek reddedilir (too_large)", () => {
    const argv = ["task", "log", "T20261120-22", ...Array.from({ length: 12 }, () => "y".repeat(100))];
    expect(reason(mk(argv, "task log"))).toBe("too_large");
  });
});
