import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSection, kbPaths, readDoc } from "../kb/index.js";
import type { ProjectCard } from "../kb/index.js";
import { roleFor, getTask, saveTask, setState } from "./store.js";
import type { Task } from "./store.js";

/** What VLAD hands to `create_session` for a cloud worker (`vlad task launch --json`, cloud mode). */
export interface CloudLaunch {
  id: string;
  state: "running";
  mode: "cloud";
  action: "create_session";
  repo: string;
  source_url: string;
  /** Branch the worker starts from: the integration branch in a pipeline, else the card's default branch. */
  source_revision: string;
  base_branch: string;
  outcome_branch: string;
  branch: string;
  worktree: null;
  integration: { branch: string; needs_remote_create: boolean; from: string } | null;
  model: string | null;
  title: string;
  tags: string[];
  permission_mode: "auto";
  prompt: string;
  next: string[];
  warnings: string[];
}

/** Whether `branch` exists on the project's GitHub repo; "unknown" when the remote cannot be reached. */
export type RemoteBranchState = "exists" | "missing" | "unknown";

/** `git ls-remote` of the repo: empty output means the branch is absent, a failing command means unknown. */
export function remoteBranchState(repo: string, branch: string): RemoteBranchState {
  try {
    const out = execFileSync("git", ["ls-remote", `https://github.com/${repo}.git`, `refs/heads/${branch}`], {
      encoding: "utf8", stdio: "pipe", timeout: 20000, windowsHide: true,
    });
    return out.trim() ? "exists" : "missing";
  } catch {
    return "unknown";
  }
}

export interface CloudLaunchOptions {
  remoteBranch?: (repo: string, branch: string) => RemoteBranchState;
  /** The launching VLAD's own session id (`CLAUDE_CODE_REMOTE_SESSION_ID`); the worker notifies it on finishing. */
  vladSession?: string;
}

/** `create_trigger` takes `session_…` ids; the env var may carry the `cse_…` form of the same id. */
export function toSessionId(id: string): string {
  return id.startsWith("cse_") ? `session_${id.slice(4)}` : id;
}

function card(slug: string): ProjectCard {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(file).data;
}

const PROTOCOL = (id: string, autonomy: string, vladSession?: string) => [
  "## VLAD bulut protokolü",
  "- Bu protokol, yukarıdaki rol metninin Yetki bölümündeki `kb/`, `vlad task …` (log|ask|report), görev dosyası ve worktree adımlarını geçersiz kılar; çelişkide bu protokol geçerlidir.",
  `- Görev: ${id}. Çalışma branch'in \`vlad/${id}\`; commit'lerini yalnızca oraya push et (\`git push -u origin vlad/${id}\`).`,
  "- `master`'a veya başka bir branch'e push etme; merge etme; PR açma. `kb/` altına yazma; `vlad` CLI'ı ve `vlad-worker` skill'ini kullanma: rol metnindeki \"vlad-worker protokolünü uygula\" yerine bu protokol geçerlidir (tek doğru kaynak).",
  autonomy === "plan"
    ? "- Yetki seviyen `plan`: kod yazma ve push etme; yalnızca planı raporla."
    : `- Yetki seviyen \`${autonomy}\`: yalnızca \`vlad/${id}\`'ye commit + push.`,
  "- İlerlemeyi yanıtlarına satır başında şu işaretlerle yaz (kod çitinin dışında, `#seq` 1'den artan, her işaretle bir artar):",
  "  `[VLAD:LOG #n] <kısa adım>`",
  "- Karar gerektiren soru: `[VLAD:ASK #n] <soru, seçenekler>` yaz ve turunu bitir; cevap `[VLAD:ANSWER #n]` ile gelir.",
  "- Bitince önce push et, sonra aşağıdaki biçimde kapanış raporunu yaz (yalnızca `###` ve daha derin başlıklar; build/test komutları ve sonuçları dahil):",
  `  \`[VLAD:REPORT #n branch=vlad/${id} head=<sha>]\` … rapor … \`[VLAD:END #n]\``,
  "- Başarısızsan: `[VLAD:FAIL #n] <neden, tek satır>`.",
  "- Bitirirken son tur mesajında tüm işaretlerini (LOG'lar dahil) tekrar et; VLAD uzun transcript'te yalnızca son sayfayı okuyabilir.",
  ...(vladSession
    ? [
        `- Bildirim: REPORT, ASK veya FAIL işaretini yazdıktan sonra VLAD session'ına (\`${vladSession}\`) tek seferlik zamanlanmış görev kur: \`create_trigger\` ile \`persistent_session_id: ${vladSession}\`, \`run_once_at\` ≈ şimdi+1 dk, prompt "VLAD görev ${id}: <durum> — ingest et" (<durum>: awaiting_approval, blocked veya failed). \`send_later\` kullanma: hatırlatmayı kendi session'ına kurar. Kuramazsan yalnızca bir \`[VLAD:LOG #n]\` satırıyla belirt; çalışmayı durdurma.`,
      ]
    : []),
].join("\n");

