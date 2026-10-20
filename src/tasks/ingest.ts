import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSection, kbPaths, readDoc } from "../kb/index.js";
import type { ProjectCard } from "../kb/index.js";
import { askTask, getTask, logTask, reportTask, setState } from "./store.js";

export type Marker =
  | { kind: "LOG" | "ASK" | "FAIL"; seq: number; text: string }
  | { kind: "REPORT"; seq: number; branch: string | null; head: string | null; text: string };

export interface IngestResult {
  processed: { seq: number; kind: string }[];
  skipped: number[];
  warnings: string[];
}

const MARK = /^\[VLAD:(LOG|ASK|REPORT|END|FAIL)\s+#(\d+)([^\]]*)\]\s*(.*)$/;
const FENCE = /^\s*(```|~~~)/;

const blocksText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : b?.type === "text" || b?.text ? String(b.text ?? "") : "")).join("\n");
};

/** Real `list_events` entries name their kind by key: `{assistant: {internal_anthropic_catchall: {message}}}`. */
const catchall = (ev: any, key: string): any => ev?.[key]?.internal_anthropic_catchall ?? ev?.[key];

/**
 * Text of one `list_events` entry, whatever shape it comes in. `kind` is "assistant" for assistant
 * output (real keyed shape or the older kind/type/role shapes), "result" for a turn-end result event.
 */
function eventText(ev: any): { kind: "assistant" | "result" | null; text: string } {
  if (ev?.assistant && typeof ev.assistant === "object") {
    const c = catchall(ev, "assistant");
    return { kind: "assistant", text: blocksText(c?.message?.content ?? c?.content) };
  }
  if (ev?.result && typeof ev.result === "object") {
    const r = catchall(ev, "result")?.result;
    return { kind: "result", text: typeof r === "string" ? r : "" };
  }
  const kind = ev?.kind ?? ev?.type ?? ev?.role ?? ev?.data?.type ?? ev?.data?.role;
  if (kind !== "assistant") return { kind: null, text: "" };
  const content = ev?.message?.content ?? ev?.data?.message?.content ?? ev?.content ?? ev?.data?.content ?? ev?.text ?? ev?.data?.text;
  return { kind: "assistant", text: blocksText(content) };
}

/** End index (exclusive) of the balanced JSON object/array starting at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Every JSON object/array embedded in free text, in order; stray `[ok]` / `{call}` in the envelope are skipped. */
function embeddedJson(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    try {
      out.push(JSON.parse(text.slice(i, end)));
      i = end - 1;
    } catch { /* not JSON: keep scanning from the next character */ }
  }
  return out;
}

/** JSON (array/wrapper) or JSONL text, possibly with a text envelope around it; several JSON values (pages) come back as an array. */
export function parseEvents(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length >= 2) {
      try { return lines.map((l) => JSON.parse(l)); } catch { /* try the envelope scan below */ }
    }
    const found = embeddedJson(text);
    if (found.length === 1) return found[0];
    if (found.length > 1) return found;
    throw e;
  }
}

const isPage = (x: any): boolean => !!x && typeof x === "object" && !Array.isArray(x) && !!x.ccr && typeof x.ccr === "object";

/** Warning when the last `{ccr:{has_more}}` page says more events exist than were given. */
export function pageWarnings(json: unknown): string[] {
  const pages = (Array.isArray(json) ? json : [json]).filter(isPage);
  const last = pages[pages.length - 1] as any;
  return last?.ccr?.has_more === true
    ? ["has_more: true — sayfa eksik olabilir; sonraki sayfaları (after_id/before_id) da getirip birlikte ver"]
    : [];
}

export function eventList(json: unknown): unknown[] {
  if (Array.isArray(json)) {
    // consecutive `{ccr:{data,has_more}}` pages: concatenate their events
    if (json.length && json.every(isPage)) return json.flatMap((p) => eventList(p));
    return json;
  }
  let o = json as Record<string, any> | null;
  if (o && typeof o === "object" && o.ccr && typeof o.ccr === "object") o = o.ccr; // list_events wrapper
  for (const k of ["data", "events", "items"]) if (Array.isArray(o?.[k])) return o![k] as unknown[];
  if (o && typeof o === "object" && ["type", "role", "kind", "assistant", "result", "user"].some((k) => k in o!)) return [o]; // single JSONL line
  throw new Error("olay listesi bulunamadı (dizi veya {data|events|items: [...]} bekleniyor)");
}

/** Extracts `[VLAD:*]` markers from text: line-start only, outside code fences. */
export function parseMarkers(text: string, warnings: string[] = []): Marker[] {
  const out: Marker[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = MARK.exec(lines[i]);
    if (!m) continue;
    const [, kind, n, attrs, rest] = m;
    const seq = Number(n);
    if (kind === "END") continue;
    if (kind !== "REPORT") {
      out.push({ kind: kind as "LOG" | "ASK" | "FAIL", seq, text: rest.trim() });
      continue;
    }
    const attr = (k: string) => new RegExp(`\\b${k}=(\\S+)`).exec(attrs)?.[1] ?? null;
    const body: string[] = [rest];
    let closed = false;
    let inFence = false;
    for (i++; i < lines.length; i++) {
      if (FENCE.test(lines[i])) inFence = !inFence;
      else if (!inFence && new RegExp(`^\\[VLAD:END\\s+#${seq}\\]`).test(lines[i])) { closed = true; break; }
      body.push(lines[i]);
    }
    if (!closed) { warnings.push(`REPORT #${seq} kapanmamış ([VLAD:END #${seq}] yok); atlandı`); continue; }
    out.push({ kind: "REPORT", seq, branch: attr("branch"), head: attr("head"), text: body.join("\n").trim() });
  }
  return out;
}

