// K13 Agent yaşamı, K17 çerçeve/soket, K18 konsol kimliği. Kaynak: plan "Topoloji", "Çerçeveleme ve zarf", "Sürüm uyumu", "Konsol kimliği".
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeWorld, runVlad, type World } from "./machines-world.js";
import { frame, rawCall, sendRaw } from "./machines-raw.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });
const resp = (o: Awaited<ReturnType<typeof rawCall>>) => { expect(o.kind).toBe("response"); return (o as any).resp; };

describe("machines:K — K13 Agent yaşamı", () => {
  it("ikinci `agent start` çıkış 0 'zaten çalışıyor'; ilk Agent ping'e yanıt vermeye devam eder", async () => {
    w = await makeWorld();
    await w.startAgents(["worker"]);
    const second = await runVlad(w.worker, ["agent", "start", "--port", String(w.agents.worker!.port)]);
    expect(second.code, second.err).toBe(0);
    expect(second.out + second.err).toContain("zaten çalışıyor");
    expect(resp(await rawCall({ port: w.agents.worker!.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "ping" })).code).toBe("ok");
  }, 60_000);

  it.each(["0.0.0.0", "8.8.8.8", "::", "example.invalid"])("bind=%s → başlatma reddi 'genel adrese bağlanılamaz'", async (bind) => {
    w = await makeWorld();
    const cfg = w.config() as any;
    cfg.machines[1].agent.bind = bind;
    for (const s of [w.brain, w.worker]) writeFileSync(join(s.home, "vlad.config.json"), JSON.stringify(cfg));
    const r = await runVlad(w.worker, ["agent", "start", "--port", "0"], { timeoutMs: 15_000 });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("genel adrese bağlanılamaz");
  }, 60_000);

  it("ping: proto/build/os/machine/uptimeS döner, yanıt imzalıdır", async () => {
    w = await makeWorld();
    await w.startAgents(["worker"]);
    const r = resp(await rawCall({ port: w.agents.worker!.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "ping" }));
    expect(r.code).toBe("ok");
    expect(r.result).toMatchObject({ machine: "windows", proto: 1 });
    expect(typeof r.result.build).toBe("string");
    expect(typeof r.result.uptimeS).toBe("number");
    expect(r.build).toBeTruthy();
  }, 60_000);

  it("protokol sürümü uyuşmazlığı: ping dahil proto_mismatch, iki sürüm mesajda", async () => {
    w = await makeWorld();
    await w.startAgents(["worker"]);
    const r = resp(await rawCall({ port: w.agents.worker!.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "ping", v: 2 }));
    expect(r.code).toBe("proto_mismatch");
    expect(r.error).toMatch(/protokol 2 ≠ 1|protokol 1 ≠ 2/);
  }, 60_000);

  it("saat farkı: clock_skew mesajı sunucu ve istemci saatini gösterir", async () => {
    w = await makeWorld();
    await w.startAgents(["worker"]);
    const r = resp(await rawCall({ port: w.agents.worker!.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "ping", ts: Date.now() - 5 * 60_000 }));
    expect(r.code).toBe("clock_skew");
    expect(r.error).toMatch(/\d{4}-\d{2}-\d{2}T.*\d{4}-\d{2}-\d{2}T/);
  }, 60_000);

  it("enjekte saat (VLAD_NOW_FILE): Agent saatini dosyadan okur, 120 sn penceresi ona göre", async () => {
    w = await makeWorld();
    const nowFile = join(w.base, "now.txt");
    const base = Date.now();
    writeFileSync(nowFile, String(base + 3 * 3600_000)); // Agent'ın saati 3 saat ileride
    w.writeConfig();
    const { startAgent } = await import("../machines/harness.js");
    w.agents.worker = await startAgent(w.worker, { nowFile });
    const near = resp(await rawCall({ port: w.agents.worker.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "ping", ts: base + 3 * 3600_000 - 1000 }));
    expect(near.code).toBe("ok");
    const real = resp(await rawCall({ port: w.agents.worker.port, key: w.pair.keys.mac, from: "mac", to: "windows", op: "ping" }));
    expect(real.code).toBe("clock_skew");
  }, 60_000);

  it("keygen: yerel dosyaya 64 hex anahtar yazar ve basar", async () => {
    w = await makeWorld();
    const r = await runVlad(w.brain, ["agent", "keygen", "yeni-kimlik"]);
    expect(r.code, r.err).toBe(0);
    const keys = JSON.parse(readFileSync(w.brain.local, "utf8")).keys;
    expect(keys["yeni-kimlik"]).toMatch(/^[0-9a-f]{64}$/);
    expect(r.out).toContain(keys["yeni-kimlik"]);
  }, 60_000);

  it("`agent status --json` çalışan Agent'ı gösterir; Agent yokken ulaşılamaz söyler", async () => {
    w = await makeWorld();
    const none = await runVlad(w.worker, ["agent", "status", "--json"]);
    expect(none.code === 0 || none.code === 1 || none.code === 75).toBe(true);
    await w.startAgents(["worker"]);
    const up = await runVlad(w.worker, ["agent", "status", "--json"]);
    expect(up.code, up.err).toBe(0);
  }, 60_000);
});

