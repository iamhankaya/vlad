// Dosya yazan parçalar (T20261110-05): cli, global-skills, repo-skills, hooks, permissions, plugins, config, kb.
// Kural: apply önce check koşar, ok ise yazmaz; kullanıcı ayarı silinmez/ezilmez (çakışan raporlanır); JSON değişimi yedekli.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOOK_TIMEOUT_S, globalSkillNames, hookCommand, mergeSessionEndHook } from "../install.js";
import { KB_GITIGNORE } from "../kb/commit.js";
import { LOCAL_CONFIG_FILE } from "../kb/config-layer.js";
import { loadConfig } from "../kb/config.js";
import { resolveKbDir } from "../kb/home.js";
import { compareDirs, compose, expandHome, newestMtime, readJsonFile, result, run, samePath, updateJson, upToDate, writeAtomic } from "./io.js";
import { buildOverlay } from "./overlay.js";
import type { ApplyAction, ApplyResult, ItemCheck, PartCheck, Requirement, SetupContext, SetupPart } from "./types.js";

const item = (id: string, status: ItemCheck["status"], evidence: string, fix?: string): ItemCheck => ({ id, status, evidence, ...(fix ? { fix } : {}) });
const settingsPath = (c: SetupContext) => join(c.claudeDir, "settings.json");
const safeSettings = (c: SetupContext): { ok: true; data: any; exists: boolean } | { ok: false; error: string } => {
  try { const r = readJsonFile(settingsPath(c)); return { ok: true, data: r.data, exists: r.exists }; } catch (e) { return { ok: false, error: (e as Error).message }; }
};
const bad = (part: PartCheck["part"], error: string): PartCheck => ({ part, status: "çakışan", severity: "error", evidence: error, fix: "settings.json'u elle düzelt (VLAD bozuk dosyaya yazmaz)" });

// ---- cli ----
export const cliPart: SetupPart = {
  id: "cli",
  async check(c) {
    const dist = join(c.vladHome, "dist", "cli.js");
    if (!existsSync(dist)) return compose("cli", [{ required: "zorunlu", item: item("cli:dist", "eksik", "dist/cli.js yok (SessionStart hook'u sessizce boş çalışır)", "npm i && npm run build") }]);
    const src = join(c.vladHome, "src");
    if (existsSync(src) && newestMtime(src) > statMtime(dist) + 1000) return compose("cli", [{ required: "zorunlu", item: item("cli:dist", "eski", "dist/cli.js src'den eski", "npm run build") }]);
    return compose("cli", [{ required: "zorunlu", item: item("cli:dist", "ok", "dist/cli.js var") }]);
  },
  async apply(c) { const k = await this.check(c); return k.status === "ok" ? upToDate("cli") : result("cli", [{ kind: "print", what: `derleme gerekli: ${k.fix}` }]); },
};
const statMtime = (f: string): number => { try { return statSync(f).mtimeMs; } catch { return 0; } };