const sameSha = (a: string, b: string) => {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/** Head of `vlad/<id>` on the project's GitHub repo; null when it cannot be determined. */
export function lsRemoteHead(repo: string, branch: string): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", `https://github.com/${repo}.git`, `refs/heads/${branch}`], {
      encoding: "utf8", stdio: "pipe", timeout: 20000,
    });
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

function projectRepo(slug: string): string | null {
  const file = join(kbPaths().projects, `${slug}.md`);
  return existsSync(file) ? readDoc<ProjectCard>(file).data.repo ?? null : null;
}

/** Tags are only looked up where ingest writes them (İlerleme, and Sorular for ASK); a report body may quote `[cloud #n]`. */
const seen = (id: string, tag: string): boolean => {
  const body = getTask(id).body;
  return ["## İlerleme", "## Sorular"].some((h) => getSection(body, h)?.includes(tag));
};

/**
 * Cloud transcript → kb. Processes the `[VLAD:LOG|ASK|REPORT|FAIL]` markers of assistant events in
 * order; a marker whose `[cloud #<seq>]` is already in the task file is skipped, so re-running is safe.
 * A REPORT whose `head=` does not match the remote `vlad/<id>` tip is not applied (warning).
 */
export function ingestEvents(
  id: string, events: unknown[], o: { warnings?: string[]; remoteHead?: (repo: string, branch: string) => string | null; head?: string } = {},
): IngestResult {
  const res: IngestResult = { processed: [], skipped: [], warnings: [...(o.warnings ?? [])] };
  const texts = events.map(eventText);
  const assistants = texts.filter((t) => t.kind === "assistant");
  if (!assistants.length) res.warnings.push("assistant olayı bulunamadı; işaret işlenmedi (olay şekli beklenenden farklı olabilir)");
  // result events repeat the last turn's text: only a fallback when no assistant event was recognized
  const used = assistants.length ? assistants : texts.filter((t) => t.kind === "result");
  const markers = used.flatMap((t) => parseMarkers(t.text, res.warnings));
  for (const m of markers) {
    const tag = `[cloud #${m.seq}]`;
    if (seen(id, tag)) { res.skipped.push(m.seq); continue; }
    try {
      if (m.kind === "LOG") logTask(id, `${tag} ${m.text}`);
      else if (m.kind === "ASK") askTask(id, `${tag} ${m.text}`);
      else if (m.kind === "FAIL") {
        logTask(id, `${tag} FAIL: ${m.text}`);
        setState(id, "failed", { error: m.text });
      } else if (m.kind === "REPORT") {
        const branch = `vlad/${id}`;
        if (m.branch && m.branch !== branch) throw new Error(`REPORT #${m.seq} branch=${m.branch}, beklenen ${branch}; uygulanmadı`);
        if (!m.head) throw new Error(`REPORT #${m.seq} head= içermiyor; uygulanmadı`);
        const repo = projectRepo(getTask(id).data.project);
        const remote = o.head ?? (repo ? (o.remoteHead ?? lsRemoteHead)(repo, branch) : null);
        if (!remote) throw new Error(`REPORT #${m.seq}: remote ${branch} ucu okunamadı (--remote-head ile ver); awaiting_approval yapılmadı`);
        if (!sameSha(remote, m.head)) {
          throw new Error(`REPORT #${m.seq}: head=${m.head} remote ${branch} ucuyla (${remote}) eşleşmiyor; awaiting_approval yapılmadı`);
        }
        reportTask(id, m.text);
        logTask(id, `${tag} kapanış raporu işlendi (head=${m.head})`);
      }
      res.processed.push({ seq: m.seq, kind: m.kind });
    } catch (e) {
      res.warnings.push(`#${m.seq} ${m.kind}: ${(e as Error).message}`);
    }
  }
  return res;
}
