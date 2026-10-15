import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kbPaths, nowIso, readDoc, validate, type InboxRecord } from "../kb/index.js";
import { inferProject } from "./project.js";
import { parseTranscript } from "./transcript.js";

const MAX_EXCERPT = 6;
const MAX_TEXT = 1000;
const MAX_COMMITS = 20;

export interface ReportInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  reason?: string;
}

export interface ReportDeps {
  readFile: (p: string) => string;
  git: (cwd: string, args: string[]) => string | null;
  projects: { slug: string; path: string }[];
  vladHome: string;
  env: Record<string, string | undefined>;
  now: Date;
}

type Git = NonNullable<InboxRecord["git"]>;

function collectGit(cwd: string, deps: ReportDeps): Git {
  const run = (args: string[]) => {
    try {
      return deps.git(cwd, args);
    } catch {
      return null;
    }
  };
  const first = (s: string | null) => (s ? s.trim().split(/\r?\n/)[0] || null : null);
  const since = new Date(deps.now.getTime() - 24 * 3600 * 1000).toISOString();
  const log = run(["log", `--since=${since}`, `--max-count=${MAX_COMMITS}`, "--format=%h%x09%s%x09%aI"]);
  const recent_commits = (log ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, subject, date] = l.split("\t");
      return { sha, subject: subject ?? "", date: date ?? "" };
    })
    .filter((c) => c.sha && c.date)
    .slice(0, MAX_COMMITS);
  const status = run(["status", "--porcelain"]);
  const changed_files = (status ?? "")
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"));
  return {
    branch: first(run(["rev-parse", "--abbrev-ref", "HEAD"])),
    head: first(run(["rev-parse", "--short", "HEAD"])),
    recent_commits,
    changed_files,
  };
}

export function buildReport(input: ReportInput, deps: ReportDeps): InboxRecord | null {
  const { messages, userCount } = parseTranscript(deps.readFile(input.transcript_path));
  if (userCount < 2) return null;
  return {
    session_id: input.session_id,
    cwd: input.cwd,
    project: inferProject(input.cwd, deps.projects, deps.vladHome),
    task_id: deps.env.VLAD_TASK_ID ?? null,
    transcript_path: input.transcript_path,
    reason: input.reason ?? "unknown",
    ended: nowIso(deps.now),
    git: collectGit(input.cwd, deps),
    excerpt: messages.slice(-MAX_EXCERPT).map((m) => ({ role: m.role, text: m.text.slice(0, MAX_TEXT) })),
    user_message_count: userCount,
  };
}

function gitRunner(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function loadProjects(dir: string): { slug: string; path: string }[] {
  const out: { slug: string; path: string }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const { data } = readDoc<{ slug?: string; path?: string }>(join(dir, n));
      if (typeof data.slug === "string" && typeof data.path === "string") out.push({ slug: data.slug, path: data.path });
    } catch {
      /* skip */
    }
  }
  return out;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", reject);
  });
}

function logError(err: unknown): void {
  try {
    const p = kbPaths();
    mkdirSync(p.logs, { recursive: true });
    const iso = nowIso();
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(join(p.logs, `hook-${iso.slice(0, 10)}.log`), `${iso} ${msg.replace(/\r?\n/g, " | ")}\n`, "utf8");
  } catch {
    /* nothing left to do */
  }
}

/** SessionEnd hook entry. Never throws; always exit code 0. `stdinText` is for tests. */
export async function main(stdinText?: string): Promise<void> {
  try {
    const raw = stdinText ?? (await readStdin());
    const input = JSON.parse(raw) as ReportInput;
    if (!input || typeof input.session_id !== "string" || typeof input.transcript_path !== "string") {
      throw new Error("hook girdisi geçersiz: session_id/transcript_path eksik");
    }
    const p = kbPaths();
    const record = buildReport(
      { ...input, cwd: input.cwd ?? process.cwd() },
      {
        readFile: (f) => readFileSync(f, "utf8"),
        git: gitRunner,
        projects: loadProjects(p.projects),
        vladHome: p.home,
        env: process.env,
        now: new Date(),
      },
    );
    if (record) {
      validate("inbox", record);
      mkdirSync(p.inbox, { recursive: true });
      const ts = nowIso().slice(0, 19).replace(/[-:]/g, "");
      const safeId = record.session_id.replace(/[^A-Za-z0-9_-]/g, "_");
      writeFileSync(join(p.inbox, `${ts}-${safeId}.json`), JSON.stringify(record, null, 2), "utf8");
    }
  } catch (err) {
    logError(err);
  } finally {
    process.exitCode = 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