// ---- global-skills ----
export const globalSkillsPart: SetupPart = {
  id: "global-skills",
  async check(c) {
    const names = globalSkillNames(c.vladHome);
    if (!names.length) return compose("global-skills", [{ required: "zorunlu", item: item("global-skills:vlad-worker", "eksik", `kaynak yok: ${join(c.vladHome, "global", "skills")}`) }]);
    return compose("global-skills", names.map((n) => {
      const st = compareDirs(join(c.vladHome, "global", "skills", n), join(c.claudeDir, "skills", n));
      return { required: "zorunlu" as const, item: item(`global-skills:${n}`, st, st === "ok" ? `${n} güncel` : `${n} ${st}`, "vlad setup --upgrade") };
    }));
  },
  async apply(c) {
    const k = await this.check(c);
    if (k.status === "ok") return upToDate("global-skills");
    const acts: ApplyAction[] = [], backups: string[] = [];
    for (const n of globalSkillNames(c.vladHome)) {
      const src = join(c.vladHome, "global", "skills", n), dst = join(c.claudeDir, "skills", n);
      const st = compareDirs(src, dst);
      if (st === "ok") continue;
      if (st === "eski" && !c.dryRun) { const bak = `${dst}.bak-${Date.now()}`; cpSync(dst, bak, { recursive: true }); backups.push(bak); acts.push({ kind: "backup", what: `yerel kopya yedeklendi`, target: bak }); }
      acts.push({ kind: "write", what: `skill kopyala: ${n}`, target: dst });
      if (!c.dryRun) cpSync(src, dst, { recursive: true, force: true });
    }
    return result("global-skills", acts, backups);
  },
  async uninstall(c) {
    const acts: ApplyAction[] = [];
    for (const n of globalSkillNames(c.vladHome)) { const d = join(c.claudeDir, "skills", n); if (existsSync(d)) { acts.push({ kind: "write", what: `skill sil: ${n}`, target: d }); if (!c.dryRun) rmSync(d, { recursive: true, force: true }); } }
    return result("global-skills", acts);
  },
};

// ---- repo-skills (designer'ın repo dışı 3 skill'i) ----
const DESIGNER = ["design-taste-frontend", "impeccable", "ui-ux-pro-max"];
export const repoSkillsPart: SetupPart = {
  id: "repo-skills",
  async check(c) {
    const repo = join(c.vladHome, ".claude", "skills");
    const core = existsSync(join(repo, "delegate", "SKILL.md"));
    const entries: { required: Requirement; item: ItemCheck }[] = [{ required: "zorunlu" as const, item: item("repo-skills:core", core ? "ok" : "eksik", core ? "VLAD repo skill'leri var" : ".claude/skills/delegate yok (repo eksik klon?)") }];
    for (const n of DESIGNER) {
      const st = compareDirs(join(repo, n), join(c.claudeDir, "skills", n));
      entries.push({ required: "isteğe bağlı" as const, item: item(`repo-skills:${n}`, st, `${n} ${st === "ok" ? "kurulu" : st}`, "vlad setup --only repo-skills") });
    }
    return compose("repo-skills", entries);
  },
  async apply(c) {
    const acts: ApplyAction[] = [];
    for (const n of DESIGNER) {
      const src = join(c.vladHome, ".claude", "skills", n), dst = join(c.claudeDir, "skills", n);
      if (!existsSync(src)) continue;
      const st = compareDirs(src, dst);
      if (st === "ok") continue;
      if (st === "eski") { acts.push({ kind: "skip", what: `${n}: yerel kopya farklı, dokunulmadı (--upgrade ile eşitlenir)`, target: dst }); continue; }
      acts.push({ kind: "write", what: `designer skill kopyala: ${n}`, target: dst });
      if (!c.dryRun) cpSync(src, dst, { recursive: true });
    }
    return acts.length ? result("repo-skills", acts) : upToDate("repo-skills");
  },
};

