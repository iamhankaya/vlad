import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { kbPaths, nowIso } from "../kb/index.js";
import { getTask, logTask } from "./store.js";

export interface Denial { tool: string; pattern: string; reason?: string }

/** One line, single spaces: a multi-line value must not forge extra İlerleme entries, and spacing must not split one pattern in two. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
// " — " separates pattern and reason; one inside the pattern is written as " \— " (the parser splits on the first real separator and unescapes)
const SEP = " — ", ESCAPED_SEP = " \\— ";
const DENY_LINE = /^- \S+ \[İZİN\] ([^:\n]+): (.+?)(?: — (.+))?$/;

/** The İlerleme text (without timestamp) `task deny` writes; the setup audit reads it back with parseDenyLine. */
export function formatDenyLine(d: Denial): string {
  const tool = oneLine(d.tool), pattern = oneLine(d.pattern), reason = oneLine(d.reason ?? "");
  if (!tool) throw new Error("--tool zorunlu (Bash, PowerShell, ...)");
  if (!pattern) throw new Error("--pattern zorunlu (reddedilen komut)");
  return `[İZİN] ${tool}: ${pattern.replaceAll(SEP, ESCAPED_SEP)}${reason ? ` — ${reason}` : ""}`;
}

/** Parses a timestamped İlerleme line written by formatDenyLine; null for anything else. Pattern is whitespace-normalized. */
export function parseDenyLine(line: string): Denial | null {
  const m = DENY_LINE.exec(line);
  if (!m) return null;
  return { tool: m[1].trim(), pattern: oneLine(m[2].replaceAll(ESCAPED_SEP, SEP)), ...(m[3] ? { reason: m[3].trim() } : {}) };
}

const SECRET_PATH = /(?:^|[\s/='"])\.(?:env\b|vlad-secret|ssh\b|aws\b|npmrc)|id_(?:rsa|ed25519)|\.pem\b|credentials(?:\.json)?\b/;
const SUBCOMMAND_TOOLS = new Set(["git", "gh", "npm", "docker", "vlad"]);

/**
 * One class label for a denied command (setup audit groups `permission_candidates` by tool + class instead of full text):
 * file writes through the shell (heredoc, `python -c`, `sed -i`, `tee`), secret paths, else the first command word
 * (two words for git/gh/npm/docker/vlad: `git push`). Chained commands (`cd x && git push`) classify by the first
 * recognized class, falling back to the last command's word.
 */
export function classifyDenial(_tool: string, pattern: string): string {
  const p = pattern;
  if (/<<-?\s*['"]?\w+/.test(p) || /\bcat\s*>>?\s*\S/.test(p)) return "heredoc yazımı";
  if (/\bpython3?\s+-c\b/.test(p)) return "python -c";
  if (/\bsed\s+(?:-\w*\s+)*-i/.test(p)) return "sed -i";
  if (/\|\s*tee\b|(?:^|[;&]\s*)tee\s/.test(p)) return "tee yazımı";
  if (SECRET_PATH.test(p)) return "gizli dosya yolu";
  const segs = oneLine(p).split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const words = (seg: string) => seg.split(" ").filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const first = (seg: string): string => {
    const w = words(seg);
    const cmd = (w[0] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    if (SUBCOMMAND_TOOLS.has(cmd)) {
      const sub = w.slice(1).find((x) => !x.startsWith("-"));
      return sub ? `${cmd} ${sub}` : cmd;
    }
    return cmd;
  };
  const named = segs.map(first).filter(Boolean);
  const hit = named.find((c) => c === "git push" || c === "rm" || c === "git merge" || c === "pkill");
  return hit ?? named[named.length - 1] ?? "-";
}

const DENY_WORDS =/[İiIı]zin reddi|reddetti|denied/i;
/** Stderr hint for `task log` text that reads like a permission denial but was not recorded with `task deny` (audit setup only counts `[İZİN]` lines); null otherwise. */
export function denyLogHint(msg: string): string | null {
  if (msg.startsWith("[İZİN]") || !DENY_WORDS.test(msg)) return null;
  return "uyarı: izin reddini `vlad task deny` ile kaydet (<id> --tool <araç> --pattern \"<komut>\"; audit setup yalnız [İZİN] satırlarını sayar)";
}

/**
 * Records a structured permission denial: an `[İZİN]` İlerleme line (what the setup audit counts per task) plus one record
 * in kb/logs/denials.jsonl (flat history across tasks). Validation and the task lookup come before any write.
 */
export function denyTask(id: string, d: Denial): void {
  const line = formatDenyLine(d);
  const t = getTask(id);
  logTask(id, line);
  const dir = kbPaths().logs;
  mkdirSync(dir, { recursive: true });
  const rec = { at: nowIso(), task: id, project: t.data.project, tool: oneLine(d.tool), pattern: oneLine(d.pattern), ...(oneLine(d.reason ?? "") ? { reason: oneLine(d.reason ?? "") } : {}) };
  appendFileSync(join(dir, "denials.jsonl"), JSON.stringify(rec) + "\n");
}
