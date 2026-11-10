// Soru şeması + --answers doğrulayıcısı (T20261110-03 sözleşmesi). Saf: dosya/ağ/çevre yok. Hata metni cevap DEĞERİNİ içermez (sır sızmasın).
import { PRIVATE_V4 } from "../fleet/state.js";
import { autoCompactTokens, checkWorktreeDir } from "../kb/config.js";
import { CONFIRM_ACTIONS, type AnswerValidation, type Question, type SetupAnswers, type ValidateOptions } from "./types.js";

export const QUESTIONS: readonly Question[] = [
  { id: "role", prompt: "Bu makine beyin mi, işçi mi?", type: "choice", choices: ["brain", "worker"], default: "brain", writes: "config-local" },
  { id: "machines", prompt: "Tek makine mi, çok makine mi?", type: "choice", choices: ["single", "multi"], default: "single", writes: "config-local" },
  { id: "machine.name", prompt: "Bu makinenin adı", type: "text", default: "hostname (küçük harf)", writes: "local-json" },
  { id: "machine.agent", prompt: "Agent adresi/portu (özel adres zorunlu)", type: "text", default: "port 7437", writes: "config-local" },
  { id: "keys", prompt: "Çift anahtar", type: "secret", choices: ["generate", "stdin"], default: "generate", writes: "local-json" },
  { id: "kb.mode", prompt: "kb nerede?", type: "choice", choices: ["local", "github-new", "existing", "path"], default: "local", writes: "config-local" },
  { id: "kb.dir", prompt: "kbDir yolu", type: "text", default: "<VLAD_HOME>/../vlad-kb", writes: "config-local" },
  { id: "kb.remote", prompt: "kb GitHub private repo (owner/name)", type: "text", writes: "config-local" },
  { id: "kb.push", prompt: "`vlad kb commit --push` otomasyonu", type: "boolean", default: "remote varsa evet", writes: "kb" },
  { id: "cloud.kb", prompt: "Bulut çalışanı kb erişimi", type: "choice", choices: ["inline", "readonly"], default: "inline", writes: "config-local" },
  { id: "roots", prompt: "Proje kök klasörleri", type: "list", default: "~/dev varsa o", writes: "config-local" },
  { id: "worktreeDir", prompt: "Worktree kalıbı", type: "text", default: "{repo}-wt", writes: "config-local" },
  { id: "ignore", prompt: "Taramada yok sayılacaklar", type: "list", default: "*-wt, node_modules", writes: "config-local" },
  { id: "models.main", prompt: "Ana VLAD oturumu modeli", type: "choice", choices: ["haiku", "sonnet", "opus"], writes: "claude-settings", neverOverwrite: true },
  { id: "models.roles", prompt: "Rol varsayılan modeli", type: "choice", choices: ["haiku", "sonnet", "opus"], default: "sonnet", writes: "config-local" },
  { id: "models.research", prompt: "Research agent modeli", type: "choice", choices: ["haiku", "sonnet", "opus"], default: "rolün modeli", writes: "none" },
  { id: "ctx.worker", prompt: "Çalışan autocompact (workerAutoCompact)", type: "text", default: "boş", writes: "config-local" },
  { id: "ctx.main", prompt: "Ana oturum autocompact penceresi", type: "text", writes: "claude-settings", neverOverwrite: true },
  { id: "limits.maxParallel", prompt: "Aynı anda en çok çalışan", type: "number", default: "sınırsız", writes: "config-local" },
  { id: "launcher", prompt: "Çalışan başlatıcı", type: "choice", choices: ["auto", "wt", "powershell", "tmux", "terminal", "cloud"], default: "auto", writes: "config-local" },
  { id: "autonomy", prompt: "Varsayılan yetki", type: "choice", choices: ["plan", "commit", "pr"], default: "commit", writes: "config-local" },
  { id: "experiments.ponytail", prompt: "ponytail A/B deneyi", type: "choice", choices: ["ab"], default: "kapalı", writes: "config-local" },
  { id: "plugins", prompt: "Plugin'ler", type: "list", default: "superpowers, frontend-design, playwright", writes: "claude-settings" },
  { id: "perms", prompt: "Çalışan push/CI izinleri", type: "boolean", default: "autonomy=pr kullanılacaksa evet", writes: "claude-settings" },
  { id: "claudedirs", prompt: "additionalDirectories (kb + vlad)", type: "boolean", default: "kb VLAD_HOME dışındaysa evet", writes: "claude-settings" },
  { id: "mainsession", prompt: "Ana oturum otomatik açılış (Mac beyin)", type: "boolean", default: "hayır", writes: "script" },
  { id: "agentboot", prompt: "Agent oturum açılışında başlasın", type: "boolean", default: "çok makinede evet", writes: "script" },
  { id: "digest.daily", prompt: "Günlük digest güvenlik ağı (Mac beyin)", type: "boolean", default: "hayır", writes: "none" },
  { id: "lang", prompt: "Dil", type: "choice", choices: ["tr"], default: "tr", writes: "none" },
];

