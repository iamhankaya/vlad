// Kabul fazı (T20261101-22): çoklu makine kabul testlerinin ortak dünyası. Tester sahipliği; harness.ts'e dokunmaz.
// Yalnız geçici dizinler: iki home (beyin "mac" + işçi "windows"), bare origin + iki kb klonu, iki git repo. Gerçek kaynağa dokunmaz.
// Tüm vlad çağrıları ASENKRON (alt süreç): test sürecindeki TCP vekilleri (startProxy) spawnSync sırasında donardı.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI, makeHomePair, startAgent, type HomePair, type RunningAgent, type Side, type SpawnResult } from "../machines/harness.js";
import { rmTemp } from "../helpers.js";

export const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8", stdio: "pipe" });

/** Asenkron `vlad` çağrısı (yan etkisiz env: side.env + o.env). */
export function runVlad(side: Side, argv: string[], o: { stdin?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<SpawnResult> {
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, ...argv], { env: { ...process.env, ...side.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill(), o.timeoutMs ?? 25_000);
    p.on("close", (code) => { clearTimeout(t); res({ code, out, err }); });
    p.stdin.on("error", () => { /* süreç stdin okumadan çıkabilir */ });
    p.stdin.end(o.stdin ?? "");
  });
}

export interface WorldOpts {
  /** makine başına maxParallel (varsayılan her biri 1) */
  caps?: { mac?: number; windows?: number };
  consoles?: string[];
  /** kart `machines` (kart dosyasına doğrudan yazılır — A'nın `project set` yoluna bağımlı değil); yoksa alan yazılmaz */
  cardMachines?: string[];
  /** true: config'te `machines` hiç yok (tek makineli eski kurulum) */
  noMachines?: boolean;
  slug?: string;
}
export interface World {
  base: string;
  pair: HomePair;
  brain: Side;
  worker: Side;
  slug: string;
  repoName: string;
  brainRepo: string;
  workerRepo: string;
  agents: { brain?: RunningAgent; worker?: RunningAgent };
  ports: { mac: number; windows: number };
  config(): object;
  writeConfig(): void;
  setPorts(p: { mac?: number; windows?: number }): void;
  startAgents(which?: ("brain" | "worker")[], test?: Record<string, string>): Promise<void>;
  stopAgent(which: "brain" | "worker"): Promise<void>;
  newTask(o?: { args?: string[]; body?: string }): Promise<string>;
  taskFile(side: Side, id: string): string;
  readTask(side: Side, id: string): string;
  setFront(id: string, kv: Record<string, string | null>, side?: Side): void;
  list(side?: Side): Promise<Record<string, any>[]>;
  noop(side: Side): { taskId: string; cwd: string; title: string }[];
  cleanup(): Promise<void>;
}

const DIRS = ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal", "decisions", "findings"];

