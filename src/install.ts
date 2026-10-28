import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Claude Code's default SessionEnd hook timeout is 1.5 s; our hook can need ~6 s. */
const HOOK_TIMEOUT_S = 10;

/**
 * Returns a copy of Claude Code `settings` with `{ hooks: [{ type: "command", command, timeout: 10 }] }`
 * appended to `hooks.SessionEnd`. If the command is already registered, only a missing or too
 * small timeout is raised to 10; other hooks and fields are left as they are. The input is not mutated.
 */
export function mergeSessionEndHook(settings: any, command: string): any {
  const s = structuredClone(settings ?? {});
  if (s.hooks?.SessionEnd !== undefined && !Array.isArray(s.hooks.SessionEnd)) {
    throw new Error("settings.json: hooks.SessionEnd bir dizi değil; elle düzeltin");
  }
  const end: any[] = s.hooks?.SessionEnd ?? [];
  let found = false;
  for (const e of end) {
    if (!Array.isArray(e?.hooks)) continue;
    for (const h of e.hooks) {
      if (h?.command !== command) continue;
      found = true;
      if (typeof h.timeout !== "number" || h.timeout < HOOK_TIMEOUT_S) h.timeout = HOOK_TIMEOUT_S;
    }
  }
  if (found) return s;
  s.hooks = { ...(s.hooks ?? {}), SessionEnd: [...end, { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }] };
  return s;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local-time stamp for backup names: YYYYMMDDTHHmmss. */
function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Files of `src` (relative) that exist in `dst` with different content: a copy would overwrite a local edit. */
function changedInstalledFiles(src: string, dst: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(src, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...changedInstalledFiles(src, dst, r));
    else if (existsSync(join(dst, r)) && !readFileSync(join(src, r)).equals(readFileSync(join(dst, r)))) out.push(r);
  }
  return out;
}

export interface InstallOptions {
  home: string; // VLAD root (getVladHome())
  claudeDir: string; // usually ~/.claude
  dryRun: boolean;
  now?: Date;
}

/**
 * Installs VLAD's global pieces: the SessionEnd hook in `<claudeDir>/settings.json`
 * (backed up first as `settings.json.bak-<stamp>`) and every worker skill of `global/skills/*` (vlad-worker is required)
 * under `<claudeDir>/skills/<name>/`. With `dryRun`, only describes what it would do.
 */
export function installGlobal(o: InstallOptions): { actions: string[] } {
  const actions: string[] = [];
  const settingsPath = join(o.claudeDir, "settings.json");
  const command = `node "${join(o.home, "dist", "hooks", "session-report.js").replace(/\\/g, "/")}"`;
  const skillsSrc = join(o.home, "global", "skills");
  const workerSrc = join(skillsSrc, "vlad-worker");

  if (!existsSync(join(workerSrc, "SKILL.md"))) throw new Error(`vlad-worker skill bulunamadı: ${workerSrc}`);

  const exists = existsSync(settingsPath);
  let current: any = {};
  if (exists) {
    try {
      current = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (e) {
      throw new Error(`${settingsPath} geçerli JSON değil: ${(e as Error).message}`);
    }
  }
  const merged = mergeSessionEndHook(current, command);
  const changed = JSON.stringify(merged) !== JSON.stringify(current);

  if (!changed) {
    actions.push(`SessionEnd hook zaten kayıtlı: ${command}`);
  } else {
    if (exists) {
      const bak = `${settingsPath}.bak-${stamp(o.now ?? new Date())}`;
      actions.push(`Yedek: ${settingsPath} -> ${bak}`);
      if (!o.dryRun) copyFileSync(settingsPath, bak);
    } else {
      actions.push(`Oluştur: ${settingsPath}`);
    }
    actions.push(`SessionEnd hook ekle: ${command}`);
    if (!o.dryRun) {
      mkdirSync(o.claudeDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    }
  }

  // every dir with a SKILL.md is a worker skill (vlad-worker, ci-triage, …)
  const names = readdirSync(skillsSrc, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skillsSrc, d.name, "SKILL.md")))
    .map((d) => d.name);
  for (const name of names) {
    const src = join(skillsSrc, name);
    const dst = join(o.claudeDir, "skills", name);
    actions.push(`Skill kopyala: ${src} -> ${dst}`);
    for (const f of changedInstalledFiles(src, dst)) actions.push(`Skill dosyası üzerine yazıldı (${name}): ${f}`);
    if (!o.dryRun) cpSync(src, dst, { recursive: true, force: true });
  }

  return { actions };
}
