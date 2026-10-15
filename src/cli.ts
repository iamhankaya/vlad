#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { listInbox, markDone } from "./inbox/inbox.js";
import { installGlobal } from "./install.js";
import { addDecision, appendJournal, getVladHome, kbPaths, loadConfig, ValidationError } from "./kb/index.js";
import type { TaskKind, TaskState } from "./kb/index.js";
import { TerminalLauncher } from "./launcher/index.js";
import type { LaunchResult, Launcher } from "./launcher/index.js";
import { listProjects, writeProject } from "./projects/store.js";
import { scanRoots } from "./scan/scan.js";
import {
  TRANSITIONS, TransitionError, answerTask, askTask, cleanupTask, createTask, launchTask, listTasksWithWarnings,
  logTask, reportTask, setState, statusSummary,
} from "./tasks/index.js";
import type { Task } from "./tasks/index.js";

interface Opts { json?: boolean; [k: string]: unknown }

const wantsJson = () => process.argv.includes("--json");

function fail(e: unknown): never {
  let error = e instanceof Error ? e.message : String(e);
  let details: string[] = [];
  if (e instanceof ValidationError) details = e.details;
  else if (e instanceof TransitionError) details = [`izin verilenler: ${TRANSITIONS[e.from].join(", ") || "(yok)"}`];
  if (wantsJson()) process.stderr.write(JSON.stringify({ error, details }) + "\n");
  else {
    error = `hata: ${error}`;
    process.stderr.write([error, ...details.map((d) => `  ${d}`)].join("\n") + "\n");
  }
  process.exit(1);
}

/** Reads a file; "-" means stdin. */
function readInput(p: string): string {
  return readFileSync(p === "-" ? 0 : p, "utf8");
}

function out(o: Opts, data: unknown, text: string): void {
  process.stdout.write((o.json ? JSON.stringify(data) : text) + "\n");
}

const taskLine = (t: Task) => `${t.data.id}  ${t.data.state.padEnd(17)} ${t.data.project}  ${t.data.title}`;

// commander writes the help of a bare group ("vlad", "vlad task") to writeErr before throwing
// commander.help; keep it so the catch below can show it instead of a bare "(outputHelp)" error.
let pendingHelp = "";
const program = new Command();
program
  .name("vlad")
  .description("VLAD: Claude Code orkestratörü")
  .exitOverride()
  .configureOutput({ writeErr: (str) => { pendingHelp += str; } });

/** Registers a command with --json and a uniform error path. */
function def(parent: Command, spec: string, desc: string, fn: (...a: any[]) => void | Promise<void>): Command {
  const c = parent.command(spec).description(desc).option("--json", "makine okunur çıktı");
  c.action(async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  });
  return c;
}

def(program, "scan", "Kök klasörleri tara (kart yazmaz)", (o: Opts) => {
  const repos = scanRoots(loadConfig());
  out(o, { repos }, repos.map((r) => `${r.slug}  ${r.path}${r.hasCard ? "" : "  (kart yok)"}`).join("\n"));
});

const project = program.command("project").description("Proje kartları");
def(project, "write <slug>", "Kartı doğrulayıp yazar", (slug: string, o: Opts) => {
  const card = writeProject(slug, readInput(o.file as string));
  out(o, { slug: card.slug }, `yazıldı: ${card.slug}`);
}).requiredOption("--file <md>", "kart dosyası (- = stdin)");
def(project, "list", "Kartları listeler", (o: Opts) => {
  const projects = listProjects();
  out(o, { projects }, projects.map((p) => `${p.slug}  ${p.status}  ${p.path}`).join("\n"));
});

const task = program.command("task").description("Görevler");
def(task, "new", "queued görev oluşturur", (o: Opts) => {
  const body = o.bodyFile ? readInput(o.bodyFile as string) : "";
  const t = createTask({ project: o.project as string, title: o.title as string, kind: o.kind as TaskKind, body });
  out(o, { id: t.data.id }, t.data.id);
})
  .requiredOption("--project <slug>", "proje slug'ı")
  .requiredOption("--title <başlık>", "görev başlığı")
  .option("--kind <kind>", "dev | research", "dev")
  .option("--body-file <md>", "görev gövdesi (- = stdin)");

def(task, "launch <id>", "Worktree + branch açar, running yapar, Launcher'ı çağırır", async (id: string, o: Opts) => {
  const cfg = loadConfig();
  let last: LaunchResult | undefined;
  const real = new TerminalLauncher({ mode: cfg.launcher, dryRun: !!o.dryRun });
  const launcher: Launcher = { launch: async (req) => (last = await real.launch(req)) };
  const t = await launchTask(id, { launcher, cfg });
  out(
    o,
    { id, state: t.data.state, branch: t.data.branch, worktree: t.data.worktree, method: last?.method, detail: last?.detail },
    `${id} başlatıldı (${last?.method}) -> ${t.data.worktree}${o.dryRun ? "\n(dry-run) " + (last?.detail ?? "") : ""}`,
  );
}).option("--dry-run", "terminal açmadan komutu göster");

