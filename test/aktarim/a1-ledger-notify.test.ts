import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedger } from "../../src/transfer/ledger.js";
import { createNotifier, notifyCommand } from "../../src/platform/notify.js";
import { NativeDisabledError } from "../../src/platform/native.js";
import { rmTemp } from "../helpers.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-a1-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmTemp(dirs.pop()!); });

describe("A1.2 ledger", () => {
  it("put/get gidiş dönüş; yoksa undefined", async () => {
    const l = createLedger(tmp());
    expect(await l.get("mac\0" + "a".repeat(32))).toBeUndefined();
    const r = { state: "committed" as const, items: [{ name: "a.txt", kind: "file" as const, size: 3, path: "/x/a.txt" }] };
    await l.put("mac\0" + "a".repeat(32), r);
    expect(await l.get("mac\0" + "a".repeat(32))).toEqual(r);
    await l.put("mac\0" + "a".repeat(32), { state: "aborted" });
    expect(await l.get("mac\0" + "a".repeat(32))).toEqual({ state: "aborted" });
  });
  it("anahtar yol gezmesi yapamaz: dosya adı özet, dizin dışına yazılmaz", async () => {
    const d = tmp();
    await createLedger(d).put("../../evil\0x", { state: "aborted" });
    const files = readdirSync(join(d, "xfer", "delivered"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });
  it("yeni örnek aynı diskten okur (yeniden başlama); geride temp dosya kalmaz", async () => {
    const d = tmp();
    await createLedger(d).put("k", { state: "committing", planned: ["a"], published: [] });
    expect(await createLedger(d).get("k")).toEqual({ state: "committing", planned: ["a"], published: [] });
    expect(readdirSync(join(d, "xfer", "delivered")).every((f) => f.endsWith(".json"))).toBe(true);
  });
  it("bozuk kayıt sessizce yok sayılmaz: failed", async () => {
    const d = tmp();
    const l = createLedger(d);
    await l.put("k", { state: "aborted" });
    const f = join(d, "xfer", "delivered", readdirSync(join(d, "xfer", "delivered"))[0]!);
    writeFileSync(f, "{bozuk");
    await expect(l.get("k")).rejects.toMatchObject({ code: "failed" });
    mkdirSync(join(d, "x"), { recursive: true });
  });
});

describe("A1.7 notifyCommand", () => {
  const evil = ["'; calc", "$(touch /tmp/x)", "a\nb", '"; rm -rf ~ #', "`id`"];
  it("darwin: osascript argv; metin betik dizesine gömülmez (argv ile)", () => {
    for (const e of evil) {
      const c = notifyCommand("darwin", e, e);
      expect(c.file).toBe("osascript");
      const code = c.args.filter((_, i) => c.args[i - 1] === "-e").join("\n");
      expect(code).not.toContain(e);   // metin betik kodunda değil
      expect(c.args.slice(-2)).toEqual([e, e]); // argv olarak geçer
    }
  });
  it("win32: powershell.exe + VLAD_TOAST_* env; metin komut satırında yok", () => {
    for (const e of evil) {
      const c = notifyCommand("win32", e, e);
      expect(c.file).toBe("powershell.exe");
      expect(c.args.join(" ")).not.toContain(e);
      expect(c.env).toEqual({ VLAD_TOAST_TITLE: e, VLAD_TOAST_BODY: e });
    }
  });
});

describe("A1.7 createNotifier", () => {
  it("exec hatasını yutar", async () => {
    const n = createNotifier("darwin", async () => { throw new Error("boom"); });
    await expect(n.notify("t", "b")).resolves.toBeUndefined();
  });
  it("exec komutu notifyCommand ile üretilir", async () => {
    const seen: unknown[] = [];
    await createNotifier("win32", async (c) => { seen.push(c); }).notify("T", "B");
    expect(seen).toEqual([notifyCommand("win32", "T", "B")]);
  });
  it("exec verilmezse VLAD_NO_NATIVE=1 → NativeDisabledError yutulmaz", async () => {
    await expect(createNotifier("darwin").notify("t", "b")).rejects.toBeInstanceOf(NativeDisabledError);
  });
});
