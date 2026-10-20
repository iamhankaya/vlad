import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, readDoc } from "../kb/index.js";
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

/** Text blocks of one `list_events` entry, whatever shape it comes in; only assistant events yield text. */
function assistantText(ev: any): string {
  const kind = ev?.kind ?? ev?.type ?? ev?.role ?? ev?.data?.type ?? ev?.data?.role;
  if (kind !== "assistant") return "";
  const content = ev?.message?.content ?? ev?.data?.message?.content ?? ev?.content ?? ev?.data?.content ?? ev?.text ?? ev?.data?.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b?.type === "text" || b?.text ? String(b.text ?? "") : "")).join("\n");
  }
  return "";
}

export function eventList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const o = json as Record<string, unknown> | null;
  for (const k of ["data", "events", "items"]) if (Array.isArray(o?.[k])) return o![k] as unknown[];
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

/**
 * Cloud transcript → kb. Processes the `[VLAD:LOG|ASK|REPORT|FAIL]` markers of assistant events in
 * order; a marker whose `[cloud #<seq>]` is already in the task file is skipped, so re-running is safe.
 * A REPORT whose `head=` does not match the remote `vlad/<id>` tip is not applied (warning).
 */
export function ingestEvents(
  id: string, events: unknown[], o: { remoteHead?: (repo: string, branch: string) => string | null; head?: string } = {},
): IngestResult {
  const res: IngestResult = { processed: [], skipped: [], warnings: [] };
  const markers = events.flatMap((ev) => parseMarkers(assistantText(ev), res.warnings));
  for (const m of markers) {
    const tag = `[cloud #${m.seq}]`;
    if (getTask(id).body.includes(tag)) { res.skipped.push(m.seq); continue; }
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