// ---- hooks ----
function sessionEndState(data: any, command: string): "ok" | "eksik" | "çakışan" {
  const hooks = (data?.hooks?.SessionEnd ?? []).flatMap((e: any) => (Array.isArray(e?.hooks) ? e.hooks : [])).filter((h: any) => h?.command === command);
  if (!hooks.length) return "eksik";
  return hooks.some((h: any) => typeof h.timeout === "number" && h.timeout >= HOOK_TIMEOUT_S) ? "ok" : "çakışan";
}
export const hooksPart: SetupPart = {
  id: "hooks",
  async check(c) {
    const s = safeSettings(c);
    if (!s.ok) return bad("hooks", s.error);
    const cmd = hookCommand(c.vladHome);
    const st = sessionEndState(s.data, cmd);
    const start = join(c.vladHome, ".claude", "settings.json");
    const startOk = existsSync(start) && readFileSync(start, "utf8").includes("status --summary --hook");
    const distOk = existsSync(join(c.vladHome, "dist", "hooks", "session-report.js"));
    return compose("hooks", [
      { required: "zorunlu", item: item("hooks:session-end", st, st === "ok" ? "SessionEnd hook kayıtlı" : st === "eksik" ? "SessionEnd hook yok" : `SessionEnd hook timeout<${HOOK_TIMEOUT_S} (dokunulmadı)`, "vlad setup --only hooks") },
      { required: "zorunlu", item: item("hooks:session-start", startOk ? "ok" : "eksik", startOk ? "SessionStart hook (repo) var" : ".claude/settings.json SessionStart yok") },
      { required: "zorunlu", item: item("hooks:dist", distOk ? "ok" : "eksik", distOk ? "dist/hooks/session-report.js var" : "dist/hooks/session-report.js yok", "npm run build") },
    ]);
  },
  async apply(c) {
    const s = safeSettings(c);
    if (!s.ok) throw new Error(s.error);
    const cmd = hookCommand(c.vladHome);
    const st = sessionEndState(s.data, cmd);
    if (st === "ok") return upToDate("hooks");
    if (st === "çakışan") return result("hooks", [{ kind: "skip", what: "SessionEnd hook'u farklı timeout ile kayıtlı: değiştirilmedi (çakışan)", target: settingsPath(c) }]);
    const r = updateJson(c, settingsPath(c), (d) => mergeSessionEndHook(d, cmd));
    return result("hooks", [{ kind: "write", what: `SessionEnd hook ekle: ${cmd}`, target: settingsPath(c) }], r.backup ? [r.backup] : []);
  },
  async uninstall(c) {
    const cmd = hookCommand(c.vladHome);
    const r = updateJson(c, settingsPath(c), (d) => {
      if (!Array.isArray(d?.hooks?.SessionEnd)) return d;
      d.hooks.SessionEnd = d.hooks.SessionEnd.map((e: any) => (Array.isArray(e?.hooks) ? { ...e, hooks: e.hooks.filter((h: any) => h?.command !== cmd) } : e)).filter((e: any) => !Array.isArray(e?.hooks) || e.hooks.length);
      return d;
    });
    return result("hooks", r.changed ? [{ kind: "write", what: "SessionEnd girişi kaldırıldı", target: settingsPath(c) }] : [{ kind: "skip", what: "kayıtlı değil" }], r.backup ? [r.backup] : []);
  },
};

