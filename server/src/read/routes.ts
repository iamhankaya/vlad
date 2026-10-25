import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { runVladJson, VladError } from "../vlad/cli.ts";
import { ReadCache } from "./cache.ts";
import { gateCard, isWorker, toCard, toPipelines, toTask, toWorker } from "./map.ts";
import type { CardData, GateProvider, TaskData } from "./types.ts";

export interface ReadDeps {
  cache?: ReadCache;
  /** Event ledger position for `/home` (S6d wires the real one). */
  seq?: () => number;
  /** Live PR facts for gate cards; without it no gate card is built (a gate needs a real head SHA). */
  gate?: GateProvider;
  /** Per-call timeout for `vlad` runs. */
  timeoutMs?: number;
}

const CARD_ID = /^(C-[0-9]{8}-[0-9]{2,}|gate-T[0-9]{8}-[0-9]{2,})$/;
const TASK_ID = /^T[0-9]{8}-[0-9]{2,}$/;
const EPOCH = "1970-01-01T00:00:00Z";

const err = (reply: FastifyReply, status: number, code: string, message_tr: string, details?: object) =>
  reply.code(status).send({ error: { code, message_tr, ...(details ? { details } : {}) } });

const notFound = (reply: FastifyReply, what: string) => err(reply, 404, "bad_request", `${what} bulunamadı.`, { reason: "not_found" });

/** A failed `vlad` run as an API error. The CLI's own text stays server-side; clients get the key. */
function vladFailure(reply: FastifyReply, e: unknown) {
  if (e instanceof VladError) {
    if (e.kind === "active_elsewhere") return err(reply, 409, "active_elsewhere", "Etkin VLAD başka makinede.");
    return err(reply, 503, "bad_request", "VLAD şu an okunamıyor.", { reason: "vlad_failed", kind: e.kind });
  }
  throw e;
}

export type ReadHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Handlers of the read endpoints by `operationId`; the app mounts them behind its signature preHandler (`http/app.ts`). */
export function readHandlers(deps: ReadDeps = {}): Record<"getHome" | "getCard" | "getTask" | "listPipelines", ReadHandler> {
  const cache = deps.cache ?? new ReadCache();
  const opts = { timeoutMs: deps.timeoutMs };
  const list = <T>(args: string[]) => cache.get(args.join(" "), () => runVladJson<T>(args, opts));

  const readTask = (id: string) =>
    cache.get(`task show ${id}`, () => runVladJson<{ task: TaskData; report: string | null }>(["task", "show", id], opts));

  /** Gate cards of the tasks waiting for approval; a task without live PR facts yields none. */
  async function gates(tasks: TaskData[]): Promise<Record<string, unknown>[]> {
    if (!deps.gate) return [];
    const out: Record<string, unknown>[] = [];
    for (const t of tasks.filter((x) => x.state === "awaiting_approval" && x.pr)) {
      const report = (await readTask(t.id)).report ?? "";
      const info = await deps.gate(t, report);
      if (info) out.push(gateCard(t, info, report));
    }
    return out;
  }

  const getHome: ReadHandler = async (_req, reply) => {
    // Position first, data after: whatever happens in between is a replayed event at worst, never a missed one.
    const seq = deps.seq?.() ?? 0;
    try {
      const [tasks, cards, quota, active] = await Promise.all([
        list<{ tasks: TaskData[]; warnings: string[] }>(["task", "list"]),
        list<{ cards: CardData[]; warnings: string[] }>(["card", "list", "--state", "open"]),
        list<{ limited: boolean; until: string | null; warnings: string[] }>(["quota", "show"]),
        list<{ active: { machine: string; since: string; heartbeat: string } | null; mine: boolean; warnings: string[] }>(["active", "show"]),
      ]);
      return {
        seq,
        asks: [...(await gates(tasks.tasks)), ...cards.cards.map(toCard)],
        workers: tasks.tasks.filter(isWorker).map(toWorker),
        quota: { limited: quota.limited, ...(quota.until ? { until: quota.until } : {}) },
        // no record = nobody is active; the contract has no null here, so an epoch record that is not "mine" says so
        active_vlad: active.active
          ? { machine: active.active.machine, since: active.active.since, heartbeat: active.active.heartbeat, mine: active.mine }
          : { machine: "", since: EPOCH, heartbeat: EPOCH, mine: false },
        warnings: [...tasks.warnings, ...cards.warnings, ...quota.warnings, ...active.warnings],
      };
    } catch (e) {
      return vladFailure(reply, e);
    }
  };

  const getCard: ReadHandler = async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!CARD_ID.test(id)) return err(reply, 400, "bad_request", "Geçersiz kart kimliği.", { field: "id" });
    try {
      if (id.startsWith("gate-")) {
        const { task, report } = await readTask(id.slice(5));
        const info = task.state === "awaiting_approval" && task.pr && deps.gate ? await deps.gate(task, report ?? "") : null;
        return info ? gateCard(task, info, report ?? "") : notFound(reply, "Kart");
      }
      return toCard(await cache.get(`card show ${id}`, () => runVladJson<CardData>(["card", "show", id], opts)));
    } catch (e) {
      if (e instanceof VladError && e.kind === "not_found") return notFound(reply, "Kart");
      return vladFailure(reply, e);
    }
  };

  const getTask: ReadHandler = async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!TASK_ID.test(id)) return err(reply, 400, "bad_request", "Geçersiz görev kimliği.", { field: "id" });
    try {
      const { task, report } = await readTask(id);
      return toTask(task, report);
    } catch (e) {
      if (e instanceof VladError && e.kind === "not_found") return notFound(reply, "Görev");
      return vladFailure(reply, e);
    }
  };

  const listPipelines: ReadHandler = async (_req, reply) => {
    try {
      const tasks = await list<{ tasks: TaskData[]; warnings: string[] }>(["task", "list"]);
      return { pipelines: toPipelines(tasks.tasks), warnings: tasks.warnings };
    } catch (e) {
      return vladFailure(reply, e);
    }
  };

  return { getHome, getCard, getTask, listPipelines };
}

const PATHS = { getHome: "/v1/home", getCard: "/v1/cards/:id", getTask: "/v1/tasks/:id", listPipelines: "/v1/pipelines" } as const;

/** Standalone registration (unit tests with a stand-in preHandler); the app itself uses {@link readHandlers}. */
export function registerReadRoutes(app: FastifyInstance, preHandler: preHandlerHookHandler, deps: ReadDeps = {}): void {
  const h = readHandlers(deps);
  for (const [op, url] of Object.entries(PATHS)) app.get(url, { preHandler }, h[op as keyof typeof PATHS]);
}
