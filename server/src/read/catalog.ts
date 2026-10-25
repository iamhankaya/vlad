import type { FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import { runVlad, VladError } from "../vlad/cli.ts";
import { ReadCache } from "./cache.ts";
import type { ReadDeps, ReadHandler } from "./routes.ts";
import type { TaskData } from "./types.ts";

// Narrower than the contract's `^[a-z0-9-]+$`: a kb slug never starts with "-" (project.schema.json), and a value that does must not reach the CLI as an option.
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const STATUSES = ["open", "deferred", "fixed", "wontfix"];
const SEVERITIES = ["kritik", "yüksek", "orta", "düşük", "bilgi"];
const ZONES = ["kb", "docs"];
const TERMINAL = ["done", "failed", "cancelled"];
const MAX_Q = 200;
const MAX_PATH = 300;

const err = (reply: FastifyReply, status: number, message_tr: string, details?: object) =>
  reply.code(status).send({ error: { code: "bad_request", message_tr, ...(details ? { details } : {}) } });

/**
 * Path rules the API enforces itself, before any `vlad` run: the CLI repeats them (src/vault/search.ts), but a
 * request that cannot possibly be allowed never spawns anything. The query string was decoded once by the server,
 * so a `%` left in the value is a second encoding layer and is refused (`%2e%2e`, `%252e`).
 */
const DENIED_UNDER_KB = ["inbox", "logs", "audit", "grants"];
const fold = (s: string) => s.normalize("NFKC").toUpperCase().toLowerCase();

export function vaultPathProblem(p: string): string | null {
  if (p.length < 1 || p.length > MAX_PATH) return "length";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return "control";
  if (p.includes("\\")) return "backslash";
  if (/%[0-9a-fA-F]{2}/.test(p)) return "encoded";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "absolute";
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) return "empty";
  if (segs.some((s) => s === "..")) return "traversal";
  const low = segs.map(fold);
  if (low.some((s) => s.startsWith("."))) return "dotfile";
  if (low[0] === "kb") return low.length > 1 && DENIED_UNDER_KB.includes(low[1]) ? "sensitive" : null;
  if (low[0] === "vault" && low[1] === "docs") return null;
  return "zone";
}

/** CLI messages (Turkish, src/vault/search.ts) that mean "this request was refused", as opposed to a broken run. */
const VAULT_REFUSED = /^(yol |dosya |dizin |yalnızca \.md|ikili dosya|geçersiz UTF|sorgu |geçersiz bölge)/;

/** Text between the opening and closing `---` of a card, and what follows. */
function splitCard(md: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { front: {}, body: md };
  const front = parseYaml(m[1]);
  return { front: front && typeof front === "object" ? (front as Record<string, unknown>) : {}, body: m[2] };
}

// kb exposure is local | network | internet; the API has local | internet | none. Absent = nothing was ever asked = none.
const exposureOf = (e: unknown) => (e === "internet" ? "internet" : e === "local" || e === "network" ? "local" : "none");

interface ProjectRow { slug: string; name?: string; repo?: string; exposure?: string; last_activity: string | null }

