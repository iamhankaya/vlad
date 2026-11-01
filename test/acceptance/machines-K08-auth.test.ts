// K8 yetki + K9 enjeksiyon — ham protokol istemcisi ile (uygulamanın client.ts/sign.ts'ine bakmadan, plan metninden).
// Her olumsuz durumda: beklenen `code` ve görev dosyası DEĞİŞMEDİ. Alt süreç argv'si kaydedici sahte CLI ile (VLAD_AGENT_CLI) ölçülür.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECORD_CLI } from "../machines/harness.js";
import { makeWorld, type World } from "./machines-world.js";
import { rawCall, signResp } from "./machines-raw.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });

const setup = async (test?: Record<string, string>) => {
  w = await makeWorld();
  await w.startAgents(["brain"], test);
  const id = await w.newTask();
  w.setFront(id, { state: "running", machine: "windows" });
  return { w, id, port: w.agents.brain!.port, k: w.pair.keys };
};
const write = (id: string, extra: object = {}) => ({ cmd: "task.log", id, text: "ZZ-yazma", ...extra });
const resp = (o: Awaited<ReturnType<typeof rawCall>>) => { expect(o.kind).toBe("response"); return (o as any).resp; };

describe("machines:K — K8 kimlik ve yetki", () => {
  it("geçerli istek: ok + yanıt imzası doğrulanır + görev satırı yazılır", async () => {
    const { w, id, port, k } = await setup();
    const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id) }));
    expect(r.code).toBe("ok");
    expect(r.sig).toBe(signResp(k.windows, r));
    expect(w.readTask(w.brain, id)).toContain("ZZ-yazma");
  }, 60_000);

  const unchanged = async (id: string, w: World, before: string) => expect(w.readTask(w.brain, id)).toBe(before);

  it("yanlış anahtar → auth", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    const r = resp(await rawCall({ port, key: k.mac, from: "windows", to: "mac", op: "apply-write", args: write(id) }));
    expect(r.code).toBe("auth");
    await unchanged(id, w, before);
  }, 60_000);

  it("imzadan sonra değiştirilmiş args → auth", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), mutate: (q) => { (q.args as any).text = "DEĞİŞTİ"; } }));
    expect(r.code).toBe("auth");
    await unchanged(id, w, before);
  }, 60_000);

  it("başka bir kimliğin adına (from değiştirilmiş) → auth; kimlik gövdeden değil anahtardan gelir", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), mutate: (q) => { q.from = "desktop"; } }));
    expect(r.code).toBe("auth");
    const r2 = resp(await rawCall({ port, key: k.windows, from: "bilinmeyen", to: "mac", op: "ping" }));
    expect(r2.code).toBe("auth");
    await unchanged(id, w, before);
  }, 60_000);

  it("süresi geçmiş / gelecekteki ts → clock_skew, mesajda iki saat", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    for (const ts of [Date.now() - 10 * 60_000, Date.now() + 10 * 60_000]) {
      const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), ts }));
      expect(r.code).toBe("clock_skew");
      expect(r.error).toMatch(/saat farkı çok büyük \(sunucu .+, istemci .+\)/);
    }
    await unchanged(id, w, before);
  }, 60_000);

  it("yansıtılmış istek: başka uca (to=windows) imzalı istek brain Agent'ında geçmez; brain kimliğiyle gelen istek reddedilir", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    // mac → windows için imzalanmış geçerli bir istek brain'e yansıtılıyor
    const a = resp(await rawCall({ port, key: k.mac, from: "mac", to: "windows", op: "ping" }));
    expect(["auth", "forbidden"]).toContain(a.code);
    // brain kendi Agent'ına istek atamaz (kendi yansıması)
    const b = resp(await rawCall({ port, key: k.mac, from: "mac", to: "mac", op: "apply-write", args: write(id) }));
    expect(["auth", "forbidden"]).toContain(b.code);
    await unchanged(id, w, before);
  }, 60_000);

  it("başka makinenin görevi → forbidden (görev başka makineye ait)", async () => {
    const { w, id, port, k } = await setup();
    w.setFront(id, { machine: "mac" });
    const before = w.readTask(w.brain, id);
    const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id) }));
    expect(r.code).toBe("forbidden");
    expect(r.error).toContain("görev başka makineye ait");
    await unchanged(id, w, before);
  }, 60_000);

  it("worker kimliği: task.set / finding.add / task.answer apply-write ile yapılamaz; exec / kb-head yasak", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    for (const cmd of ["task.set", "task.answer", "finding.add", "task.new", "decision.add"]) {
      const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: { cmd, id, text: "done" } }));
      expect(["bad_request", "forbidden"], cmd).toContain(r.code);
    }
    for (const op of ["exec", "kb-head", "launch", "cleanup"]) {
      const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op, args: { argv: ["task", "list"] } }));
      expect(r.code, op).toBe("forbidden");
    }
    expect(front(w.readTask(w.brain, id), "state")).toBe("running");
    await unchanged(id, w, before);
  }, 60_000);

  it("konsol kimliği apply-write yapamaz; işçi tarafı gövde alanlarına güvenilmez", async () => {
    const { w, id, port, k } = await setup();
    const before = w.readTask(w.brain, id);
    const r = resp(await rawCall({ port, key: k.desktop, from: "desktop", to: "mac", op: "apply-write", args: write(id) }));
    expect(r.code).toBe("forbidden");
    await unchanged(id, w, before);
  }, 60_000);

  it("aynı (from, opId) tekrarı: yeni ts ile bile ikinci kez uygulanmaz, ilk sonuç döner", async () => {
    const { w, id, port, k } = await setup();
    const opId = "11111111-2222-4333-8444-555555555555";
    const a = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), opId }));
    const b = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), opId, ts: Date.now() + 5 }));
    expect(a.code).toBe("ok");
    expect(b.code).toBe("ok");
    expect(b.result).toEqual(a.result);
    expect(w.readTask(w.brain, id).split("ZZ-yazma").length - 1).toBe(1);
  }, 60_000);

  it("Agent yeniden başlasa da günlük kalıcı: aynı opId yine bir kez", async () => {
    const { w, id, k } = await setup();
    const opId = "aaaaaaaa-2222-4333-8444-555555555555";
    await rawCall({ port: w.agents.brain!.port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), opId });
    await w.stopAgent("brain");
    await w.startAgents(["brain"]);
    const b = resp(await rawCall({ port: w.agents.brain!.port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: write(id), opId }));
    expect(b.code).toBe("ok");
    expect(w.readTask(w.brain, id).split("ZZ-yazma").length - 1).toBe(1);
  }, 60_000);
});

