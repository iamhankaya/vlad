import type { Command } from "commander";
import { join } from "node:path";
import { loadConfig } from "../../kb/index.js";
import type { VladConfig } from "../../kb/index.js";
import { brainTransport } from "../../machines/remote.js";
import { formatPlan, formatRun, formatScripts, listScripts, parseParamFlags, runRemoteScript } from "../../machines/script-cli.js";
import { selfName } from "../../fleet/state.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerMachine(program: Command, k: Kit): void {
  const { out, def } = k;
  // --- machines:C2 --- machine
  const machine = program.command("machine").description("Makine kaydı ve uzak denetim");
  const machineCfg = (): { cfg: VladConfig; self: string } => {
    const cfg = loadConfig();
    if (!cfg.machines) throw new Error("config'te machines tanımlı değil");
    return { cfg, self: selfName() };
  };
  def(machine, "list", "Config'teki makineler; brain'i ve yerel kimliği işaretler", (o: Opts) => {
    const { cfg, self } = machineCfg();
    const rows = cfg.machines!.map((m) => ({ name: m.name, os: m.os, brain: m.name === cfg.brain, self: m.name === self, host: m.agent.host ?? null, port: m.agent.port }));
    out(o, rows, rows.map((m) => `${m.name}  ${m.os}  ${m.host ?? "-"}:${m.port}${m.brain ? "  [brain]" : ""}${m.self ? "  [bu makine]" : ""}`).join("\n"));
  });
  def(machine, "ping <ad>", "Makinenin Agent'ına ping atar", async (name: string, o: Opts) => {
    const { cfg, self } = machineCfg();
    const t0 = Date.now();
    const r = (await brainTransport(cfg, self).call<{ machine: string; proto: number; build: string }>(name, "ping", {}, { timeoutMs: 10_000 })).result;
    out(o, { ...r, ms: Date.now() - t0 }, `${r.machine} yanıt verdi (proto ${r.proto}, build ${r.build}, ${Date.now() - t0} ms)`);
  });
  def(machine, "probe-window <ad>", "İşçide kısa ömürlü bir pencere açtırır (pencere görünüyor mu denemesi; Windows)", async (name: string, o: Opts) => {
    const { cfg, self } = machineCfg();
    const r = (await brainTransport(cfg, self).call<{ opened: boolean; method: string }>(name, "probe-window", {}, { timeoutMs: 30_000 })).result;
    out(o, r, `pencere açıldı (${r.method}); işçinin ekranında "VLAD probe-window" başlıklı pencere ~45 sn görünmeli`);
  });
  // --- /machines:C2 ---
  // --- scripts: kayıtlı bakım betikleri (T20261109-03; mantık machines/script-cli.ts) ---
  def(machine, "scripts <ad>", "İşçinin kayıtlı bakım betikleri ve bütünlük durumu (yalnız beyin)", async (name: string, o: Opts) => {
    const { cfg, self } = machineCfg();
    const r = await listScripts(brainTransport(cfg, self), name);
    out(o, r, formatScripts(r));
  });
  const collect = (v: string, prev: string[] = []): string[] => [...prev, v];
  def(machine, "run <ad> <betik>", "İşçide kayıtlı bakım betiğini çalıştırır (yalnız beyin; write sınıfı önce --plan, sonra --confirmed)", async (name: string, script: string, o: Opts) => {
    const { cfg, self } = machineCfg();
    const r = await runRemoteScript(brainTransport(cfg, self), name, script, {
      params: parseParamFlags(o.param as string[] | undefined), plan: !!o.plan, confirmed: o.confirmed as string | undefined, opId: o.opId as string | undefined,
    });
    if (r.kind === "plan") return out(o, r, formatPlan(r));
    out(o, { ...r.result, opId: r.opId, meta: { replayed: r.replayed, uncertain: r.uncertain } }, formatRun(r));
    if (r.result.exit !== 0) {
      if (!o.json && r.result.stderr.trim()) k.ctx.stderr.write(r.result.stderr.trim() + "\n");
      k.ctx.exit(1); // betik hatası: çıkış kodu 1 (geçici RemoteError'lar 75 ile zaten failWith'ten çıkar)
    }
  })
    .option("--param <k=v>", "betik parametresi (tekrarlanabilir; ilk '=' böler, kopya anahtar reddedilir)", collect)
    .option("--plan", "çağırmadan betik/sürüm/sınıf/parametreleri ve plan-id'yi yazar")
    .option("--confirmed <plan-id>", "write sınıfı için kullanıcı onayı verilen plan-id")
    .option("--op-id <id>", "sabit opId (istemci zaman aşımında aynı opId ile tekrar: betik ikinci kez koşmaz)");
  // --- /scripts ---
}
