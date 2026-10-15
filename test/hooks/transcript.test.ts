import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "../../src/hooks/transcript.js";

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

describe("parseTranscript", () => {
  it("basic: counts real user messages, skips tool_result/command/meta", () => {
    const r = parseTranscript(fx("transcript-basic.jsonl"));
    expect(r.userCount).toBe(3);
    expect(r.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(r.messages.map((m) => m.text)).toEqual([
      "Oda senkronizasyonunu başlatalım", "WebSocket kullanacağım.", "Tamam, devam et", "Bitti.", "Teşekkürler",
    ]);
  });
  it("broken line is skipped without throwing", () => {
    const r = parseTranscript(fx("transcript-broken.jsonl"));
    expect(r.userCount).toBe(2);
  });
});
