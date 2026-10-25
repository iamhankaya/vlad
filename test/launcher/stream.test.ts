import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_LINE_BYTES, StreamTap, parseStreamLine } from "../../src/launcher/stream.js";
import type { TapEvent } from "../../src/launcher/stream.js";

const fx = (name: string): string[] =>
  readFileSync(resolve(import.meta.dirname, "..", "..", "contract", "fixtures", "external", "claude-stream-json", name), "utf8")
    .split("\n").filter(Boolean);
const tapAll = (lines: string[]): TapEvent[] => {
  const t = new StreamTap();
  return t.push(lines.join("\n") + "\n").events;
};
const SID = "00000000-0000-4000-8000-000000000005";

describe("launcher: stream tap", () => {
  it("launcher: tap extracts session_id and last step (real fixture)", () => {
    const evs = tapAll(fx("ask-turn.jsonl"));
    expect(evs).toContainEqual({ kind: "session", sessionId: SID });
    const steps = evs.filter((e) => e.kind === "step");
    expect(steps.at(-1)).toEqual({ kind: "step", label: "[VLAD:ASK #1] Hangi dil: A mı B mi?" });
    expect(evs.some((e) => e.kind === "limit")).toBe(false); // real rate_limit_event is status=allowed
  });
  it("launcher: tap labels tool use with the tool and its argument", () => {
    const steps = tapAll(fx("answer-turn-allowlist.jsonl")).filter((e) => e.kind === "step") as { label: string }[];
    expect(steps.some((s) => s.label.startsWith("Bash: "))).toBe(true);
    expect(steps.every((s) => s.label.length <= 160 && !s.label.includes("\n"))).toBe(true);
  });
  it("launcher: tap ignores unknown and partial lines", () => {
    const t = new StreamTap();
    const r = t.push(`not json\n{"type":"weird","x":1}\n[1,2]\n\n{"type":"assistant","message":{"content":[{"type":"te`);
    expect(r.events).toEqual([]);
    expect(r.lines).toHaveLength(3); // complete lines are logged as they came; the partial one waits
    // the partial line completes in the next chunk
    const r2 = t.push(`xt","text":"merhaba"}]}}\n`);
    expect(r2.events).toEqual([{ kind: "step", label: "merhaba" }]);
    // a session id that could become an argv flag is not accepted
    expect(parseStreamLine(JSON.stringify({ type: "result", session_id: "-rf; x" }))).toEqual([]);
  });
  it("launcher: tap drops over 1MB line", () => {
    const t = new StreamTap();
    const big = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(MAX_LINE_BYTES + 10) }] } });
    const good = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "sonra" }] } });
    // the oversized line arrives in pieces, then a normal line follows
    const ev: TapEvent[] = [];
    for (let i = 0; i < big.length; i += 300_000) ev.push(...t.push(big.slice(i, i + 300_000)).events);
    ev.push(...t.push("\n" + good + "\n").events);
    expect(ev).toEqual([{ kind: "step", label: "sonra" }]);
  });
  it("launcher: utf8 split across chunks", () => {
    const t = new StreamTap();
    const line = Buffer.from(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "çalışıyorum 🚀" }] } }) + "\n");
    const ev: TapEvent[] = [];
    for (let i = 0; i < line.length; i++) ev.push(...t.push(line.subarray(i, i + 1)).events); // byte by byte
    expect(ev).toEqual([{ kind: "step", label: "çalışıyorum 🚀" }]);
  });
  it("launcher: limit event parsed (SYNTHETIC fixture, no real limit event captured)", () => {
    const evs = tapAll(fx("limit-event.synthetic.jsonl").slice(1)); // line 0 is the fixture header
    const limits = evs.filter((e) => e.kind === "limit");
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({ until: new Date(1792899000 * 1000).toISOString() });
    expect(limits[1]).toMatchObject({ until: new Date(1792899000 * 1000).toISOString() });
  });
  it("launcher: unknown rate limit status does not invent a limit", () => {
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1792899000 } });
    expect(parseStreamLine(line)).toEqual([]);
  });
});