function front(t: string, key: string) { return new RegExp(`^${key}:\\s*(.*)$`, "m").exec(t)?.[1]?.trim(); }

describe("machines:K — K9 enjeksiyon (argv birebir veri; kabuk yok)", () => {
  const setupRec = async () => {
    const world = await makeWorld();
    const rec = join(world.base, "argv.jsonl");
    w = world;
    await world.startAgents(["brain"], { VLAD_AGENT_CLI: RECORD_CLI, VLAD_RECORD_FILE: rec });
    const id = await world.newTask();
    world.setFront(id, { state: "running", machine: "windows" });
    const lines = () => (existsSync(rec) ? readFileSync(rec, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { w: world, id, rec, lines, port: world.agents.brain!.port, k: world.pair.keys };
  };

  const hostile = [
    "x; rm -rf / # pwn-1",
    "$(touch pwn-2)",
    "`touch pwn-3`",
    "--",
    "--json --file=/etc/passwd",
    "satır\nsonu\r\nvar",
    "‐‐file=ünicode benzeri ＂ ；",
    // Windows CreateProcess komut satırı sınırı (~32 K karakter): 70 KiB argv orada ENAMETOOLONG verir (B raporu açık noktası: uzun metin argv ile taşınamaz). Niyet (büyük tek argüman aynen geçer) 24 KiB ile korunur.
    "a".repeat(process.platform === "win32" ? 24 * 1024 : 70 * 1024),
    "|| calc.exe & whoami",
  ];
  it("apply-write: düşmanca metinler tek argüman olarak aynen geçer, ek argüman/enjeksiyon yok", async () => {
    const { w, id, lines, port, k } = await setupRec();
    for (const text of hostile) {
      const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: { cmd: "task.log", id, text } }));
      expect(r.code, text.slice(0, 20)).toBe("ok");
    }
    const got = lines();
    expect(got).toHaveLength(hostile.length);
    got.forEach((rec: any, i) => {
      // B güvenlik turu (src/agent/ops/apply-write.ts writeArgv): `-` ile başlayan metinde seçenek sonu `--` id'den ÖNCE gelir: task log [--json] [--] <id> <metin>.
      let k = 2;
      if (rec.argv[k] === "--json") k++;
      if (hostile[i].startsWith("-")) { expect(rec.argv[k]).toBe("--"); k++; }
      expect(rec.argv.slice(0, 2)).toEqual(["task", "log"]);
      expect(rec.argv.slice(k)).toEqual([id, hostile[i]]); // tek öğe, birebir, ek argüman yok
      expect(rec.argv.slice(k).filter((a: string) => a === hostile[i])).toHaveLength(1); // `--` seçenek sonu ayracı metin "--" ise ayrı sayılır
      expect(rec.env.VLAD_FORWARDED).toBe("windows");
      expect(rec.env.VLAD_OP_ID).toBeTruthy();
    });
    for (const n of ["pwn-1", "pwn-2", "pwn-3"]) expect(existsSync(join(w.base, n)) || existsSync(join(process.cwd(), n))).toBe(false);
  }, 90_000);

  it("report metni argv'de değil stdin'de, birebir", async () => {
    const { id, lines, port, k } = await setupRec();
    const text = "### Yapılanlar\n- `x` $(y) ; z\r\n";
    const r = resp(await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args: { cmd: "task.report", id, text } }));
    expect(r.code).toBe("ok");
    const rec: any = lines()[0];
    expect(rec.stdin).toBe(text);
    expect(rec.argv).not.toContain(text);
    expect(rec.argv.join(" ")).not.toContain("$(y)");
  }, 60_000);

  it("\\0, sonunda \\n olan id, aşırı büyük metin, bozuk id → reddedilir, alt süreç hiç çalışmaz", async () => {
    const { id, lines, port, k } = await setupRec();
    const bad: object[] = [
      { cmd: "task.log", id, text: "a\u0000b" },
      { cmd: "task.log", id: id + "\n", text: "x" },
      { cmd: "task.log", id: id + " --json", text: "x" },
      { cmd: "task.log", id: "../" + id, text: "x" },
      { cmd: "task.log", id, text: "x".repeat(1024 * 1024 + 1) },
      { cmd: "task.log", id: ["a"], text: "x" },
      { cmd: "task.log; rm", id, text: "x" },
    ];
    for (const args of bad) {
      const o = await rawCall({ port, key: k.windows, from: "windows", to: "mac", op: "apply-write", args });
      if (o.kind === "response") expect(["bad_request", "too_large", "forbidden"], JSON.stringify(args).slice(0, 40)).toContain(o.resp.code);
      else expect(o.kind).toBe("closed");
    }
    expect(lines()).toHaveLength(0);
  }, 90_000);

  it("konsol exec: katalog içi komut argv aynen; dosya bayrağı yalnız '-' (içerik stdin); katalog dışı forbidden", async () => {
    const { id, lines, port, k } = await setupRec();
    const call = async (args: object) => resp(await rawCall({ port, key: k.desktop, from: "desktop", to: "mac", op: "exec", args }));
    const title = "a; rm -rf x $(id)";
    const okR = await call({ argv: ["task", "new", "--project", "alpha", "--title", title, "--kind", "dev", "--body-file", "-"], stdin: "## Tanım\ngövde\n" });
    expect(okR.code, JSON.stringify(okR)).toBe("ok");
    const rec: any = lines()[0];
    expect(rec.argv).toEqual(["task", "new", "--project", "alpha", "--title", title, "--kind", "dev", "--body-file", "-"]);
    expect(rec.stdin).toBe("## Tanım\ngövde\n");
    expect(rec.env.VLAD_FORWARDED).toBe("console:desktop");
    const n = lines().length;
    const denied: object[] = [
      { argv: ["task", "report", id, "--file", "/etc/passwd"] },
      { argv: ["task", "report", id, "--file=/etc/passwd"] },
      { argv: ["task", "new", "--project", "alpha", "--title", "t", "--body-file", "C:\\Windows\\win.ini"] },
      { argv: ["agent", "keygen", "x"] },
      { argv: ["queue", "drop", "1"] },
      { argv: ["machine", "probe-window", "windows"] },
      { argv: ["remote", "--", "task", "list"] },
      { argv: ["install"] },
      { argv: ["task", "olmayan-komut"] },
      { argv: [] },
    ];
    for (const a of denied) {
      const r = await call(a);
      expect(["forbidden", "bad_request"], JSON.stringify(a)).toContain(r.code);
    }
    expect(lines()).toHaveLength(n);
    // sınırlar
    for (const a of [{ argv: ["task", "log", id, "x".repeat(65 * 1024)] }, { argv: ["task", "log", id, "a\u0000b"] }]) {
      const r = await call(a);
      expect(r.code).not.toBe("ok");
    }
    expect(lines()).toHaveLength(n);
  }, 90_000);
});
