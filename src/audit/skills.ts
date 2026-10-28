import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getVladHome, kbPaths, readDoc } from "../kb/index.js";
import type { ProjectCard } from "../kb/index.js";
import { getRole } from "../roles/store.js";
import { listTasks } from "../tasks/index.js";
import { claudeProjectDir } from "../tasks/liveness.js";

export { claudeProjectDir };

/** VLAD's own session uses these on a pipeline's final gate; a worker never needs them. */
const GATE_SKILLS = ["second-opinion", "integrate"];

const bare = (s: string) => s.slice(s.lastIndexOf(":") + 1);
const SKILL_MD = /([^/\\]+)[/\\]SKILL\.md$/i;

export interface TranscriptScan { loaded: Record<string, number>; pushed: boolean }

/** Counts `Skill` tool calls and `SKILL.md` reads (vendored skills are read, not loaded) by bare skill name; notes a `git push`. */
export function scanTranscript(jsonl: string): TranscriptScan {
  const loaded: Record<string, number> = {};
  let pushed = false;
  const count = (n: string) => { loaded[n] = (loaded[n] ?? 0) + 1; };
  for (const raw of jsonl.split(/\r?\n/)) {
    if (!raw.includes('"tool_use"')) continue;
    let obj: any;
    try { obj = JSON.parse(raw); } catch { continue; }
    const content = obj?.message?.content;
    if (obj?.type !== "assistant" || !Array.isArray(content)) continue;
    for (const p of content) {
      if (p?.type !== "tool_use") continue;
      if (p.name === "Skill" && typeof p.input?.skill === "string") count(bare(p.input.skill));
      else if (p.name === "Read" && typeof p.input?.file_path === "string") {
        const m = SKILL_MD.exec(p.input.file_path);
        if (m) count(m[1]);
      } else if (p.name === "Bash" && /\bgit\b.*\bpush\b/.test(String(p.input?.command ?? ""))) pushed = true;
    }
  }
  return { loaded, pushed };
}

function scanDir(dir: string, sinceMs = 0): TranscriptScan | null {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)); } catch { return null; }
  files = files.filter((f) => statSync(f).mtimeMs >= sinceMs);
  if (!files.length) return null;
  const all: TranscriptScan = { loaded: {}, pushed: false };
  for (const f of files) {
    const s = scanTranscript(readFileSync(f, "utf8"));
    for (const [k, v] of Object.entries(s.loaded)) all.loaded[k] = (all.loaded[k] ?? 0) + v;
    all.pushed ||= s.pushed;
  }
  return all;
}

/** Skills the project card names for its workers (empty when the card or field is missing). */
function cardSkills(project: string): string[] {
  const file = join(kbPaths().projects, `${project}.md`);
  try { return existsSync(file) ? (readDoc<ProjectCard>(file).data.skills ?? []).map(bare) : []; } catch { return []; }
}

export interface TaskAudit {
  id: string; project: string; role: string | null; transcript: boolean;
  expected: string[]; loaded: string[]; missing: string[];
}
export interface SkillAudit {
  tasks: TaskAudit[];
  vlad: { loaded: Record<string, number>; expected: string[]; missing: string[] };
  summary: { tasks: number; audited: number; expected: number; loaded: number; rate: number | null };
}

/**
 * Matches each started task to its worker transcripts (`<claude config>/projects/<worktree slug>/*.jsonl`) and compares
 * the skills it loaded with the ones it should have: vlad-worker, its role's skills, ci-triage after a push by an
 * `autonomy: pr` worker. The VLAD session itself is checked for the final-gate skills once a pipeline closed.
 */
export function auditSkills(o: { configDir?: string; since?: string; project?: string } = {}): SkillAudit {
  const configDir = o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const sinceMs = o.since ? Date.parse(o.since) : 0;
  if (o.since && Number.isNaN(sinceMs)) throw new Error(`geçersiz --since: ${o.since}`);
  const dirOf = (path: string) => join(configDir, "projects", claudeProjectDir(path));
  const all = listTasks().filter((t) => Date.parse(t.data.created) >= sinceMs && (!o.project || t.data.project === o.project));

  const tasks: TaskAudit[] = [];
  for (const t of all) {
    const wt = t.data.worktree;
    if (t.data.kind === "pipeline" || !wt) continue;
    const scan = scanDir(dirOf(wt));
    const base = { id: t.data.id, project: t.data.project, role: t.data.role ?? null };
    if (!scan) { tasks.push({ ...base, transcript: false, expected: [], loaded: [], missing: [] }); continue; }
    let roleSkills: string[] = [];
    try { roleSkills = t.data.role ? getRole(t.data.role).skills : []; } catch { /* role file gone: only the base protocol is checked */ }
    const expected = [...new Set(["vlad-worker", ...roleSkills.map(bare), ...cardSkills(t.data.project), ...(t.data.autonomy === "pr" && scan.pushed ? ["ci-triage"] : [])])];
    const loaded = expected.filter((s) => scan.loaded[s]);
    tasks.push({ ...base, transcript: true, expected, loaded, missing: expected.filter((s) => !scan.loaded[s]) });
  }

  const vladScan = scanDir(dirOf(getVladHome()), sinceMs);
  const closedPipeline = listTasks({ state: ["done"] }).some((t) => t.data.kind === "pipeline" && Date.parse(t.data.updated) >= sinceMs);
  const vladLoaded = vladScan?.loaded ?? {};
  const vladExpected = closedPipeline ? GATE_SKILLS : [];

  const audited = tasks.filter((t) => t.transcript);
  const expected = audited.reduce((n, t) => n + t.expected.length, 0);
  const loaded = audited.reduce((n, t) => n + t.loaded.length, 0);
  return {
    tasks,
    vlad: { loaded: vladLoaded, expected: vladExpected, missing: vladExpected.filter((s) => !vladLoaded[s]) },
    summary: { tasks: tasks.length, audited: audited.length, expected, loaded, rate: expected ? loaded / expected : null },
  };
}