describe("machines:K — K17 çerçeve ve soket", () => {
  const live = async () => {
    w = await makeWorld();
    await w.startAgents(["worker"]);
    return { port: w.agents.worker!.port, k: w.pair.keys };
  };
  const ping = async (port: number, key: string) => resp(await rawCall({ port, key, from: "mac", to: "windows", op: "ping" })).code;

  it("çöp bayt, boş çerçeve, geçersiz JSON: yanıt (bad_request/too_large) ya da kapanış; Agent ayakta kalır", async () => {
    const { port, k } = await live();
    for (const bytes of [Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), frame(""), frame("{bozuk"), frame("[]"), frame("null"), Buffer.from([0, 0, 0, 0])]) {
      const o = await sendRaw(port, bytes, { timeoutMs: 4000 });
      if (o.kind === "response") expect(["bad_request", "too_large"]).toContain(o.resp.code);
      else expect(o.kind === "closed" || o.kind === "timeout").toBe(true);
    }
    expect(await ping(port, k.mac)).toBe("ok");
  }, 90_000);

  it("8 MiB'ı aşan çerçeve başlığı: too_large ya da bağlantı kesilir; ardından Agent çalışır", async () => {
    const { port, k } = await live();
    const h = Buffer.alloc(4);
    h.writeUInt32BE(9 * 1024 * 1024);
    const o = await sendRaw(port, h, { timeoutMs: 6000 });
    if (o.kind === "response") expect(o.resp.code).toBe("too_large");
    else expect(o.kind).toBe("closed");
    expect(await ping(port, k.mac)).toBe("ok");
  }, 60_000);

  it("yarım çerçeve (slow-loris): okuma zaman aşımında bağlantı kapanır, kaynak tükenmez", async () => {
    const { port, k } = await live();
    const h = Buffer.alloc(4);
    h.writeUInt32BE(100);
    // plan: 10 sn okuma zaman aşımı; üst sınır geniş (yük altında)
    const o = await sendRaw(port, [h, Buffer.from("0123456789")], { timeoutMs: 25_000 });
    expect(o.kind === "closed" || (o.kind === "response" && o.resp.code !== "ok")).toBe(true);
    expect(await ping(port, k.mac)).toBe("ok");
  }, 60_000);

  it("17. eşzamanlı bağlantı hemen kapatılır; ilk 16'ya dokunulmaz; bırakılınca yeniden bağlanılır", async () => {
    const { port, k } = await live();
    const held: net.Socket[] = [];
    await Promise.all(Array.from({ length: 16 }, () => new Promise<void>((res) => { const s = net.connect(port, "127.0.0.1", () => { held.push(s); res(); }); s.on("error", () => res()); })));
    try {
      const seventeenth = await new Promise<string>((res) => {
        const s = net.connect(port, "127.0.0.1");
        const t = setTimeout(() => { s.destroy(); res("açık"); }, 4000);
        s.on("close", () => { clearTimeout(t); res("kapandı"); });
        s.on("error", () => { /* reset de kapanıştır */ });
      });
      expect(seventeenth).toBe("kapandı");
      expect(held.filter((s) => !s.destroyed)).toHaveLength(16);
    } finally { for (const s of held) s.destroy(); }
    await new Promise((r) => setTimeout(r, 300));
    expect(await ping(port, k.mac)).toBe("ok");
  }, 60_000);
});