/** Drops `###` subsections (up to the next heading of level 1-3) whose title is in `names`. */
function dropSubsections(text: string, names: string[]): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const m = /^(#{1,3})\s+(.*?)\s*$/.exec(line);
    if (m) skipping = m[1] === "###" && names.includes(m[2]);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

function buildCloudPrompt(
  task: Task, role: { title: string; file: string; skills: string[] } | undefined, vladSession?: string, parent?: Task,
): string {
  const parts: string[] = [
    `Sen bir VLAD çalışanısın (bulut). Görev ${task.data.id}: ${task.data.title}. Görev dosyasına erişimin yok; görev aşağıda satır içi verilmiştir.`,
  ];
  for (const h of ["## Tanım", "## Kabul kriterleri", "## Bağlam"]) {
    const s = getSection(task.body, h);
    if (s) parts.push(`${h}\n${s}`);
  }
  if (parent) {
    // the worker cannot read kb/, so a phase that says "see the pipeline" needs the pipeline text inline
    const sections = ["## Tanım", "## Kabul kriterleri", "## Bağlam"].flatMap((h) => {
      const s = getSection(parent.body, h);
      const t = s ? dropSubsections(s, ["Fazlar", "Kapılar"]) : "";
      return t ? [`### ${h.slice(3)}\n${t}`] : [];
    });
    parts.push(`## Çatı görev (${parent.data.id})\n${sections.join("\n\n") || "(çatı görevde Tanım/Kabul kriterleri/Bağlam yok)"}`);
  }
  if (role) {
    const body = readDoc<unknown>(role.file).body.trim();
    parts.push(`## Rolün: ${role.title}\n${body}`);
    if (role.skills.length) {
      parts.push(
        `İşe başlamadan şu skill'leri yüklemeyi dene: ${role.skills.map((s) => `\`${s}\``).join(", ")}. ` +
          "Yüklenemeyen olursa kapanış raporunda belirt.",
      );
    }
  }
  for (const d of task.data.depends_on ?? []) {
    let report: string | null = null;
    try { report = getSection(getTask(d).body, "## Kapanış raporu"); } catch { /* reported as missing below */ }
    parts.push(`## Girdi: ${d} kapanış raporu\n${report || "(rapor yok)"}`);
  }
  parts.push(PROTOCOL(task.data.id, task.data.autonomy, vladSession));
  return parts.join("\n\n");
}

/**
 * Cloud mode of `vlad task launch`: no local worktree or terminal. Validates the task and its
 * project card, builds the `create_session` arguments and moves the task to `running`. Any
 * failure leaves the task `queued` with `error` set.
 */
export function prepareCloudLaunch(id: string, o: CloudLaunchOptions = {}): CloudLaunch {
  const task = getTask(id);
  if (task.data.state !== "queued") throw new Error(`görev queued değil (${task.data.state}): ${id}`);
  if (task.data.kind !== "dev") throw new Error(`yalnızca dev görevleri başlatılır (kind=${task.data.kind}): ${id}`);

  const branch = `vlad/${id}`;
  let res: CloudLaunch;
  const warnings: string[] = [];
  const rawSession = o.vladSession ?? process.env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim() ?? undefined;
  const vladSession = rawSession ? toSessionId(rawSession) : rawSession;
  try {
    const role = task.data.role ? roleFor(task.data.role, task.data.kind) : undefined;
    const c = card(task.data.project);
    if (c.local_only) {
      throw new Error(`proje ${c.slug} yalnızca yerel çalışır${c.local_only_reason ? ` (${c.local_only_reason})` : ""}; bulutta başlatılamaz`);
    }
    if (!c.repo) {
      throw new Error(`proje ${c.slug} kartında bulut için \`repo: owner/name\` yok; bulutta başlatılamaz (yerel yol: ${c.path})`);
    }
    let integration: CloudLaunch["integration"] = null;
    let parent: Task | undefined;
    if (task.data.parent) {
      parent = getTask(task.data.parent);
      if (["done", "cancelled", "failed"].includes(parent.data.state)) {
        throw new Error(`çatı görev ${parent.data.id} ${parent.data.state}; fazı başlatılamaz`);
      }
      const integrationBranch = `vlad/${parent.data.id}`;
      // the parent's `branch` field is only a record; the remote decides whether the branch must be created
      const state = (o.remoteBranch ?? remoteBranchState)(c.repo, integrationBranch);
      if (state === "unknown") warnings.push(`${integrationBranch} remote'ta kontrol edilemedi (git ls-remote); yok sayılıp oluşturulacak`);
      integration = { branch: integrationBranch, needs_remote_create: state !== "exists", from: c.default_branch ?? "master" };
    }
    const base = integration ? integration.branch : c.default_branch ?? "master";
    res = {
      id, state: "running", mode: "cloud", action: "create_session",
      repo: c.repo, source_url: `https://github.com/${c.repo}`,
      source_revision: base, base_branch: base, outcome_branch: branch, branch, worktree: null,
      integration,
      model: role?.model ?? null,
      title: `VLAD ${id} — ${task.data.title}`,
      tags: ["vlad", `vlad-task:${id}`, `vlad-project:${c.slug}`],
      permission_mode: "auto",
      prompt: buildCloudPrompt(task, role, vladSession || undefined, parent),
      next: [
        ...(integration?.needs_remote_create ? [`${integration.branch} dalını remote'ta ${integration.from} üzerinden oluştur`] : []),
        "create_session(source_url, source_revision, outcome_branch, model, title, tags, permission_mode, prompt)",
        `vlad task session ${id} <session_id>`,
        "create_session başarısızsa: vlad task set " + id + " failed",
      ],
      warnings,
    };
  } catch (e) {
    const msg = (e as Error).message;
    const t = getTask(id);
    t.data.error = msg;
    saveTask(t);
    throw new Error(msg);
  }
  setState(id, "running", { branch, worktree: null, error: null });
  return res;
}
