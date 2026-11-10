// Etkileşimli sihirbaz (TTY): QUESTIONS sırasıyla sorar, cevapları `--answers` biçiminde döndürür. Sır sorulmaz (keys: generate/stdin).
import { loadConfig } from "../kb/config.js";
import { selfName } from "../fleet/state.js";
import { QUESTIONS } from "./questions.js";
import type { Question, SetupAnswers } from "./types.js";

export type Ask = (prompt: string, def?: string) => Promise<string>;

function setPath(o: Record<string, any>, path: string, v: unknown): void {
  const ks = path.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks[ks.length - 1]!] = v;
}
function coerce(q: Question, raw: string): unknown {
  switch (q.type) {
    case "number": return Number(raw);
    case "boolean": return /^(e|evet|y|yes|true)$/i.test(raw);
    case "list": return raw.split(",").map((s) => s.trim()).filter(Boolean);
    default: return raw;
  }
}
/** Mevcut (tracked + yerel katman) config'ten sihirbaz varsayılanları: Enter sahibin kurulumunu bozmaz. */
export interface WizardSeed { choices: Record<string, string>; machineName?: string; host?: string }
export function wizardSeed(vladHome: string): WizardSeed {
  let cfg;
  try { cfg = loadConfig(vladHome); } catch { return { choices: {} }; }
  const choices: Record<string, string> = {};
  if (cfg.launcher) choices.launcher = cfg.launcher;
  if (cfg.defaultAutonomy) choices.autonomy = cfg.defaultAutonomy;
  if (!cfg.machines?.length) return { choices };
  choices.machines = "multi";
  let self: string | undefined;
  try { self = selfName(); } catch { self = undefined; }
  const me = cfg.machines.find((m) => m.name === self);
  if (me) { choices.role = cfg.brain === me.name ? "brain" : "worker"; return { choices, machineName: me.name, host: me.agent?.host }; }
  return { choices };
}

/** Boş cevap = soruyu atla (varsayılan davranış/mevcut değer korunur); `seed` varsa varsayılanlar mevcut config'ten gelir. */
export async function interviewAnswers(ask: Ask, platform: string, seed: WizardSeed = { choices: {} }): Promise<SetupAnswers> {
  const out: Record<string, any> = { lang: "tr" };
  for (const q of QUESTIONS) {
    if (q.id === "lang" || q.id === "machine.agent") continue;
    if (q.id === "keys") { if (out.machines === "multi") out.keys = out.role === "worker" ? "stdin" : "generate"; continue; }
    if (/^(machine\.|keys)/.test(q.id) && out.machines !== "multi") continue;
    if (q.id === "role" && platform === "linux") { out.role = "worker"; continue; }
    const opts = q.choices ? ` [${q.choices.join("/")}]` : "";
    // Gerçek varsayılan yalnız choice tipinde ve geçerli bir seçenekse uygulanır/gösterilir; "hostname (küçük harf)" gibi sözde varsayılanlar parantezsiz.
    const seeded = seed.choices[q.id];
    const realDef = q.type === "choice" ? (seeded !== undefined && q.choices?.includes(seeded) ? seeded : q.default !== undefined && q.choices?.includes(q.default) ? q.default : undefined) : q.id === "machine.name" ? seed.machineName : undefined;
    const raw = (await ask(`${q.prompt}${opts}`, realDef)).trim();
    if (raw) setPath(out, q.id, coerce(q, raw));
    else if (realDef !== undefined) setPath(out, q.id, realDef);
  }
  if (out.machines === "multi") {
    const host = (await ask("Bu makinenin özel LAN adresi (Agent host)", seed.host ?? "")).trim() || (seed.host ?? "");
    if (host) setPath(out, "machine.agent.host", host);
  }
  // Dış etkili eylemler tek tek, açıkça sorulur (varsayılan hayır); onay yalnız bu oturum için geçerlidir.
  const need: [string, boolean][] = [
    ["kb-repo-create", out.kb?.mode === "github-new"], ["keygen", out.machines === "multi" && out.keys === "generate"], ["agent-install", out.agentboot === true],
    ["mac-main-install", out.mainsession === true], ["permissions-write", out.perms === true || out.claudedirs === true], ["plugins-write", (out.plugins ?? []).some((p: string) => p.includes("@"))],
  ];
  const confirm: string[] = [];
  for (const [id, wanted] of need) if (wanted && /^(e|evet|y|yes)$/i.test((await ask(`Onay: ${id} (dış etkili eylem; kullanıcı düzeyi ayar/GitHub/servis) — yapılsın mı? e/H`, "")).trim())) confirm.push(id);
  if (confirm.length) out.confirm = confirm;
  return out as SetupAnswers;
}
