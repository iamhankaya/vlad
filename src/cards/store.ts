import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_OPTIONS, CARD_KINDS, kbPaths, nowIso, readDoc, serializeDoc, validate, writeDoc } from "../kb/index.js";
import type { CardData, CardKind, CardState, ProjectCard } from "../kb/index.js";

export type Card = { data: CardData; body: string; file: string };

export const KINDS: readonly CardKind[] = CARD_KINDS;
export const STATES: readonly CardState[] = ["open", "resolved", "dismissed"];

const ID = /^C-\d{8}-\d{2,}$/;

function cardFile(id: string): string {
  return join(kbPaths().cards, `${id}.md`);
}

/** Schema validation plus what a schema cannot say: option ids are unique. */
function check(data: CardData): void {
  validate("card", data);
  const seen = new Set<string>();
  for (const op of data.options) {
    if (seen.has(op.id)) throw new Error(`yinelenen seçenek: ${op.id}`);
    seen.add(op.id);
  }
}

const LOCK_STALE_MS = 60_000;

/**
 * Per-card O_EXCL lock around a read-check-write, so direct callers (not only the CLI, which also holds the kb lock)
 * cannot interleave. A lock older than LOCK_STALE_MS (crashed holder) is taken over.
 */
function withCardLock<T>(id: string, fn: () => T): T {
  const lock = join(kbPaths().cards, `${id}.lock`);
  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch { /* vanished: retry */ }
      if (stale) {
        try { unlinkSync(lock); } catch { /* someone else took it over */ }
      } else if (attempt >= 1) throw new Error("kart meşgul");
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** `YYYYMMDD` in local time, matching nowIso (so the id day flips at local midnight). */
const dayOf = (d: Date) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

/** [day, n] of an id for numeric ordering (`C-…-100` sorts after `C-…-99`). */
const idKey = (id: string): [string, number] => {
  const m = /^C-(\d{8})-(\d+)$/.exec(id)!;
  return [m[1], Number(m[2])];
};
const byId = (a: string, b: string) => {
  const [da, na] = idKey(a);
  const [db, nb] = idKey(b);
  return da === db ? na - nb : da < db ? -1 : 1;
};

/** Next free `C-<day>-<NN>` for the day; NN has at least two digits and widens past 99. */
export function nextCardId(dir: string, now: Date = new Date()): string {
  const prefix = `C-${dayOf(now)}-`;
  let max = 0;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const m = f.startsWith(prefix) ? /^(\d+)\.md$/.exec(f.slice(prefix.length)) : null;
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}${pad2(max + 1)}`;
}

function projectRepo(project: string): string | undefined {
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error(`geçersiz proje slug'ı: "${project}" (yalnızca a-z, 0-9 ve '-')`);
  const file = join(kbPaths().projects, `${project}.md`);
  if (!existsSync(file)) throw new Error(`proje kartı bulunamadı: ${project}`);
  return readDoc<ProjectCard>(file).data.repo;
}

export interface NewCard {
  kind: string;
  project: string;
  title: string;
  task?: string | null;
  options?: { id: string; label: string }[];
  action?: { kind: string; repo: string; sha?: string; pr?: number; base?: string; ref?: string };
}