export async function makeWorld(o: WorldOpts = {}): Promise<World> {
  const slug = o.slug ?? "alpha";
  const pair = makeHomePair({ consoles: o.consoles ?? ["desktop"] });
  const base = dirname(pair.brain.home);
  const { brain, worker } = pair;

  // kb: bare origin + iki klon (gerçek git; ayrı kb düzeni)
  const origin = join(base, "kb-origin.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  const seed = join(base, "kb-seed");
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, ".gitignore"), "inbox/\nlogs/\nvlad-session.txt\n.vlad.lock\n.obsidian/\n");
  for (const d of ["projects", "tasks", "journal", "decisions", "findings"]) { mkdirSync(join(seed, d)); writeFileSync(join(seed, d, ".gitkeep"), ""); }
  git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "seed");
  git(seed, "remote", "add", "origin", origin); git(seed, "push", "-q", "-u", "origin", "main");
  for (const [side, dir] of [[brain, "kb-brain"], [worker, "kb-worker"]] as const) {
    const kb = join(base, dir);
    git(base, "clone", "-q", origin, kb);
    for (const d of DIRS) mkdirSync(join(kb, d), { recursive: true });
    side.env.VLAD_KB_DIR = kb;
    (side as { kb: string }).kb = kb;
  }

  // repolar: kartın yolu beyindeki repo; işçide aynı ada sahip repo roots altında
  const repoName = slug;
  const brainRoot = join(base, "roots-mac"), workerRoot = join(base, "roots-windows");
  const brainRepo = join(brainRoot, repoName), workerRepo = join(workerRoot, repoName);
  for (const r of [brainRepo, workerRepo]) {
    mkdirSync(r, { recursive: true });
    git(r, "init", "-q", "-b", "main");
    writeFileSync(join(r, "README.md"), "x\n");
    git(r, "add", "-A"); git(r, "commit", "-q", "-m", "init");
  }
  const canon = (p: string) => realpathSync.native(p);

  const w: World = {
    base, pair, brain, worker, slug, repoName,
    brainRepo: canon(brainRepo), workerRepo: canon(workerRepo),
    agents: {}, ports: { mac: 7437, windows: 7438 },
    config() {
      if (o.noMachines) return {};
      return {
        machines: [
          { name: "mac", os: process.platform, agent: { host: "127.0.0.1", port: w.ports.mac }, maxParallel: o.caps?.mac ?? 1, roots: [brainRoot], kbDir: brain.kb },
          { name: "windows", os: process.platform, agent: { host: "127.0.0.1", port: w.ports.windows }, maxParallel: o.caps?.windows ?? 1, roots: [workerRoot], kbDir: worker.kb },
        ],
        brain: "mac",
        consoles: (o.consoles ?? ["desktop"]).map((name) => ({ name })),
      };
    },
    writeConfig() { for (const s of [brain, worker]) writeFileSync(join(s.home, "vlad.config.json"), JSON.stringify(w.config())); },
    setPorts(p) { Object.assign(w.ports, p); w.writeConfig(); },
    async startAgents(which = ["brain", "worker"], test) {
      w.writeConfig(); // Agent'lar açılışta host/bind için config okur; port 0 ile açılır, gerçek port sonradan yazılır
      for (const k of which) w.agents[k] = await startAgent(k === "brain" ? brain : worker, { test });
      w.setPorts({ ...(which.includes("brain") ? { mac: w.agents.brain!.port } : {}), ...(which.includes("worker") ? { windows: w.agents.worker!.port } : {}) });
    },
    async stopAgent(k) { await w.agents[k]?.stop(); delete w.agents[k]; },
    async newTask(t = {}) {
      const r = await runVlad(brain, ["task", "new", "--project", slug, "--title", "T", "--kind", "dev", "--body-file", "-", ...(t.args ?? []), "--json"], { stdin: t.body ?? "## Tanım\nx\n" });
      if (r.code !== 0) throw new Error(`task new başarısız: ${r.err}`);
      return JSON.parse(r.out).id as string;
    },
    taskFile(side, id) {
      const dir = join(side.kb, "tasks");
      const f = readdirSync(dir).find((n) => n.startsWith(id));
      if (!f) throw new Error(`görev dosyası yok: ${id} (${side.name})`);
      return join(dir, f);
    },
    readTask: (side, id) => readFileSync(w.taskFile(side, id), "utf8"),
    setFront(id, kv, side = brain) {
      const f = w.taskFile(side, id);
      let txt = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      for (const [k, v] of Object.entries(kv)) {
        const re = new RegExp(`^${k}:.*$`, "m");
        if (v === null) txt = txt.replace(re, `${k}: null`);
        else if (re.test(txt)) txt = txt.replace(re, `${k}: ${v}`);
        else txt = txt.replace(/^---\n/, `---\n${k}: ${v}\n`);
      }
      writeFileSync(f, txt);
    },
    async list(side = brain) {
      const r = await runVlad(side, ["task", "list", "--json"]);
      if (r.code !== 0) throw new Error(`task list: ${r.err}`);
      const j = JSON.parse(r.out);
      return (j.tasks ?? j) as Record<string, any>[];
    },
    noop(side) {
      const f = side.env.VLAD_NOOP_LOG;
      if (!f || !existsSync(f)) return [];
      return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    async cleanup() {
      for (const k of ["brain", "worker"] as const) await w.stopAgent(k);
      pair.cleanup();
      rmTemp(base);
    },
  };

  w.writeConfig();
  // brain kartı: path = beyindeki repo
  const card = join(base, "card.md");
  writeFileSync(card, `---\nslug: ${slug}\nname: ${slug}\npath: ${JSON.stringify(w.brainRepo)}\n${o.cardMachines ? `machines: ${JSON.stringify(o.cardMachines)}\n` : ""}stack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
  const r = await runVlad(brain, ["project", "write", slug, "--file", card, "--json"]);
  if (r.code !== 0) throw new Error(`project write: ${r.err}`);
  return w;
}

/** Görev dosyasında frontmatter alanı (satır değeri). */
export const front = (txt: string, key: string): string | undefined => new RegExp(`^${key}:\\s*(.*)$`, "m").exec(txt.replace(/\r\n/g, "\n"))?.[1]?.trim();