def(task, "log <id> <mesaj>", "## İlerleme'ye zaman damgalı satır ekler", (id: string, msg: string, o: Opts) => {
  logTask(id, msg);
  out(o, { id }, "eklendi");
});
def(task, "ask <id> <soru>", "Soru ekler, blocked yapar", (id: string, q: string, o: Opts) => {
  const t = askTask(id, q);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
});
def(task, "answer <id> <cevap>", "Cevabı ekler, running yapar", (id: string, a: string, o: Opts) => {
  const t = answerTask(id, a);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
});
def(task, "report <id>", "Kapanış raporunu yazar, awaiting_approval yapar", (id: string, o: Opts) => {
  const t = reportTask(id, readInput(o.file as string));
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
}).requiredOption("--file <md>", "rapor dosyası (- = stdin)");
def(task, "set <id> <state>", "Durum makinesine uygun geçiş", (id: string, state: string, o: Opts) => {
  if (!(state in TRANSITIONS)) throw new Error(`bilinmeyen durum: ${state}; geçerliler: ${Object.keys(TRANSITIONS).join(", ")}`);
  const t = setState(id, state as TaskState);
  out(o, { id, state: t.data.state }, `${id} -> ${t.data.state}`);
});
def(task, "cleanup <id>", "done/cancelled görevin worktree'sini kaldırır", (id: string, o: Opts) => {
  cleanupTask(id);
  out(o, { id }, `${id} worktree kaldırıldı`);
});
def(task, "list", "Görevleri listeler", (o: Opts) => {
  const states = o.state ? String(o.state).split(",") as TaskState[] : undefined;
  const { tasks, warnings } = listTasksWithWarnings({ state: states, project: o.project as string | undefined });
  out(
    o,
    { tasks: tasks.map((t) => t.data), warnings },
    [...tasks.map(taskLine), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
  );
})
  .option("--state <states>", "virgülle ayrılmış durumlar")
  .option("--project <slug>", "proje slug'ı");

def(program, "status", "Aktif görevler; eski running görevleri stalled yapar", (o: Opts) => {
  const s = statusSummary(loadConfig(), new Date());
  if (o.summary) {
    const line =
      `İşlenmemiş ${s.inbox} rapor, ${s.active.length} aktif görev ` +
      `(${s.counts.awaiting_approval} onay bekliyor, ${s.counts.stalled} takıldı, ${s.counts.blocked} soru soruyor)`;
    out(o, { ...s, active: s.active.map((t) => t.data), summary: line }, line);
    return;
  }
  const lines = [...s.active.map(taskLine), `inbox: ${s.inbox}`];
  if (s.newlyStalled.length) lines.push(`takıldı: ${s.newlyStalled.join(", ")}`);
  out(o, { ...s, active: s.active.map((t) => t.data) }, lines.join("\n"));
}).option("--summary", "tek satır özet");

const inbox = program.command("inbox").description("Oturum raporları");
def(inbox, "list", "İşlenmemiş raporlar", (o: Opts) => {
  const items = listInbox();
  out(o, { items }, items.map((i) => `${i.file}  ${i.record.project ?? "-"}  ${i.record.reason}`).join("\n"));
});
def(inbox, "count", "İşlenmemiş rapor sayısı", (o: Opts) => {
  const count = listInbox().length;
  out(o, { count }, String(count));
});
def(inbox, "done <dosyalar...>", "Raporları processed/'a taşır", (files: string[], o: Opts) => {
  markDone(files);
  out(o, { moved: files }, `${files.length} rapor taşındı`);
});

const decision = program.command("decision").description("Karar günlüğü");
def(decision, "add", "kb/decisions.md'ye karar ekler", (o: Opts) => {
  addDecision({
    project: o.project as string,
    title: o.title as string,
    body: readInput(o.bodyFile as string),
    source: o.source as string | undefined,
  });
  out(o, { ok: true }, "karar eklendi");
})
  .requiredOption("--project <slug>", "proje")
  .requiredOption("--title <başlık>", "başlık")
  .requiredOption("--body-file <md>", "gövde (- = stdin)")
  .option("--source <kaynak>", "session/görev kaynağı");

const journal = program.command("journal").description("Günlük");
def(journal, "append <tarih>", "kb/journal/<tarih>.md'ye ekler", (date: string, o: Opts) => {
  appendJournal(date, readInput(o.file as string));
  out(o, { date }, `günlüğe eklendi: ${date}`);
}).requiredOption("--file <md>", "içerik (- = stdin)");

const sessionFile = () => join(kbPaths().kb, "vlad-session.txt");
const session = program.command("session").description("VLAD oturum adı");
def(session, "register <ad>", "Oturum adını kb/vlad-session.txt'ye yazar", (name: string, o: Opts) => {
  if (!name.trim()) throw new Error("oturum adı boş olamaz");
  const file = sessionFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, name.trim() + "\n", "utf8");
  out(o, { name: name.trim() }, `kaydedildi: ${name.trim()}`);
});
def(session, "name", "Kayıtlı oturum adını yazar", (o: Opts) => {
  const file = sessionFile();
  if (!existsSync(file)) throw new Error("oturum kaydı yok; önce `vlad session register <ad>`");
  const name = readFileSync(file, "utf8").trim();
  out(o, { name }, name);
});

def(program, "install", "SessionEnd hook'unu ve vlad-worker skill'ini ~/.claude'a kurar", (o: Opts) => {
  const claudeDir = process.env.VLAD_CLAUDE_DIR || join(homedir(), ".claude");
  const { actions } = installGlobal({ home: getVladHome(), claudeDir, dryRun: !!o.dryRun });
  out(o, { actions }, actions.join("\n"));
}).option("--dry-run", "hiçbir şeye dokunmadan yapılacakları göster");

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) process.exit(0); // --help / --version
    if (e.code === "commander.help" || e.code === "commander.helpDisplayed") {
      process.stderr.write(pendingHelp); // bare group without subcommand
      process.exit(1);
    }
    fail(new Error(e.message.replace(/^error: /, "")));
  }
  fail(e);
}
