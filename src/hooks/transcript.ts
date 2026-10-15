export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

const SKIP_PREFIXES = ["<command-", "<local-command-"];

interface Part {
  type?: string;
  text?: unknown;
}

function textParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as Part[])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
}

/** Parses a Claude Code transcript (JSONL); tolerant of broken lines and unknown entry types. */
export function parseTranscript(text: string): { messages: TranscriptMessage[]; userCount: number } {
  const messages: TranscriptMessage[] = [];
  let userCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const content = obj.message?.content;
    if (obj.type === "user") {
      if (obj.isMeta === true) continue;
      const t = (typeof content === "string" ? content : textParts(content).join("\n")).trim();
      if (!t) continue;
      if (SKIP_PREFIXES.some((p) => t.startsWith(p))) continue;
      messages.push({ role: "user", text: t });
      userCount++;
    } else if (obj.type === "assistant") {
      const t = textParts(content).join("\n").trim();
      if (!t) continue;
      messages.push({ role: "assistant", text: t });
    }
  }
  return { messages, userCount };
}
