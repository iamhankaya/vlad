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
}

function card(slug: string): ProjectCard {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return readDoc<ProjectCard>(file).data;
}

const PROTOCOL = (id: string, autonomy: string) => [
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
].join("\n");

function buildCloudPrompt(task: Task, role: { title: string; file: string; skills: string[] } | undefined): string {
  const parts: string[] = [
    `Sen bir VLAD çalışanısın (bulut). Görev ${task.data.id}: ${task.data.title}. Görev dosyasına erişimin yok; görev aşağıda satır içi verilmiştir.`,
  ];
  for (const h of ["## Tanım", "## Kabul kriterleri", "## Bağlam"]) {
    const s = getSection(task.body, h);
    if (s) parts.push(`${h}\n${s}`);
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
  parts.push(PROTOCOL(task.data.id, task.data.autonomy));
  return parts.join("\n\n");
}

/**
 * Cloud mode of `vlad task launch`: no local worktree or terminal. Validates the task and its
 * project card, builds the `create_session` arguments and moves the task to `running`. Any
 * failure leaves the task `queued` with `error` set.
 */
export function prepareCloudLaunch(id: string): CloudLaunch {
  const task = getTask(id);
  if (task.data.state !== "queued") throw new Error(`görev queued değil (${task.data.state}): ${id}`);
  if (task.data.kind !== "dev") throw new Error(`yalnızca dev görevleri başlatılır (kind=${task.data.kind}): ${id}`);

  const branch = `vlad/${id}`;
  let res: CloudLaunch;
  let integrationBranch: string | null = null;
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
    if (task.data.parent) {
      const parent = getTask(task.data.parent);
      if (["done", "cancelled", "failed"].includes(parent.data.state)) {
        throw new Error(`çatı görev ${parent.data.id} ${parent.data.state}; fazı başlatılamaz`);
      }
      integrationBranch = `vlad/${parent.data.id}`;
      integration = { branch: integrationBranch, needs_remote_create: parent.data.branch !== integrationBranch, from: c.default_branch ?? "master" };
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
      prompt: buildCloudPrompt(task, role),
      next: [
        ...(integration?.needs_remote_create ? [`${integration.branch} dalını remote'ta ${integration.from} üzerinden oluştur`] : []),
        "create_session(source_url, source_revision, outcome_branch, model, title, tags, permission_mode, prompt)",
        `vlad task session ${id} <session_id>`,
        "create_session başarısızsa: vlad task set " + id + " failed",
      ],
    };
  } catch (e) {
    const msg = (e as Error).message;
    const t = getTask(id);
    t.data.error = msg;
    saveTask(t);
    throw new Error(msg);
  }
  setState(id, "running", { branch, worktree: null, error: null });
  // VLAD creates the integration branch right after this call; recording it lets later phases skip the creation
  if (integrationBranch) {
    const p = getTask(task.data.parent as string);
    if (p.data.branch !== integrationBranch) {
      p.data.branch = integrationBranch;
      saveTask(p);
    }
  }
  return res;
}
