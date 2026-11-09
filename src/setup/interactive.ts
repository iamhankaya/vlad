// Etkileşimli sihirbaz (TTY): QUESTIONS sırasıyla sorar, cevapları `--answers` biçiminde döndürür. Sır sorulmaz (keys: generate/stdin).
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
/** Boş cevap = soruyu atla (varsayılan davranış/mevcut değer korunur). */
export async function interviewAnswers(ask: Ask, platform: string): Promise<SetupAnswers> {
  const out: Record<string, any> = { lang: "tr" };
  for (const q of QUESTIONS) {
    if (q.id === "lang" || q.id === "machine.agent") continue;
    if (q.id === "keys") { if (out.machines === "multi") out.keys = out.role === "worker" ? "stdin" : "generate"; continue; }
    if (/^(machine\.|keys)/.test(q.id) && out.machines !== "multi") continue;
    if (q.id === "role" && platform === "linux") { out.role = "worker"; continue; }
    const opts = q.choices ? ` [${q.choices.join("/")}]` : "";
    const raw = (await ask(`${q.prompt}${opts}`, q.default)).trim();
    if (raw) setPath(out, q.id, coerce(q, raw));
  }
  if (out.machines === "multi") {
    const host = (await ask("Bu makinenin özel LAN adresi (Agent host)", "")).trim();
    if (host) setPath(out, "machine.agent.host", host);
  }
  return out as SetupAnswers;
}