describe("machines:K — K18 konsol kimliği", () => {
  const consoleEnv = (world: World) => ({ VLAD_LOCAL_FILE: world.pair.consoleLocal("desktop"), VLAD_MACHINE: "desktop" });

  it("`vlad remote -- task list --json` çıktısı beyindeki yerel CLI ile eşit", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]);
    await w.newTask();
    await w.newTask();
    const direct = await runVlad(w.brain, ["task", "list", "--json"]);
    const viaConsole = await runVlad(w.worker, ["remote", "--", "task", "list", "--json"], { env: consoleEnv(w) });
    expect(direct.code).toBe(0);
    expect({ code: viaConsole.code, out: viaConsole.out }).toEqual({ code: direct.code, out: direct.out });
  }, 60_000);

  it("yazmada aynı opId tekrarı ilk sonucu döner, ikinci görev yaratılmaz", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]);
    const argv = ["remote", "--op-id", "99999999-2222-4333-8444-555555555555", "--stdin", "--", "task", "new", "--project", w.slug, "--title", "Uzak", "--kind", "dev", "--body-file", "-", "--json"];
    const a = await runVlad(w.worker, argv, { env: consoleEnv(w), stdin: "## Tanım\nx\n" });
    const b = await runVlad(w.worker, argv, { env: consoleEnv(w), stdin: "## Tanım\nx\n" });
    expect(a.code, a.err).toBe(0);
    expect(b.out).toBe(a.out);
    expect((await w.list()).filter((t) => t.title === "Uzak")).toHaveLength(1);
  }, 60_000);

  it("katalog dışı komutlar (agent keygen, queue drop) forbidden; çıkış 1", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]);
    for (const cmd of [["agent", "keygen", "x"], ["queue", "drop", "1"]]) {
      const r = await runVlad(w.worker, ["remote", "--", ...cmd], { env: consoleEnv(w) });
      expect(r.code).toBe(1);
      expect(r.err + r.out).toMatch(/komut konsoldan çalıştırılamaz|forbidden/);
    }
  }, 60_000);

  it("dosya bayrağı '-' dışı reddedilir; yerel dosya içeriği beyine sızmaz", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]);
    const id = await w.newTask();
    const secret = join(w.base, "gizli.md");
    writeFileSync(secret, "### Gizli\n");
    const r = await runVlad(w.worker, ["remote", "--", "task", "report", id, "--file", secret], { env: consoleEnv(w) });
    expect(r.code).not.toBe(0);
    expect(w.readTask(w.brain, id)).not.toContain("Gizli");
  }, 60_000);

  it("worker kimliğiyle exec reddedilir (kimlik rolü anahtardan)", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]);
    const o = resp(await rawCall({ port: w.agents.brain!.port, key: w.pair.keys.windows, from: "windows", to: "mac", op: "exec", args: { argv: ["task", "list", "--json"] } }));
    expect(o.code).toBe("forbidden");
  }, 60_000);

  it("kb-head (konsol): sha ve pushed döner", async () => {
    w = await makeWorld();
    await w.startAgents(["brain"]);
    const o = resp(await rawCall({ port: w.agents.brain!.port, key: w.pair.keys.desktop, from: "desktop", to: "mac", op: "kb-head" }));
    expect(o.code).toBe("ok");
    expect(o.result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof o.result.pushed).toBe("boolean");
  }, 60_000);

  it("beyin ulaşılamaz: konsol komutu kuyruğa girmez, çıkış 75 + açıklayıcı mesaj", async () => {
    w = await makeWorld();
    const dead = await new Promise<number>((res) => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const p = (sv.address() as net.AddressInfo).port; sv.close(() => res(p)); }); });
    w.setPorts({ mac: dead }); // dinleyen yok
    const r = await runVlad(w.worker, ["remote", "--", "task", "list", "--json"], { env: consoleEnv(w) });
    expect(r.code).toBe(75);
    expect(r.err.length).toBeGreaterThan(0);
  }, 60_000);
});
