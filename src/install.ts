import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hasCommand = (entries: any[], command: string): boolean =>
  entries.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => h?.command === command));

/**
 * Returns a copy of Claude Code `settings` with `{ hooks: [{ type: "command", command }] }`
 * appended to `hooks.SessionEnd`. Unchanged if the command is already registered;
 * other hooks and fields are left as they are. The input is not mutated.
 */
export function mergeSessionEndHook(settings: any, command: string): any {
  const s = structuredClone(settings ?? {});
  if (s.hooks?.SessionEnd !== undefined && !Array.isArray(s.hooks.SessionEnd)) {
    throw new Error("settings.json: hooks.SessionEnd bir dizi değil; elle düzeltin");
  }
  const end: any[] = s.hooks?.SessionEnd ?? [];
  if (hasCommand(end, command)) return s;
  s.hooks = { ...(s.hooks ?? {}), SessionEnd: [...end, { hooks: [{ type: "command", command }] }] };
  return s;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local-time stamp for backup names: YYYYMMDDTHHmmss. */
function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface InstallOptions {
  home: string; // VLAD root (getVladHome())
  claudeDir: string; // usually ~/.claude
  dryRun: boolean;
  now?: Date;
}

/**
 * Installs VLAD's global pieces: the SessionEnd hook in `<claudeDir>/settings.json`
 * (backed up first as `settings.json.bak-<stamp>`) and the vlad-worker skill under
 * `<claudeDir>/skills/vlad-worker/`. With `dryRun`, only describes what it would do.
 */
export function installGlobal(o: InstallOptions): { actions: string[] } {
  const actions: string[] = [];
  const settingsPath = join(o.claudeDir, "settings.json");
  const command = `node "${join(o.home, "dist", "hooks", "session-report.js").replace(/\\/g, "/")}"`;
  const skillSrc = join(o.home, "global", "skills", "vlad-worker");
  const skillDst = join(o.claudeDir, "skills", "vlad-worker");

  if (!existsSync(join(skillSrc, "SKILL.md"))) throw new Error(`vlad-worker skill bulunamadı: ${skillSrc}`);

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

  actions.push(`Skill kopyala: ${skillSrc} -> ${skillDst}`);
  if (!o.dryRun) cpSync(skillSrc, skillDst, { recursive: true, force: true });

  return { actions };
}