// ---- permissions ----
/** vlad-worker skill'indeki en dar çalışan push/CI kalıpları; geniş kalıp (`Bash(*)`, `git push:*`) ASLA yazılmaz. */
export const WORKER_PERMISSIONS = [
  "Bash(git push origin vlad/*)", "Bash(git push -u origin vlad/*)", "Bash(gh run list *)", "Bash(gh run view *)", "Bash(gh run watch *)", "Bash(gh run rerun *)", "Bash(gh run download *)", "Bash(gh workflow run * --ref vlad/*)",
];
function kbOutside(c: SetupContext): string | null {
  const kb = resolveKbDir(c.vladHome).dir;
  return samePath(kb, join(c.vladHome, "kb")) || kb.startsWith(resolve(c.vladHome) + "/") ? null : kb;
}
export const permissionsPart: SetupPart = {
  id: "permissions",
  async check(c) {
    const s = safeSettings(c);
    if (!s.ok) return bad("permissions", s.error);
    const allow: string[] = s.data?.permissions?.allow ?? [];
    const miss = WORKER_PERMISSIONS.filter((p) => !allow.includes(p));
    const kb = kbOutside(c);
    const dirs: string[] = s.data?.permissions?.additionalDirectories ?? [];
    return compose("permissions", [
      { required: "isteğe bağlı", item: item("permissions:worker-push-ci", miss.length ? "eksik" : "ok", miss.length ? `${miss.length}/${WORKER_PERMISSIONS.length} çalışan push/CI kalıbı eksik` : "çalışan push/CI kalıpları var", "vlad setup --only permissions (onay ister)") },
      { required: "isteğe bağlı", item: kb ? item("permissions:additional-dirs", dirs.includes(kb) ? "ok" : "eksik", dirs.includes(kb) ? "kb additionalDirectories'te" : "kb additionalDirectories'te yok", "vlad setup --only permissions (onay ister)") : item("permissions:additional-dirs", "n/a", "kb VLAD_HOME içinde") },
    ]);
  },
  async apply(c) {
    const wantPerms = c.answers.perms === true, wantDirs = c.answers.claudedirs === true;
    if (!wantPerms && !wantDirs) return result("permissions", [{ kind: "skip", what: "perms/claudedirs seçilmedi" }], [], "seçilmedi");
    if (!c.confirmed.has("permissions-write")) return result("permissions", [{ kind: "skip", what: "settings.json izinleri açık onay ister (confirm: permissions-write)" }], [], "onay yok");
    const s = safeSettings(c);
    if (!s.ok) throw new Error(s.error);
    const kb = kbOutside(c);
    const r = updateJson(c, settingsPath(c), (d) => {
      d.permissions = d.permissions ?? {};
      if (wantPerms) d.permissions.allow = [...(d.permissions.allow ?? []), ...WORKER_PERMISSIONS.filter((p) => !(d.permissions.allow ?? []).includes(p))];
      if (wantDirs && kb) d.permissions.additionalDirectories = [...new Set([...(d.permissions.additionalDirectories ?? []), kb])];
      return d;
    });
    return r.changed ? result("permissions", [{ kind: "write", what: "izin kalıpları eklendi (var olanlar korundu)", target: settingsPath(c) }], r.backup ? [r.backup] : []) : upToDate("permissions");
  },
};

// ---- plugins ----
const PLUGIN_NAMES = ["superpowers", "frontend-design", "playwright"];
export const pluginsPart: SetupPart = {
  id: "plugins",
  async check(c) {
    const s = safeSettings(c);
    if (!s.ok) return bad("plugins", s.error);
    const en = Object.entries<boolean>(s.data?.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k);
    return compose("plugins", PLUGIN_NAMES.map((n) => {
      const on = en.some((k) => k === n || k.startsWith(`${n}@`));
      return { required: "isteğe bağlı" as const, item: item(`plugins:${n}`, on ? "ok" : "eksik", on ? `${n} etkin` : `${n} etkin değil`, `claude içinde /plugin ile kur: ${n}`) };
    }));
  },
  async apply(c) {
    const want = (c.answers.plugins ?? []).filter((p) => p.includes("@"));
    const acts: ApplyAction[] = (c.answers.plugins ?? []).filter((p) => !p.includes("@")).map((p) => ({ kind: "print" as const, what: `${p}: claude içinde /plugin ile kur (sihirbaz plugin kurmaz); tam kimlik (ad@market) verilirse etkinleştirilir` }));
    if (!want.length) return acts.length ? result("plugins", acts) : upToDate("plugins");
    const r = updateJson(c, settingsPath(c), (d) => { d.enabledPlugins = { ...(d.enabledPlugins ?? {}), ...Object.fromEntries(want.filter((p) => !(d.enabledPlugins ?? {})[p]).map((p) => [p, true])) }; return d; });
    if (r.changed) acts.push({ kind: "write", what: `enabledPlugins: ${want.join(", ")}`, target: settingsPath(c) });
    return result("plugins", acts, r.backup ? [r.backup] : []);
  },
};