/** Catalog read endpoints (projects, findings, vault), by `operationId`. Data comes only from `vlad` runs. */
export function catalogHandlers(deps: ReadDeps, cache: ReadCache): Record<"listProjects" | "getProject" | "listFindings" | "searchVault" | "readVaultFile", ReadHandler> {
  const opts = { timeoutMs: deps.timeoutMs };
  /** `tail` goes after `--`: user text can never be read as an option. */
  const run = <T>(args: string[], tail: string[] = []) =>
    cache.get(["vlad", ...args, "--", ...tail].join("\u0000"), async () => {
      const out = await runVlad([...args, "--json", ...(tail.length ? ["--", ...tail] : [])], opts);
      try {
        return JSON.parse(out) as T;
      } catch {
        throw new VladError("failed", `vlad ${args[0] ?? ""}: çıktı JSON değil`);
      }
    });

  function failure(reply: FastifyReply, e: unknown, what: string, refusal?: object) {
    if (!(e instanceof VladError)) throw e;
    if (e.kind === "not_found") return err(reply, 404, `${what} bulunamadı.`, { reason: "not_found" });
    if (e.kind === "active_elsewhere") return reply.code(409).send({ error: { code: "active_elsewhere", message_tr: "Etkin VLAD başka makinede." } });
    if (refusal && e.kind === "failed" && VAULT_REFUSED.test(e.message)) return err(reply, 400, "Geçersiz istek.", refusal);
    return err(reply, 503, "VLAD şu an okunamıyor.", { reason: "vlad_failed", kind: e.kind });
  }

  /** One value of a query parameter: a string, or `undefined` when absent; arrays/objects are `null` (rejected). */
  const param = (req: FastifyRequest, name: string): string | undefined | null => {
    const v = (req.query as Record<string, unknown>)[name];
    return v === undefined ? undefined : typeof v === "string" ? v : null;
  };

  const openTasks = (tasks: TaskData[]) => {
    const n = new Map<string, number>();
    for (const t of tasks) if (t.kind !== "pipeline" && !TERMINAL.includes(t.state)) n.set(t.project, (n.get(t.project) ?? 0) + 1);
    return n;
  };
  const summary = (p: ProjectRow, open: Map<string, number>) => ({
    slug: p.slug, name: p.name ?? p.slug, exposure: exposureOf(p.exposure), repo: p.repo ?? null,
    open_tasks: open.get(p.slug) ?? 0, last_activity: p.last_activity ?? null,
  });

  const listProjects: ReadHandler = async (_req, reply) => {
    try {
      const [projects, tasks] = await Promise.all([
        run<{ projects: ProjectRow[]; warnings: string[] }>(["project", "list"]),
        run<{ tasks: TaskData[]; warnings: string[] }>(["task", "list"]),
      ]);
      const open = openTasks(tasks.tasks);
      return { projects: projects.projects.map((p) => summary(p, open)), warnings: [...projects.warnings, ...tasks.warnings] };
    } catch (e) {
      return failure(reply, e, "Proje");
    }
  };

  const getProject: ReadHandler = async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!SLUG.test(slug)) return err(reply, 400, "Geçersiz proje adı.", { field: "slug" });
    try {
      const [projects, tasks] = await Promise.all([
        run<{ projects: ProjectRow[]; warnings: string[] }>(["project", "list"]),
        run<{ tasks: TaskData[]; warnings: string[] }>(["task", "list"]),
      ]);
      const p = projects.projects.find((x) => x.slug === slug);
      if (!p) return err(reply, 404, "Proje bulunamadı.", { reason: "not_found" });
      const file = await run<{ content: string }>(["vault", "read"], [`kb/projects/${slug}.md`]);
      return { ...summary(p, openTasks(tasks.tasks)), card_md: splitCard(file.content).body.trim() };
    } catch (e) {
      return failure(reply, e, "Proje");
    }
  };

  const listFindings: ReadHandler = async (req, reply) => {
    const project = param(req, "project");
    const status = param(req, "status");
    const severity = param(req, "severity");
    if (project === null || (project !== undefined && !SLUG.test(project))) return err(reply, 400, "Geçersiz süzgeç.", { field: "project" });
    if (status === null || (status !== undefined && !STATUSES.includes(status))) return err(reply, 400, "Geçersiz süzgeç.", { field: "status" });
    if (severity === null || (severity !== undefined && !SEVERITIES.includes(severity))) return err(reply, 400, "Geçersiz süzgeç.", { field: "severity" });
    const args = ["finding", "list", ...(project ? [`--project=${project}`] : []), ...(status ? [`--state=${status}`] : []), ...(severity ? [`--severity=${severity}`] : [])];
    try {
      const r = await run<{ findings: { id: string; project: string; severity: string; state: string; title: string; detail?: string }[]; warnings: string[] }>(args);
      return {
        findings: r.findings.map((f) => ({
          id: f.id, project: f.project, severity: f.severity, status: f.state, title: f.title, ...(f.detail ? { detail: f.detail } : {}),
        })),
        warnings: r.warnings,
      };
    } catch (e) {
      return failure(reply, e, "Bulgu");
    }
  };

  const searchVault: ReadHandler = async (req, reply) => {
    const q = param(req, "q");
    const zone = param(req, "zone");
    if (!q || q.length > MAX_Q || q.includes("\0")) return err(reply, 400, "Geçersiz sorgu.", { field: "q" });
    if (zone === null || (zone !== undefined && !ZONES.includes(zone))) return err(reply, 400, "Geçersiz bölge.", { field: "zone" });
    try {
      const r = await run<{ hits: { path: string; score: number; snippet: string }[] }>(["vault", "search", ...(zone ? [`--zone=${zone}`] : [])], [q]);
      return { hits: r.hits.map((h) => ({ path: h.path, score: h.score, snippet: h.snippet })) };
    } catch (e) {
      return failure(reply, e, "Dosya", { field: "q" });
    }
  };

  const readVaultFile: ReadHandler = async (req, reply) => {
    const path = param(req, "path");
    const bad = path === undefined || path === null ? "missing" : vaultPathProblem(path);
    if (bad) return err(reply, 400, "Yol izin listesinde değil.", { reason: "path_forbidden" });
    try {
      const f = await run<{ path: string; content: string; headings: { text: string }[] }>(["vault", "read"], [path!]);
      return { path: f.path, content: f.content, headings: f.headings.map((h) => h.text) };
    } catch (e) {
      return failure(reply, e, "Dosya", { reason: "path_forbidden" });
    }
  };

  return { listProjects, getProject, listFindings, searchVault, readVaultFile };
}
