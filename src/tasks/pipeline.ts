import { unlinkSync } from "node:fs";
import { createTask, type Task } from "./store.js";

type PhaseSpec = { phase: string; role: string; kind: "dev" | "research"; deps: string[] };

export type PipelineOpts = {
  project: string; title: string; cycle: string; body: string;
  ui?: boolean; prova?: boolean; skip?: string[]; skipReason?: string;
  /** phase name → full phase body (replaces the derived default). */
  phaseBodies?: Record<string, string>;
};
export type PipelineResult = { id: string; cycle: string; phases: { id: string; phase: string; role: string; kind: string; depends_on: string[] }[] };

const CYCLES = ["tam", "özellik", "kısa"];
const UI_SELF_CHECK = "Rapordan önce tarayıcıda (Chromium/Playwright) çalıştırıp ekran görüntüsüyle öz-kontrol yap.";
const PHASE_TASK: Record<string, string> = {
  spec: "Gereksinimleri ve sistem etkisini spec olarak yaz.",
  tasarım: "Kullanıcıya görünen arayüzü tasarla.",
  plan: "Spec'ten uygulama planını (sistem tasarımı, paylaşılan dosyalar) yaz.",
  sözleşme: "Tipleri, imzaları, şemayı ve sözleşme testlerini yaz (iş mantığı yok).",
  kabul: "Kabul (özellik döngüsünde karakterizasyon dahil) testlerini yaz; kırmızı başlar.",
  uygulama: "Kabul testlerini yeşile çevirecek uygulamayı yaz.",
  doğrulama: "Uygulamayı kabul kriterlerine karşı doğrula; hata avı yap.",
  denetim: "Çalışan arayüzü tasarım ve erişilebilirlik açısından denetle.",
  prova: "Dağıtım/altyapı değişikliğini temiz ortamda prova et.",
};

/** Cycle template (delegate skill §2): phases in creation order; deps only point at earlier phases. */
function template(cycle: string, ui: boolean, prova: boolean, skipContract: boolean): PhaseSpec[] {
  const p = (phase: string, role: string, kind: "dev" | "research", deps: string[]): PhaseSpec => ({ phase, role, kind, deps });
  const full = cycle === "tam", short = cycle === "kısa";
  const out: PhaseSpec[] = [];
  const design = ui && !short ? ["tasarım"] : [];
  if (!short) out.push(p("spec", "analyst", "research", []));
  if (design.length) out.push(p("tasarım", "designer", "dev", ["spec"]));
  if (full) out.push(p("plan", "architect", "research", ["spec", ...design]));
  const upstream = full ? ["plan", ...design] : short ? [] : ["spec", ...design];
  if (!short && !skipContract) out.push(p("sözleşme", "developer", "dev", upstream));
  const base = short ? [] : skipContract ? upstream : ["sözleşme"];
  if (!short) out.push(p("kabul", "tester", "dev", base));
  out.push(p("uygulama", "developer", "dev", base));
  if (prova) out.push(p("prova", "devops", "dev", ["uygulama"]));
  const verify = short ? ["uygulama"] : ["kabul", "uygulama"];
  out.push(p("doğrulama", "tester", "dev", verify));
  if (ui) out.push(p("denetim", "designer", "dev", verify));
  return out;
}

function section(body: string, heading: string): string {
  const m = new RegExp(`^${heading}[ \\t]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(body);
  return m ? m[1]!.trim() : "";
}

function defaultBody(spec: PhaseSpec, chatiId: string, chatiBody: string, ui: boolean): string {
  const tanim = section(chatiBody, "## Tanım");
  const kabul = section(chatiBody, "## Kabul kriterleri");
  const selfCheck = ui && spec.phase === "uygulama" ? `\n${UI_SELF_CHECK}` : "";
  return [
    "## Tanım", `${spec.phase} fazı: ${PHASE_TASK[spec.phase]}${selfCheck}`, "", "Çatı tanımı:", tanim, "",
    "## Kabul kriterleri",
    `- [ ] rolün (\`${spec.role}\`) \`## Çıktı\` bölümündeki başlıklarla kapanış raporu`,
    ...(kabul ? ["", "Çatı kabul kriterleri (bu faza düşenler):", kabul] : []), "",
    "## Bağlam", `Çatı: ${chatiId}. Girdi: bağımlı olduğun görevlerin \`## Kapanış raporu\`.`, "",
  ].join("\n");
}

/** Rollback seam: `step` wraps each createTask call (tests make one of them fail). */
export function createPipeline(o: PipelineOpts, now: Date = new Date(), step: <T>(create: () => T) => T = (c) => c()): PipelineResult {
  if (!CYCLES.includes(o.cycle)) throw new Error(`geçersiz döngü: ${o.cycle} (${CYCLES.join(" | ")})`);
  const skip = o.skip ?? [];
  for (const s of skip) if (s !== "sözleşme") throw new Error(`--skip yalnız sözleşme fazını atlar: ${s}`);
  const skipContract = skip.length > 0;
  if (skipContract && !o.skipReason?.trim()) throw new Error("--skip için --skip-reason (gerekçe) zorunlu");
  if (skipContract && o.cycle === "kısa") throw new Error("kısa döngüde sözleşme fazı yok; --skip gereksiz");
  const ui = !!o.ui;
  const specs = template(o.cycle, ui, !!o.prova, skipContract);
  for (const name of Object.keys(o.phaseBodies ?? {})) {
    if (!specs.some((s) => s.phase === name)) throw new Error(`faz yok: ${name} (bu pipeline'da: ${specs.map((s) => s.phase).join(", ")})`);
  }
  const created: Task[] = [];
  try {
    const skipNote = skipContract ? `\n\n### Atlanan fazlar\n- sözleşme atlandı: ${o.skipReason!.trim()}\n` : "";
    const chati = step(() => createTask({ project: o.project, title: o.title, kind: "pipeline", body: o.body.replace(/\s+$/, "") + skipNote }, now));
    created.push(chati);
    const ids = new Map<string, string>();
    const phases: PipelineResult["phases"] = [];
    for (const s of specs) {
      const body = o.phaseBodies?.[s.phase] ?? defaultBody(s, chati.data.id, o.body, ui);
      const depends_on = s.deps.map((d) => ids.get(d)!);
      const t = step(() => createTask({
        project: o.project, title: `${o.title} — ${s.phase}`, kind: s.kind, role: s.role, body,
        parent: chati.data.id, dependsOn: depends_on, phase: s.phase,
      }, now));
      created.push(t);
      ids.set(s.phase, t.data.id);
      phases.push({ id: t.data.id, phase: s.phase, role: s.role, kind: s.kind, depends_on });
    }
    return { id: chati.data.id, cycle: o.cycle, phases };
  } catch (e) {
    for (const t of created.reverse()) { try { unlinkSync(t.file); } catch { /* already gone */ } }
    throw e;
  }
}