// ---- config ----
const localPath = (c: SetupContext) => join(c.vladHome, LOCAL_CONFIG_FILE);
export const configPart: SetupPart = {
  id: "config",
  async check(c) {
    let evidence: string, status: ItemCheck["status"] = "ok";
    try { loadConfig(c.vladHome); evidence = existsSync(localPath(c)) ? "config + yerel katman geçerli" : "tracked config geçerli (yerel katman yok)"; } catch (e) { status = "çakışan"; evidence = (e as Error).message; }
    const entries: { required: Requirement; item: ItemCheck }[] = [{ required: "zorunlu" as const, item: item("config:valid", status, evidence, "vlad setup --only config") }];
    if (status === "ok") {
      const missing = loadConfig(c.vladHome).roots.map((r) => expandHome(r, c.home)).filter((r) => !existsSync(r));
      entries.push({ required: "isteğe bağlı" as const, item: item("config:roots", missing.length ? "eksik" : "ok", missing.length ? `roots yok: ${missing.join(", ")}` : "roots var", "vlad setup --only config") });
    }
    return compose("config", entries);
  },
  async apply(c) {
    const cur = readJsonFile(localPath(c));
    const tracked = readJsonFile(join(c.vladHome, "vlad.config.json")).data;
    const { overlay, conflicts } = buildOverlay(c, cur.data, tracked, cur.exists);
    return writeOverlay(c, overlay, conflicts);
  },
  async uninstall(c) {
    if (!existsSync(localPath(c))) return result("config", [{ kind: "skip", what: "yerel katman yok" }]);
    if (!c.dryRun) rmSync(localPath(c), { force: true });
    return result("config", [{ kind: "write", what: `${LOCAL_CONFIG_FILE} silindi`, target: localPath(c) }]);
  },
};

/** Yerel katmana birleştirir; çakışan (farklı mevcut) anahtar `--yes` olmadan ezilmez. Yazımdan sonra birleşim doğrulanır, geçersizse geri alınır. */
export function writeOverlay(c: SetupContext, overlay: Record<string, unknown>, conflicts: string[] = []): ApplyResult {
  const cur = readJsonFile(localPath(c));
  const blocked = conflicts.filter(() => !c.yes);
  const merged = { ...cur.data, ...Object.fromEntries(Object.entries(overlay).filter(([k]) => !blocked.includes(k))) };
  const acts: ApplyAction[] = blocked.map((k) => ({ kind: "skip" as const, what: `${k}: yerel katmandaki mevcut değer farklı, dokunulmadı (çakışan; --yes ile ezilir)` }));
  if (JSON.stringify(merged) === JSON.stringify(cur.data)) return acts.length ? result("config", acts) : upToDate("config");
  const wrote: ApplyAction = { kind: "write", what: `${LOCAL_CONFIG_FILE}: ${Object.keys(overlay).filter((k) => !blocked.includes(k)).join(", ")}`, target: localPath(c) };
  if (c.dryRun) return result("config", [...acts, wrote]);
  const bak = cur.exists ? `${localPath(c)}.bak-${Date.now()}` : undefined;
  if (bak) writeFileSync(bak, readFileSync(localPath(c)));
  writeAtomic(localPath(c), JSON.stringify(merged, null, 2) + "\n");
  try { loadConfig(c.vladHome); } catch (e) {
    if (bak) writeAtomic(localPath(c), readFileSync(bak, "utf8")); else rmSync(localPath(c), { force: true });
    throw new Error(`yerel config geçersiz, geri alındı: ${(e as Error).message}`);
  }
  return result("config", [...acts, wrote], bak ? [bak] : []);
}

