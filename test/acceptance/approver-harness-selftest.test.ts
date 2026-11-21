import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approverDir, secretDir } from "../../src/mode/token.js";
import { FakeClock, FakeNtfyServer, SeededRandom, digestOf, makeCid, makeWorld, waitFor, writeRequest } from "./approver-harness.js";
import type { World } from "./approver-harness.js";
import goldenDigest from "../fixtures/approver/golden-digest.json" with { type: "json" };
import { IS_WIN } from "../support/platform.js";

// approver-kabul: harness'in kendi sağlamlığı (stub'a bağlı değil; bugün YEŞİL). Kabul testlerinin kırmızısı harness hatasından değil eksik uygulamadan gelmeli.
describe("approver-kabul: harness öz-sınaması", () => {
  let w: World;
  beforeEach(async () => { w = await makeWorld(); });
  afterEach(async () => { await w.dispose(); });

  // Windows'ta atlanır: 0700 dizin / 0600 dosya mod bitleri POSIX'e özgü; Windows'ta fs.stat mode 0666/0777 döner
  it.skipIf(IS_WIN)("gizli dizin ve VLAD_HOME geçici dizindedir; anahtar etkin; gerçek ~/.vlad-secret kullanılmaz", () => {
    expect(secretDir()).toBe(w.secret);
    expect(w.secret.startsWith(w.root)).toBe(true);
    expect(w.key).toMatch(/^[0-9a-f]{64}$/);
    expect(approverDir()).toBe(join(w.secret, "approver"));
    expect(statSync(approverDir()).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(approverDir(), "channel.json"), "utf8")).toContain("vlad-q-");
  });

  it("dispose geçici kökü siler ve gizli dizini geri verir", async () => {
    const root = w.root, prev = secretDir();
    expect(prev).toBe(w.secret);
    await w.dispose();
    expect(existsSync(root)).toBe(false);
    expect(secretDir()).not.toBe(prev);
    w = await makeWorld(); // afterEach tekrar dispose eder
  });

  it("digestOf plandaki golden digest'i verir (formül uygulamadan bağımsız)", () => {
    expect(digestOf(goldenDigest.input)).toBe(goldenDigest.expected);
  });

  // Windows'ta atlanır: 0600 mod biti POSIX'e özgü
  it.skipIf(IS_WIN)("writeRequest istemci gibi yazar: inbox/<cid>.json 0600, üzerine yazma yok", () => {
    const cid = writeRequest(w, { argv: ["mode", "off"] });
    const f = join(w.dir, "inbox", `${cid}.json`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ v: 1, cid, op: "mode off", argv: ["mode", "off"], requester: "vlad-07" });
    expect(() => writeRequest(w, { argv: ["mode", "off"], cid })).toThrow();
  });

  it("FakeClock göreli başlar ve ilerler; SeededRandom her çağrıda farklı bayt verir; cid biçimi geçerli", () => {
    const c = new FakeClock(); const t0 = c.now().getTime();
    expect(Math.abs(t0 - Date.now())).toBeLessThan(5000);
    c.advance(61_000);
    expect(c.now().getTime() - t0).toBe(61_000);
    const r = new SeededRandom("x");
    expect(r.bytes(16).equals(r.bytes(16))).toBe(false);
    expect(r.bytes(40)).toHaveLength(40);
    expect(makeCid()).toMatch(/^[a-z2-7]{26}$/);
    expect(makeCid()).not.toBe(makeCid());
  });
});

describe("approver-kabul: sahte ntfy öz-sınaması", () => {
  let n: FakeNtfyServer;
  beforeEach(async () => { n = new FakeNtfyServer(); await n.start(); });
  afterEach(async () => { await n.stop(); });

  it("yayını kaydeder, akış açılışı + mesaj olayını NDJSON verir, düğme POST'u aboneye `message` olarak gider", async () => {
    const ac = new AbortController();
    const res = await fetch(`${n.url}/vlad-r-abc/json?since=all`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += dec.decode(value); } })().catch(() => undefined);
    await waitFor(() => text.includes('"event":"open"'), "open olayı");
    expect(n.connections[0]).toMatchObject({ topic: "vlad-r-abc", since: "all" });
    await fetch(`${n.url}/`, { method: "POST", body: JSON.stringify({ topic: "vlad-q-x", title: "t", message: "m", actions: [{ action: "http", label: "Onayla", url: `${n.url}/vlad-r-abc`, method: "POST", body: "a1.id.tag", clear: true }] }) });
    expect(n.published).toHaveLength(1);
    expect(await n.press(n.published[0]!, "Onayla")).toBe("a1.id.tag");
    await waitFor(() => text.includes('"message":"a1.id.tag"'), "mesaj olayı");
    expect(n.posts).toEqual([{ topic: "vlad-r-abc", body: "a1.id.tag" }]);
    ac.abort();
    await pump;
  });

  it("başarısızlık kuyruğu: yayın 500, akış 429 Retry-After", async () => {
    n.failPublish.push({ status: 500 });
    expect((await fetch(`${n.url}/`, { method: "POST", body: "{}" })).status).toBe(500);
    n.failStream.push({ status: 429, retryAfter: 2 });
    const r = await fetch(`${n.url}/t/json`);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("2");
  });
});
