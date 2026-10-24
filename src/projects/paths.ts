import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { currentMachine, kbPaths, loadConfig, MACHINE_NAME, readDoc, validate, writeDoc } from "../kb/index.js";
import type { ProjectCard } from "../kb/index.js";

function readCard(slug: string): { data: ProjectCard; body: string; file: string } {
  const file = join(kbPaths().projects, `${slug}.md`);
  if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(file)) throw new Error(`proje kartı bulunamadı: ${slug}`);
  return { ...readDoc<ProjectCard>(file), file };
}

export function getProjectCard(slug: string): ProjectCard {
  return readCard(slug).data;
}

function checkMachine(name: string): void {
  if (!MACHINE_NAME.test(name)) throw new Error(`geçersiz makine adı: "${name}" (yalnızca harf, rakam, . _ -)`);
}

/**
 * The `paths` map after `machine` gets `path`. The first entry also has to say which machine the card's
 * existing `path` belongs to (`keep`): once `paths` is set it is authoritative, so dropping that machine
 * silently would strand it without a clone.
 */
function nextPaths(card: ProjectCard, machine: string, path: string, keep?: string): Record<string, string> {
  checkMachine(machine);
  const paths = { ...card.paths };
  if (Object.keys(paths).length === 0 && card.path) {
    if (!keep) {
      throw new Error(
        `${card.slug}: ilk makine kaydı; mevcut path (${card.path}) hangi makineye ait? --keep <makine> ile adını ver`,
      );
    }
    checkMachine(keep);
    paths[keep] = card.path;
  }
  paths[machine] = path;
  return paths;
}

function writePaths(slug: string, paths: Record<string, string>): ProjectCard {
  const { data, body, file } = readCard(slug);
  const next = { ...data, paths };
  validate("project", next);
  writeDoc(file, next, body);
  return next;
}

/** Records the clone path of `slug` on `machine`; `path` stays as it is (Windows VLAD's own). */
export function setProjectPath(slug: string, machine: string, path: string, keep?: string): ProjectCard {
  if (!path.trim()) throw new Error("yol boş olamaz");
  return writePaths(slug, nextPaths(readCard(slug).data, machine, path.trim(), keep));
}

/** `owner/name` → GitHub clone URL. */
function remoteUrl(card: ProjectCard, from?: string): string {
  if (from) return from;
  if (!card.repo) throw new Error(`${card.slug}: kartta repo yok ve --from verilmedi`);
  return `https://github.com/${card.repo}.git`;
}

/**
 * Clones the project onto this machine (default `<roots[0]>/<slug>`) and records the path. The card is
 * only written after a successful clone; a clone that fails leaves it untouched.
 */
export function cloneProject(
  slug: string,
  o: { machine?: string; from?: string; to?: string; keep?: string } = {},
): { slug: string; machine: string; path: string; from: string } {
  const machine = o.machine ?? currentMachine();
  const card = readCard(slug).data;
  const existing = card.paths?.[machine];
  if (existing && existsSync(existing)) throw new Error(`bu makinede klon zaten var: ${existing}`);
  const from = remoteUrl(card, o.from);
  const root = loadConfig().roots[0];
  const to = o.to ?? (root ? join(root, slug) : undefined);
  if (!to) throw new Error("hedef klasör belirsiz: --to ver ya da config roots doldur");
  if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`hedef klasör zaten var ve boş değil: ${to}`);
  const paths = nextPaths(card, machine, to, o.keep);
  try {
    execFileSync("git", ["clone", "--", from, to], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 600_000, windowsHide: true });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git clone başarısız (${from}): ${(err.stderr || err.message).trim()}`);
  }
  writePaths(slug, paths);
  return { slug, machine, path: to, from };
}