// ---- kb ----
export function kbTarget(c: SetupContext): string {
  const d = c.answers.kb?.dir;
  return d ? resolve(c.vladHome, expandHome(d, c.home)) : resolveKbDir(c.vladHome).dir;
}
const isGitRepo = (d: string) => existsSync(join(d, ".git"));
function ensureIgnores(dir: string, dry: boolean): string[] {
  const f = join(dir, ".gitignore");
  const have = new Set((existsSync(f) ? readFileSync(f, "utf8") : "").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")));
  const miss = KB_GITIGNORE.filter((l) => !have.has(l));
  if (miss.length && !dry) { mkdirSync(dir, { recursive: true }); const cur = existsSync(f) ? readFileSync(f, "utf8") : ""; writeFileSync(f, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + miss.join("\n") + "\n"); }
  return miss;
}
export const kbPart: SetupPart = {
  id: "kb",
  async check(c) {
    const dir = kbTarget(c);
    if (!existsSync(dir)) return compose("kb", [{ required: "zorunlu", item: item("kb:repo", "eksik", `kb dizini yok: ${dir}`, "vlad setup --only kb") }]);
    if (!isGitRepo(dir)) return compose("kb", [{ required: "zorunlu", item: item("kb:repo", "eksik", `kb git deposu değil: ${dir}`, "vlad setup --only kb") }]);
    const f = join(dir, ".gitignore");
    const have = new Set((existsSync(f) ? readFileSync(f, "utf8") : "").split(/\r?\n/).map((l) => l.trim().replace(/^\//, "")));
    const miss = KB_GITIGNORE.filter((l) => !have.has(l));
    const dirty = run("git", ["status", "--porcelain"], { cwd: dir });
    const note = dirty.ok && dirty.stdout.trim() ? " (kirli kb: beyin devrinde commit/atma gerekir, F-vlad-196)" : "";
    return compose("kb", [{ required: "zorunlu", item: item("kb:repo", miss.length ? "eksik" : "ok", miss.length ? `kb .gitignore eksik satırlar: ${miss.join(", ")}` : `kb deposu hazır${note}`, "vlad setup --only kb") }]);
  },
  async apply(c) {
    const kb = c.answers.kb ?? {};
    const mode = kb.mode ?? "local";
    const dir = kbTarget(c);
    const acts: ApplyAction[] = [];
    if (!existsSync(dir) || !isGitRepo(dir)) {
      if (mode === "existing") {
        const probe = run("git", ["ls-remote", `https://github.com/${kb.remote}`]);
        if (!probe.ok) throw new Error(`kb.remote erişilemiyor (${kb.remote}); hiçbir şey yazılmadı`);
        acts.push({ kind: "run", what: `git clone ${kb.remote} -> ${dir}` });
        if (!c.dryRun) { const r = run("git", ["clone", `https://github.com/${kb.remote}`, dir], { timeoutMs: 120_000 }); if (!r.ok) throw new Error(`git clone başarısız: ${r.stderr.trim()}`); }
      } else if (mode === "github-new") {
        if (!c.confirmed.has("kb-repo-create")) return result("kb", [{ kind: "skip", what: "GitHub repo oluşturma açık onay ister (confirm: kb-repo-create)" }], [], "onay yok");
        acts.push({ kind: "run", what: `gh repo create ${kb.remote} --private` });
        if (!c.dryRun) {
          const r = run("gh", ["repo", "create", kb.remote!, "--private"]);
          if (!r.ok) throw new Error(`gh repo create başarısız: ${r.stderr.trim()}`);
          mkdirSync(dir, { recursive: true });
          run("git", ["init"], { cwd: dir });
          run("git", ["remote", "add", "origin", `https://github.com/${kb.remote}.git`], { cwd: dir });
        }
        acts.push({ kind: "print", what: "ilk push ayrı onay ister: cd <kb> && git push -u origin HEAD" });
      } else if (mode === "path") {
        if (!existsSync(dir)) throw new Error(`kb.dir yok: ${dir}`);
        throw new Error(`kb.dir git deposu değil: ${dir}`);
      } else {
        acts.push({ kind: "run", what: `git init ${dir}` });
        if (!c.dryRun) { mkdirSync(dir, { recursive: true }); const r = run("git", ["init"], { cwd: dir }); if (!r.ok) throw new Error(`git init başarısız: ${r.stderr.trim()}`); }
      }
    }
    if (c.dryRun ? existsSync(dir) : true) { const miss = ensureIgnores(dir, c.dryRun); if (miss.length) acts.push({ kind: "write", what: `.gitignore: ${miss.join(", ")}`, target: join(dir, ".gitignore") }); }
    return acts.length ? result("kb", acts) : upToDate("kb");
  },
};