export function addCard(o: NewCard, now: Date = new Date()): Card {
  if (!(KINDS as readonly string[]).includes(o.kind)) throw new Error(`geçersiz tür: "${o.kind}" (geçerli: ${KINDS.join(", ")})`);
  const repo = projectRepo(o.project);
  if (o.action) {
    if (o.kind !== "action_request") throw new Error("action yalnızca action_request kartında olur");
    // allowlist: the only repo an action may target is the one registered on the card's project
    if (!repo || o.action.repo !== repo) throw new Error("repo izin listesinde değil");
  }
  // an action_request has fixed options; the caller (an agent) cannot supply its own
  if (o.kind === "action_request") {
    if (o.options?.length) throw new Error("action_request kartında seçenek verilemez (sabit: approve/reject)");
    if (!o.action) throw new Error("action_request kartı için action gerekli");
  }
  const options = o.kind === "action_request" ? ACTION_OPTIONS.map((x) => ({ ...x })) : (o.options ?? []);
  const dir = kbPaths().cards;
  mkdirSync(dir, { recursive: true });
  const prefix = `C-${dayOf(now)}-`;
  let n = Number(nextCardId(dir, now).slice(prefix.length));
  for (;;) {
    const id = `${prefix}${pad2(n)}`;
    const ts = nowIso(now);
    const data: CardData = {
      id, kind: o.kind as CardKind, project: o.project, task: o.task ?? null, state: "open", title: o.title.trim(),
      options, answer: null, ...(o.action ? { action: o.action as CardData["action"] } : {}), created: ts, updated: ts,
    };
    check(data);
    const file = cardFile(id);
    try {
      writeFileSync(file, serializeDoc(data, ""), { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        n++;
        continue;
      }
      throw e;
    }
    return { data, body: "", file };
  }
}

export function getCard(id: string): Card {
  const file = ID.test(id) ? cardFile(id) : "";
  if (!file || !existsSync(file)) throw new Error(`kart bulunamadı: ${id}`);
  const { data, body } = readDoc<CardData>(file);
  check(data);
  return { data, body, file };
}

/** Valid cards in id order; unreadable or invalid files are skipped and reported as warnings. */
export function listCardsWithWarnings(
  f: { project?: string; state?: CardState[]; kind?: CardKind[] } = {},
): { cards: Card[]; warnings: string[] } {
  const dir = kbPaths().cards;
  const cards: Card[] = [];
  const warnings: string[] = [];
  if (!existsSync(dir)) return { cards, warnings };
  for (const name of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const file = join(dir, name);
    try {
      const { data, body } = readDoc<CardData>(file);
      check(data);
      if (f.project && data.project !== f.project) continue;
      if (f.state && !f.state.includes(data.state)) continue;
      if (f.kind && !f.kind.includes(data.kind)) continue;
      cards.push({ data, body, file });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }
  cards.sort((a, b) => byId(a.data.id, b.data.id));
  return { cards, warnings };
}

/**
 * Records the answer of an open card (once). `by_device` is stored exactly as given: the CLI cannot verify it,
 * so only a caller holding a verified identity (the API's signed envelope) may pass it; never take it from client input.
 */
export function answerCard(id: string, a: { option?: string; text?: string; by_device: string }, now: Date = new Date()): Card {
  return withCardLock(id, () => {
  const c = getCard(id);
  // an action_request is answered only through the API's approval path (signed challenge), never by a CLI argument
  if (c.data.kind === "action_request") throw new Error("action_request kartı yalnız onay yolundan cevaplanır");
  if (c.data.answer) throw new Error("zaten cevaplandı");
  if (c.data.state !== "open") throw new Error(`kart açık değil: ${c.data.state}`);
  const text = a.text?.trim();
  if (a.option === undefined && !text) throw new Error("cevap için --option ya da --text gerekli");
  if (a.option !== undefined && !c.data.options.some((o) => o.id === a.option)) {
    throw new Error(`geçersiz seçenek: "${a.option}" (geçerli: ${c.data.options.map((o) => o.id).join(", ") || "(yok)"})`);
  }
  const ts = nowIso(now);
  const next: CardData = {
    ...c.data,
    answer: { ...(a.option !== undefined ? { option: a.option } : {}), ...(text ? { text } : {}), by_device: a.by_device, at: ts },
    updated: ts,
  };
  check(next);
  writeDoc(c.file, next, c.body);
  return { ...c, data: next };
  });
}

/** Closes an open card as resolved (default) or dismissed. */
export function resolveCard(id: string, state: "resolved" | "dismissed" = "resolved", now: Date = new Date()): Card {
  return withCardLock(id, () => {
  const c = getCard(id);
  if (c.data.state !== "open") throw new Error(`kart zaten kapalı: ${c.data.state}`);
  const next: CardData = { ...c.data, state, updated: nowIso(now) };
  check(next);
  writeDoc(c.file, next, c.body);
  return { ...c, data: next };
  });
}

/** Parses a comma-separated filter, rejecting values outside `allowed`. */
export function parseFilter<T extends string>(raw: string, allowed: readonly T[], what: string): T[] {
  const vals = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = vals.filter((v) => !(allowed as readonly string[]).includes(v));
  if (bad.length) throw new Error(`geçersiz ${what}: ${bad.join(", ")} (geçerli: ${allowed.join(", ")})`);
  return vals as T[];
}
