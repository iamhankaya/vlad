import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Claude Code's default SessionEnd hook timeout is 1.5 s; our hook can need ~6 s. */
export const HOOK_TIMEOUT_S = 10;

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
  const hooks = end.flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : [])).filter((h: any) => h?.command === command || isSessionReportHook(h?.command));
  const dead = (h: any) => h.command !== command && isDeadSessionReportHook(h.command);
  let found = false;
  for (const h of hooks) {
    if (dead(h)) continue; // ölü yollu girdi yaşayan birini yerine koymadıkça işe yaramaz: aşağıda yeniden yazılır/çoğaltılmaz
    found = true;
    if (typeof h.timeout !== "number" || h.timeout < HOOK_TIMEOUT_S) h.timeout = HOOK_TIMEOUT_S;
  }
  // Ölü yollu (artık var olmayan kök) session-report hook'ları: yaşayan hook yoksa ilki bu kökün komutuyla yeniden yazılır, kalanlar ve (yaşayan varsa) hepsi atılır.
  for (const e of end) {
    if (!Array.isArray(e?.hooks)) continue;
    e.hooks = e.hooks.filter((h: any) => {
      if (!(h?.command !== command && isSessionReportHook(h?.command) && isDeadSessionReportHook(h.command))) return true;
      if (found) return false;
      found = true; h.command = command; h.timeout = Math.max(typeof h.timeout === "number" ? h.timeout : 0, HOOK_TIMEOUT_S); return true;
    });
  }
  s.hooks && (s.hooks.SessionEnd = end.filter((e) => !Array.isArray(e?.hooks) || e.hooks.length));
  if (found) return s;
  s.hooks = { ...(s.hooks ?? {}), SessionEnd: [...end, { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }] };
  return s;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local-time stamp for backup names: YYYYMMDDTHHmmss. */
export function stamp(d: Date): string {
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

/** SessionEnd hook command for a VLAD root (shared by `vlad install` and `vlad setup`'s hooks part). */
/** Hook komutu hangi VLAD köküne işaret ederse etsin aynı hook sayılır (worktree'den kurulum ikinci hook eklemesin). */
export const isSessionReportHook = (command: unknown): boolean => typeof command === "string" && /\/dist\/hooks\/session-report\.js"$/.test(command.replace(/\\/g, "/"));
/** Hook komutundaki tırnaklı betik yolu (`node "<yol>"`); yoksa null. */
export const hookScriptPath = (command: string): string | null => /"([^"]+\/dist\/hooks\/session-report\.js)"$/.exec(command.replace(/\\/g, "/"))?.[1] ?? null;
/** session-report hook'u olup işaret ettiği betik artık yoksa (repo taşındı/silindi) true: SessionEnd sessizce ölür. */
export const isDeadSessionReportHook = (command: unknown): boolean => { const p = typeof command === "string" ? hookScriptPath(command) : null; return p !== null && !existsSync(p); };
export const hookCommand = (home: string): string => `node "${join(home, "dist", "hooks", "session-report.js").replace(/\\/g, "/")}"`;

/** Worker skills of `global/skills/*` (every dir with a SKILL.md). */
export function globalSkillNames(home: string): string[] {
  const dir = join(home, "global", "skills");
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "SKILL.md"))).map((d) => d.name) : [];
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
  const command = hookCommand(o.home);
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
  const names = globalSkillNames(o.home);
  for (const name of names) {
    const src = join(skillsSrc, name);
    const dst = join(o.claudeDir, "skills", name);
    actions.push(`Skill kopyala: ${src} -> ${dst}`);
    for (const f of changedInstalledFiles(src, dst)) actions.push(`Skill dosyası üzerine yazıldı (${name}): ${f}`);
    if (!o.dryRun) cpSync(src, dst, { recursive: true, force: true });
  }

  return { actions };
}
