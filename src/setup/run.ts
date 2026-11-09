// `vlad setup` orkestrasyonu (T20261110-05): check / apply / upgrade / uninstall / join / add-worker. CLI yalnız bu modülü çağırır.
import { homedir } from "node:os";
import { join } from "node:path";
import { agentKeygen, agentSetKey } from "../agent/start.js";
import { PRIVATE_V4, readLocal, writeLocal } from "../fleet/state.js";
import { loadConfig } from "../kb/config.js";
import { exitCodeFor } from "./check.js";
import { readJsonFile } from "./io.js";
import { PARTS, partById } from "./parts.js";
import { writeOverlay } from "./parts-files.js";
import type { MachineEntry } from "./overlay.js";
import { PART_IDS, type ApplyResult, type ConfirmAction, type PartCheck, type PartId, type SetupAnswers, type SetupCheckResult, type SetupContext } from "./types.js";

export interface ContextOptions { vladHome: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; answers?: SetupAnswers; dryRun?: boolean; yes?: boolean; home?: string }
export function buildContext(o: ContextOptions): SetupContext {
  const home = o.home ?? homedir();
  const answers = o.answers ?? {};
  return {
    platform: (o.platform ?? process.platform) as SetupContext["platform"], home, claudeDir: o.env.VLAD_CLAUDE_DIR || join(home, ".claude"), vladHome: o.vladHome,
    answers, dryRun: !!o.dryRun, yes: !!o.yes, confirmed: new Set<ConfirmAction>(answers.confirm ?? []),
  };
}
export function parseOnly(s: string | undefined): PartId[] | undefined {
  if (!s) return undefined;
  const ids = s.split(",").map((x) => x.trim()).filter(Boolean);
  const bad = ids.filter((i) => !(PART_IDS as readonly string[]).includes(i));
  if (bad.length) throw new Error(`bilinmeyen parça: ${bad.join(", ")} (geçerli: ${PART_IDS.join(", ")})`);
  return ids as PartId[];
}
const pick = (only?: PartId[]) => PARTS.filter((p) => !only || only.includes(p.id));

export async function runCheck(c: SetupContext, o: { only?: PartId[]; strict?: boolean } = {}): Promise<SetupCheckResult> {
  const parts: PartCheck[] = [];
  for (const p of pick(o.only)) {
    try { parts.push(await p.check(c)); } catch (e) { parts.push({ part: p.id, status: "çakışan", severity: "error", evidence: `kontrol başarısız: ${(e as Error).message}` }); }
  }
  const strict = !!o.strict, exit = exitCodeFor(parts, strict);
  let role: "brain" | "worker" | undefined;
  try { const cfg = loadConfig(c.vladHome); const self = process.env.VLAD_MACHINE || readLocal().self; if (cfg.machines && self) role = self === cfg.brain ? "brain" : "worker"; else if (!cfg.machines) role = "brain"; } catch { /* config parçası bildirir */ }
  return {
    version: 1, platform: c.platform, ...(role ? { role } : {}), strict, exit, ok: exit === 0,
    ...(c.platform === "linux" ? { experimental: ["Linux: işçi deneysel, beyin desteklenmez; Agent oto-başlatma/bildirim/pano/menü yok (n/a)"] } : {}),
    parts,
  };
}

export async function runSetup(c: SetupContext, o: { only?: PartId[] } = {}): Promise<ApplyResult[]> {
  const out: ApplyResult[] = [];
  readJsonFile(join(c.claudeDir, "settings.json")); // bozuksa hiçbir parça yazmadan dur (hata mesajı dosya yolunu içerir)
  for (const p of pick(o.only)) out.push(await p.apply(c));
  return out;
}

/** git pull sonrası eşitleme: build bilgisi, global skill'ler (yerel fark yedeklenir), hook yolu. Hiç kb yazımı yok. */
export async function runUpgrade(c: SetupContext): Promise<ApplyResult[]> {
  const out: ApplyResult[] = [];
  for (const id of ["cli", "global-skills", "hooks"] as PartId[]) out.push(await partById(id).apply(c));
  return out;
}

export async function runUninstall(c: SetupContext, id: PartId): Promise<ApplyResult> {
  const p = partById(id);
  if (!p.uninstall) throw new Error(`${id}: geri alma desteklenmiyor (yalnız hooks, global-skills, config)`);
  return p.uninstall(c);
}

