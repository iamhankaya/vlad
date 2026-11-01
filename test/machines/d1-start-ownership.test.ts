import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad, startAgent, type RunningAgent } from "./harness.js";

// Son kapı P1-1: çalışan Agent varken ikinci `agent start` journal'a/kuyruğa dokunmadan çıkmalı.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe("agent start tekil sahiplik", () => {
  it("canlı Agent varken ikinci start journal dosyasını değiştirmez (started kayıt aborted/uncertain olmaz)", async () => {
    const cfg = (port: number) => ({
      machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 7437 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port }, } ],
      brain: "mac",
    });
    const p = makeHomePair({ config: cfg(7437) });
    cleanups.push(() => rmTemp(dirname(p.brain.home)), () => p.cleanup());
    let agent: RunningAgent | undefined;
    cleanups.push(async () => { await agent?.stop(); });
    agent = await startAgent(p.worker, { test: { VLAD_AGENT_FLUSH_MS: "86400000" } });
    writeFileSync(join(p.worker.home, "vlad.config.json"), JSON.stringify(cfg(agent.port)));

    const journal = join(p.worker.home, ".vlad-agent", "journal.jsonl");
    // canlı Agent'ın uçuştaki işlemi gibi: başka süreç bu satırı reconcile ederse dosya değişir
    appendFileSync(journal, JSON.stringify({ opId: "live-1", from: "mac", op: "launch", state: "started", ts: Date.now(), argsHash: "h" }) + "\n");
    const before = readFileSync(journal, "utf8");

    const second = spawnVlad(p.worker, ["agent", "start", "--port", String(agent.port)]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("zaten çalışıyor");
    expect(readFileSync(journal, "utf8")).toBe(before);
  }, 60_000);
});
