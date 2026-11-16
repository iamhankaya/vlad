import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secretHits, noteLeaks, absoluteHomeLeaks } from "../support/approver-secrets.js";

const dir = join(import.meta.dirname, "..", "fixtures");
const json = (p: string) => JSON.parse(readFileSync(join(dir, p), "utf8"));

describe("approver sözleşmesi: golden digest (uygulamadan bağımsız formül)", () => {
  it("dosyadaki beklenen değer plandaki formülle yeniden hesaplanır; alan değişince digest değişir", () => {
    const g = json("approver/golden-digest.json");
    const d = (i: typeof g.input) => createHash("sha256").update(JSON.stringify(["VLAD-APPROVE1", i.id, i.argv, i.requestedAt, i.expiresAt, i.nonce, i.requester, i.ctx.home, i.ctx.kb, i.ctx.cli])).digest("hex");
    expect(g.expected).toBe(d(g.input));
    expect(g.expected).toMatch(/^[0-9a-f]{64}$/);
    for (const [k, v] of Object.entries(g.variants as Record<string, string>)) k === "base" ? expect(v).toBe(g.expected) : expect(v, k).not.toBe(g.expected);
    // her alan digest'e girer: alan değişince yeniden hesaplanan özet değişir (computeDigest bir alanı dışarıda bırakamaz)
    const mut: Record<string, (i: typeof g.input) => typeof g.input> = {
      id: (i) => ({ ...i, id: "a".repeat(26) }), argv: (i) => ({ ...i, argv: [...i.argv, "--push"] }), requestedAt: (i) => ({ ...i, requestedAt: "2026-11-16T14:21:00+03:00" }),
      expiresAt: (i) => ({ ...i, expiresAt: "2026-11-16T14:26:00+03:00" }), nonce: (i) => ({ ...i, nonce: "f".repeat(32) }), requester: (i) => ({ ...i, requester: "x" }),
      home: (i) => ({ ...i, ctx: { ...i.ctx, home: "/h" } }), kb: (i) => ({ ...i, ctx: { ...i.ctx, kb: "/k" } }), cli: (i) => ({ ...i, ctx: { ...i.ctx, cli: "/c" } }),
    };
    for (const [k, m] of Object.entries(mut)) expect(d(m(g.input)), k).not.toBe(g.expected);
  });
});

describe("approver sözleşmesi: golden bildirimler", () => {
  for (const n of ["night", "install", "setup-upgrade"]) {
    it(`${n}: şekil + sır yok + $HOME yok`, () => {
      const g = json(`approver/golden-notification-${n}.json`);
      expect(g.tz).toBe("Europe/Istanbul");
      expect(g.pending.status).toBe("pending");
      expect(g.expected.title).toBe(`VLAD onay: ${g.pending.op}`);
      const lines = g.expected.message.split("\n") as string[];
      expect(lines.at(-1)).toBe(`Kimlik: ${g.pending.shortId}`);
      expect(lines.some((l) => l.startsWith("İsteyen: ") && l.endsWith("(beyan, doğrulanmamış)"))).toBe(true);
      expect(lines.some((l) => l.startsWith("Hedef: ~"))).toBe(true);
      expect(secretHits(g.expected.message, { allowTopic: true })).toEqual([]);
      expect(absoluteHomeLeaks(g.expected.message, g.homedir)).toBe(false);
    });
  }
  it("setup: İşlem satırı yok, yapılandırılmış etki özeti var", () => {
    const m = json("approver/golden-notification-setup-upgrade.json").expected.message as string;
    expect(m).not.toMatch(/^İşlem:/m);
    for (const k of ["Yükseltme: ", "Kapsam: ", "Dış etki: "]) expect(m).toContain(k);
  });
});

describe("approver sözleşmesi: ntfy fixture'ları (belge türevli) ve sır kümesi", () => {
  it("docs-derived-* dosyaları ayrışır; README kaynak URL'lerini ve 'gerçek yanıt örneği yok' notunu taşır", () => {
    const files = readdirSync(join(dir, "ntfy")).filter((f) => f.startsWith("docs-derived-"));
    expect(files.length).toBe(7);
    for (const f of files) {
      const t = readFileSync(join(dir, "ntfy", f), "utf8");
      if (f.endsWith(".jsonl")) for (const l of t.trim().split("\n")) expect(() => JSON.parse(l), f).not.toThrow();
      else expect(() => JSON.parse(t), f).not.toThrow();
    }
    const readme = readFileSync(join(dir, "ntfy", "README.md"), "utf8");
    expect(readme).toContain("https://docs.ntfy.sh/");
    expect(readme).toContain("Gerçek yanıt örneği yok");
  });
  it("split-chunk: parçalar birleşince iki message olayı, UTF-8 sınırda kesik", () => {
    const f = json("ntfy/docs-derived-stream-split-chunk.json");
    const [a, b] = (f.chunksBase64 as string[]).map((c) => Buffer.from(c, "base64"));
    const msgs = Buffer.concat([a!, b!]).toString("utf8").trim().split("\n").map((l) => JSON.parse(l).message);
    expect(msgs).toEqual(f.expectedMessages);
    expect(a!.toString("utf8")).toContain("�"); // kesik çok baytlı karakter: akış çözücü parçalı UTF-8'i işlemeli
  });
  it("SECRET_PATTERNS: örnek sırları yakalar, zararsız metni geçirir", () => {
    expect(secretHits("anahtar " + "ab".repeat(32))).toContain("mode.key hex (64 hex, tek başına)");
    expect(secretHits("VMT2.1.aa.bb.cc")).toContain("mod belirteci VMT1/VMT2");
    expect(secretHits("SECRET-SENTINEL-1 --answers x")).toContain("--answers / sentinel");
    expect(secretHits("https://ntfy.sh/vlad-r-aaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual(["istek/yanıt konusu"]);
    expect(secretHits("https://ntfy.sh/vlad-r-aaaaaaaaaaaaaaaaaaaaaaaaaa", { allowTopic: true })).toEqual([]);
    expect(secretHits("İşlem: vlad mode off · Kimlik: mfrggzdf")).toEqual([]);
    expect(noteLeaks("x".repeat(60), "x".repeat(60) + "GIZLI-SON")).toBe(false);
    expect(noteLeaks("…GIZLI-SON", "x".repeat(60) + "GIZLI-SON")).toBe(true);
  });
});