const ROLES = ["brain", "worker"], MACHINES = ["single", "multi"], KB_MODES = ["local", "github-new", "existing", "path"], MODELS = ["haiku", "sonnet", "opus"];
const LAUNCHERS = ["auto", "wt", "powershell", "tmux", "terminal", "cloud"], AUTONOMY = ["plan", "commit", "pr"];
const NAME = /^[a-z][a-z0-9-]*$/, HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/, REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Şekil + çapraz kural doğrulaması; ilk hatada durmaz, hepsini yol ile listeler. Cevap değeri mesaja girmez. */
export function validateAnswers(raw: unknown, opts: ValidateOptions): AnswerValidation {
  if (!isObj(raw)) return { ok: false, errors: ["answers: nesne olmalı"] };
  const errors: string[] = [];
  const e = (p: string, m: string) => errors.push(`${p}: ${m}`);
  const known = (o: Record<string, unknown>, keys: string[], path: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) e(path ? `${path}.${k}` : k, "bilinmeyen anahtar"); };
  const sub = (k: string, keys: string[]): Record<string, unknown> | undefined => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (!isObj(v)) { e(k, "nesne olmalı"); return undefined; }
    known(v, keys, k);
    return v;
  };
  const oneOf = (v: unknown, set: readonly string[], p: string) => { if (v !== undefined && !set.includes(v as string)) e(p, `şunlardan biri olmalı: ${set.join("|")}`); };
  const bool = (v: unknown, p: string) => { if (v !== undefined && typeof v !== "boolean") e(p, "boolean olmalı"); };
  const strList = (v: unknown, p: string) => { if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string" && x))) e(p, "boş olmayan metin listesi olmalı"); };

  known(raw, ["role", "machines", "machine", "keys", "kb", "cloud", "roots", "worktreeDir", "ignore", "models", "ctx", "limits", "launcher", "autonomy", "experiments", "plugins", "perms", "claudedirs", "mainsession", "agentboot", "digest", "lang", "confirm", "fresh"], "");
  oneOf(raw.role, ROLES, "role");
  oneOf(raw.machines, MACHINES, "machines");
  if (raw.keys !== undefined && raw.keys !== "generate" && raw.keys !== "stdin") e("keys", "yalnız 'generate' ya da 'stdin' (anahtar değeri cevap dosyasına konmaz)");
  oneOf(raw.launcher, LAUNCHERS, "launcher");
  oneOf(raw.autonomy, AUTONOMY, "autonomy");
  oneOf(raw.lang, ["tr"], "lang");
  strList(raw.roots, "roots"); strList(raw.ignore, "ignore"); strList(raw.plugins, "plugins");
  bool(raw.fresh, "fresh"); bool(raw.perms, "perms"); bool(raw.claudedirs, "claudedirs"); bool(raw.mainsession, "mainsession"); bool(raw.agentboot, "agentboot");
  if (typeof raw.worktreeDir === "string") { try { checkWorktreeDir(raw.worktreeDir, "worktreeDir"); } catch { e("worktreeDir", "{repo} tam repo yoludur; önüne yol koyma"); } }
  else if (raw.worktreeDir !== undefined) e("worktreeDir", "metin olmalı");

  const machine = sub("machine", ["name", "agent"]);
  if (machine) {
    if (machine.name !== undefined && !(typeof machine.name === "string" && NAME.test(machine.name))) e("machine.name", "^[a-z][a-z0-9-]*$ olmalı");
    if (machine.agent !== undefined) {
      if (!isObj(machine.agent)) e("machine.agent", "nesne olmalı");
      else {
        known(machine.agent, ["host", "port", "bind"], "machine.agent");
        for (const k of ["host", "bind"] as const) {
          const h = machine.agent[k];
          if (h === undefined) continue;
          if (typeof h !== "string" || !HOST.test(h)) e(`machine.agent.${k}`, "geçerli host/IP olmalı");
          else if (k === "host" && !IPV4.test(h)) e("machine.agent.host", "özel ağ IPv4 adresi olmalı (ad/hostname kabul edilmez)");
          else if (IPV4.test(h) && !PRIVATE_V4.some((r) => r.test(h))) e(`machine.agent.${k}`, "genel adres reddedilir (yalnız loopback/RFC1918/link-local)");
        }
        const p = machine.agent.port;
        if (p !== undefined && !(Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535)) e("machine.agent.port", "1024-65535 tamsayı olmalı");
      }
    }
  }
  const kb = sub("kb", ["mode", "dir", "remote", "push"]);
  if (kb) {
    oneOf(kb.mode, KB_MODES, "kb.mode");
    if (kb.remote !== undefined && !(typeof kb.remote === "string" && REPO.test(kb.remote) && !kb.remote.includes(".."))) e("kb.remote", "owner/name olmalı");
    if (kb.dir !== undefined && !(typeof kb.dir === "string" && kb.dir)) e("kb.dir", "boş olmayan yol olmalı");
    bool(kb.push, "kb.push");
    if ((kb.mode === "github-new" || kb.mode === "existing") && kb.remote === undefined) e("kb.remote", `kb.mode=${kb.mode} için zorunlu`);
    if (kb.mode === "local" && kb.remote !== undefined) e("kb.remote", "kb.mode=local uzak depo almaz");
    if (kb.mode === "path" && kb.dir === undefined) e("kb.dir", "kb.mode=path için zorunlu");
    if (kb.push === true && kb.remote === undefined) e("kb.push", "uzak depo (kb.remote) olmadan push açılamaz");
  }
  const cloud = sub("cloud", ["kb"]);
  if (cloud) {
    oneOf(cloud.kb, ["inline", "readonly"], "cloud.kb");
    if (cloud.kb === "readonly" && !(kb && kb.remote !== undefined)) e("cloud.kb", "readonly için kb.remote zorunlu");
  }
  const models = sub("models", ["main", "roles", "research"]);
  if (models) for (const k of ["main", "roles", "research"]) oneOf(models[k], MODELS, `models.${k}`);
  const ctx = sub("ctx", ["worker", "main"]);
  if (ctx) {
    if (ctx.worker !== undefined) {
      const n = typeof ctx.worker === "string" ? autoCompactTokens(ctx.worker) : NaN;
      if (!(n >= 100000 && n <= 1000000)) e("ctx.worker", "100000–1000000 aralığında olmalı (k/M eki olabilir)");
    }
    if (ctx.main !== undefined && typeof ctx.main !== "string") e("ctx.main", "metin olmalı");
  }
  const limits = sub("limits", ["maxParallel"]);
  if (limits && limits.maxParallel !== undefined && !(Number.isInteger(limits.maxParallel) && (limits.maxParallel as number) >= 1)) e("limits.maxParallel", ">=1 tamsayı olmalı");
  const exp = sub("experiments", ["ponytail"]);
  if (exp) oneOf(exp.ponytail, ["ab"], "experiments.ponytail");
  const digest = sub("digest", ["daily"]);
  if (digest) bool(digest.daily, "digest.daily");
  if (raw.confirm !== undefined) {
    if (!Array.isArray(raw.confirm) || raw.confirm.some((c) => !(CONFIRM_ACTIONS as readonly string[]).includes(c as string))) e("confirm", `yalnız şunlar: ${CONFIRM_ACTIONS.join("|")}`);
  }

  // çapraz kurallar
  const multi = raw.machines === "multi";
  if (multi && !(machine && machine.name !== undefined)) e("machine.name", "machines=multi için zorunlu");
  if (raw.role === "worker" && raw.machines !== "multi") e("role", "worker yalnız machines=multi ile (işçi beyne bağlanır)");
  if (opts.platform === "linux" && raw.role === "brain") e("role", "linux'ta beyin desteklenmiyor (Linux yalnız işçi olarak, deneysel)");

  return errors.length ? { ok: false, errors } : { ok: true, answers: raw as SetupAnswers };
}