const assertPrivate = (h: string, label: string) => {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(h)) throw new Error(`${label}: özel ağ IPv4 adresi olmalı (ad/hostname kabul edilmez)`);
  if (!PRIVATE_V4.some((r) => r.test(h))) throw new Error(`${label}: genel adres reddedilir (yalnız loopback/RFC1918/link-local)`);
};
const assertPort = (p: number | undefined, label: string) => { if (p !== undefined && !(Number.isInteger(p) && p >= 1024 && p <= 65535)) throw new Error(`${label}: 1024-65535 tamsayı olmalı`); };
const assertName = (n: string, label: string) => { if (!/^[a-z][a-z0-9-]*$/.test(n) || n === "self") throw new Error(`${label}: ^[a-z][a-z0-9-]*$ olmalı ('self' ayrılmış)`); };

export interface JoinOptions { brain: string; brainHost?: string; brainPort?: number; brainOs?: MachineEntry["os"]; brainKey?: string }
/** İkinci makine: beyin girdisini yerel katmana yazar, sonra normal kurulum (config → ... → agent) ve beyinle paylaşılan anahtar. */
export async function runJoin(c: SetupContext, j: JoinOptions): Promise<ApplyResult[]> {
  assertName(j.brain, "--join");
  const known = (() => { try { return loadConfig(c.vladHome).machines?.find((m) => m.name === j.brain); } catch { return undefined; } })();
  if (!known) {
    if (!j.brainHost || !j.brainOs) throw new Error(`beyin '${j.brain}' config'te yok: --brain-host <özel IP> ve --brain-os darwin|win32|linux ver`);
    assertPrivate(j.brainHost, "--brain-host"); assertPort(j.brainPort, "--brain-port");
    const brain: MachineEntry = { name: j.brain, os: j.brainOs, agent: { host: j.brainHost, port: j.brainPort ?? 7437 } };
    const cur = readJsonFile(join(c.vladHome, "vlad.config.local.json")).data;
    let existing: MachineEntry[] = cur.machines ?? [];
    if (!cur.machines) { try { existing = (loadConfig(c.vladHome).machines ?? []) as MachineEntry[]; } catch { /* tek makine */ } } // tracked makineler sığ birleşimde kaybolmasın
    writeOverlay(c, { machines: [...existing.filter((m) => m.name !== j.brain), brain], brain: j.brain }, cur.brain !== undefined && cur.brain !== j.brain ? ["brain"] : []);
  }
  const out = await runSetup({ ...c, answers: { ...c.answers, role: "worker", machines: "multi" } });
  if (j.brainKey !== undefined && !c.dryRun) {
    const name = c.answers.machine?.name;
    if (name && readLocal().self !== name) writeLocal({ ...readLocal(), self: name });
    agentSetKey(j.brain, j.brainKey);
    out.push({ part: "agent", changed: true, actions: [{ kind: "write", what: `anahtar yazıldı: keys.${j.brain} (değer basılmaz)` }], backups: [] });
  }
  return out;
}

/** Beyinde: işçiyi machines'e ekler; anahtar üretimi/aktarımı elle (değer çıktıya girmez). */
export async function runAddWorker(c: SetupContext, name: string, w: { os: MachineEntry["os"]; host: string; port?: number; keygen?: boolean }): Promise<ApplyResult> {
  assertName(name, "--add-worker"); assertPrivate(w.host, "--host"); assertPort(w.port, "--port");
  const cur = readJsonFile(join(c.vladHome, "vlad.config.local.json")).data;
  let base: MachineEntry[] = cur.machines ?? loadConfig(c.vladHome).machines ?? [];
  if (!base.length) throw new Error("beyin çok makineli değil: önce `vlad setup --answers` ile machines=multi kur");
  const known = base.some((m) => m.name === name);
  if (!known) base = [...base, { name, os: w.os, agent: { host: w.host, port: w.port ?? 7437 } }];
  const r = known ? ({ part: "config", changed: false, actions: [{ kind: "skip", what: `${name} zaten tanımlı` }], backups: [] } as ApplyResult) : writeOverlay(c, { machines: base });
  if (w.keygen && c.confirmed.has("keygen") && !c.dryRun && !readLocal().keys[name]) { agentKeygen(name, false); r.actions.push({ kind: "write", what: `anahtar üretildi: ${name} (değer basılmaz)` }); }
  r.actions.push({ kind: "print", what: `anahtar: \`vlad agent keygen ${name} --show\` çıktısını işçide \`vlad setup --join <beyin>\` stdin'ine ilet (argv'ye yazma)` });
  return r;
}
