import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../../src/agent/client.js";
import { Journal } from "../../src/agent/journal.js";
import { startServer } from "../../src/agent/server.js";
import { signRequest } from "../../src/agent/sign.js";
import { defaultConfig } from "../../src/kb/config.js";
import type { VladConfig } from "../../src/kb/types.js";
import { PROTO_VERSION } from "../../src/machines/types.js";
import { rmTemp } from "../helpers.js";

// D-vlad-057: anahtar çifte özgüdür. Ele geçirilmiş bir işçi, beyinle paylaştığı anahtarla başka bir işçiye
// beyin gibi davranan istek imzalayamaz.
const K1 = "a1".repeat(32); // mac↔w1
const K2 = "b2".repeat(32); // mac↔w2
const S1 = "c3".repeat(32), S2 = "d4".repeat(32); // işçilerin kendi anahtarları
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const cfg = (): VladConfig => ({
  ...defaultConfig(), brain: "mac",
  machines: [
    { name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 1 } },
    { name: "w1", os: "win32", agent: { host: "127.0.0.1", port: 1 } },
    { name: "w2", os: "win32", agent: { host: "127.0.0.1", port: 1 } },
  ],
});

async function worker(self: string, keys: Record<string, string>, c: VladConfig, idx: number) {
  const dir = mkdtempSync(join(tmpdir(), "vlad-pk-"));
  cleanups.push(() => rmTemp(dir));
  const journal = new Journal(join(dir, "j.jsonl"), () => Date.now());
  const srv = await startServer({ self, kind: "worker-agent", cfg: () => c, keys, ops: { ping: async () => ({ pong: self }) } as never, journal, build: "t", bind: "127.0.0.1", port: 0 });
  cleanups.push(() => srv.close());
  c.machines![idx]!.agent.port = srv.port;
}

describe("machines:C2 çift anahtar (D-vlad-057)", () => {
  async function world() {
    const c = cfg();
    await worker("w1", { w1: S1, mac: K1 }, c, 1);
    await worker("w2", { w2: S2, mac: K2 }, c, 2);
    return c;
  }

  it("beyin her işçiyle kendi çift anahtarıyla konuşur; yanıt da aynı anahtarla doğrulanır", async () => {
    const c = await world();
    const brain = new AgentClient({ self: "mac", keys: { mac: "e5".repeat(32), w1: K1, w2: K2 }, config: () => c });
    expect((await brain.call<{ pong: string }>("w1", "ping", {})).result.pong).toBe("w1");
    expect((await brain.call<{ pong: string }>("w2", "ping", {})).result.pong).toBe("w2");
  });

  it("ele geçirilmiş w1 (yalnız K1 ve kendi anahtarı) w2'ye beyin gibi görünemez: istemci ve ham imza auth ile reddedilir", async () => {
    const c = await world();
    // 1) w1'in istemcisi beyin adına w2'ye çağrı kurar: elindeki tek 'mac' anahtarı K1
    const evil = new AgentClient({ self: "w1", keys: { w1: S1, mac: K1 }, config: () => c });
    await expect(evil.call("w2", "ping", {}, { as: "mac" })).rejects.toMatchObject({ code: "auth" });
    // 2) w1'in kendi adıyla w2'ye çağrı: w2'de w1 için anahtar yok (anahtar çifte özgü)
    await expect(evil.call("w2", "ping", {})).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("çifti için anahtar yok") });
    // 3) ham imza: K1 ile from:mac to:w2 → w2 K2 ile doğrular
    const addr = c.machines![2]!.agent;
    const forged = signRequest(K1, { v: PROTO_VERSION, from: "mac", to: "w2", opId: "evil-1", ts: Date.now(), op: "ping", args: {} });
    const net = await import("node:net");
    const { encodeFrame, FrameDecoder } = await import("../../src/agent/frame.js");
    const reply = await new Promise<{ code: string }>((resolve, reject) => {
      const s = net.connect(addr.port, addr.host);
      const d = new FrameDecoder();
      s.on("connect", () => s.write(encodeFrame(forged)));
      s.on("data", (b: Buffer) => { const [r] = d.push(b); if (r) { s.destroy(); resolve(r as { code: string }); } });
      s.on("error", reject);
    });
    expect(reply.code).toBe("auth");
  });

  it("aynı K1 kendi çiftinde (mac→w1) geçerli: reddin nedeni anahtarın çifte özgülüğü, imza biçimi değil", async () => {
    const c = await world();
    const ok = new AgentClient({ self: "mac", keys: { w1: K1 }, config: () => c });
    expect((await ok.call<{ pong: string }>("w1", "ping", {})).result.pong).toBe("w1");
  });

  it("yanlış çiftin anahtarı (w2 için K1) auth; anahtarı olmayan taraf yerel hata verir (ağa çıkmadan)", async () => {
    const c = await world();
    const wrong = new AgentClient({ self: "mac", keys: { w1: K1, w2: K1 }, config: () => c });
    await expect(wrong.call("w2", "ping", {})).rejects.toMatchObject({ code: "auth" });
    const none = new AgentClient({ self: "mac", keys: {}, config: () => c });
    await expect(none.call("w2", "ping", {})).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("anahtar yok") });
  });
});
