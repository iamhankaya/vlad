import type { Command } from "commander";
import { join } from "node:path";
import { readInput } from "../../kb/input.js";
import { getVladHome, loadConfig } from "../../kb/index.js";
import { runRemote, callLocal, workerContext } from "../../agent/forward.js";
import { agentKeygen, agentSetKey, agentStart, agentStatus } from "../../agent/start.js";
import { installPlan } from "../../agent/install.js";
import { selfName } from "../../fleet/state.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerAgent(program: Command, k: Kit): void {
  const { ctx, fail, out, def } = k;
  // --- machines:B --- agent, queue, remote
  const agent = program.command("agent").description("VLAD Agent (çoklu makine; T20261101-19)");
  def(agent, "start", "Agent'ı başlatır (tek örnek; kimlik VLAD_MACHINE/vlad.local.json)", async (o: Opts) => {
    await agentStart({ port: o.port === undefined ? undefined : Number(o.port), printPort: !!o.printPort });
  }).option("--port <n>", "config portunu geçersiz kıl (0 = rastgele)").option("--print-port", "ilk stdout satırı {\"listening\":{host,port}}");
  def(agent, "status", "Yerel Agent çalışıyor mu", async (o: Opts) => {
    const s = await agentStatus();
    out(o, s, s.running ? `çalışıyor: ${s.host}:${s.port}${s.pid ? ` (pid ${s.pid})` : ""}` : `çalışmıyor (${s.host}:${s.port})`);
    process.exitCode = s.running ? 0 : 1;
  });
  def(agent, "keygen <kimlik>", "Anahtar üretir, vlad.local.json'a yazar (anahtarı basmaz; --show ile basar). <karşı-taraf> = çift anahtar (yalnız bu iki makine bilir; karşı uçta `setkey <ad> -` çalıştır); <kendi-adın> = yerel çağrı anahtarı", (identity: string, o: Opts) => {
    const r = agentKeygen(identity, !!o.show);
    const shown = r.key ? `${r.identity}: ${r.key}
` : `${r.identity}: anahtar üretildi (basmak için --show; yeniden üretmek eskisini değiştirir: bir kez --show ile bas, stdin'e ilet)
`;
    out(o, r, r.copy
      ? `${shown}(${r.file}'a yazıldı. Karşı uçta anahtarı stdin'den ver (argv'ye yazma):
  ${r.copy}
sonra iki ucun Agent'ını yeniden başlat)`
      : `${shown}(${r.file}'a yazıldı; yerel çağrı anahtarı, kopyalanmaz; Agent'ı yeniden başlat)`);
  }).option("--show", "anahtarı çıktıya bas (varsayılan basmaz)");
  def(agent, "setkey <karsi-taraf> <anahtar>", "Karşı uçta üretilmiş çift anahtarı yazar (keys.<karşı-taraf>); <anahtar> `-` olmalı, anahtar stdin'den okunur", (peer: string, key: string, o: Opts) => {
    if (key !== "-") throw new Error("agent setkey: anahtar argv'de verilmez (süreç listesine/kabuk geçmişine sızar); `-` ver ve anahtarı stdin'den ilet");
    const r = agentSetKey(peer, readInput("-").trim());
    out(o, r, `${r.peer} anahtarı ${r.file}'a yazıldı (Agent'ı yeniden başlat)`);
  });

  def(agent, "install", "Agent'ı oturum açılışında başlatacak kaydı basar (Mac: launchd plist, Windows: görev zamanlayıcı); --apply ile kurar", (o: Opts) => {
    const cfg = loadConfig();
    const self = selfName();
    const m = cfg.machines?.find((x) => x.name === self);
    if (!m) throw new Error(`agent install: ${self} config machines içinde değil`);
    const plan = installPlan(m.os, { node: process.execPath, cli: ctx.argv[1]!, home: getVladHome(), path: ctx.env.PATH ?? "" });
    if (o.apply) plan.apply?.();
    const text = [plan.description, ...(plan.file ? [`dosya: ${plan.file}`] : []), ...(plan.content ? ["", plan.content] : []), `komut: ${plan.command}`, ...(o.apply ? ["uygulandı"] : ["(uygulamak için --apply)"])].join("\n");
    out(o, { description: plan.description, file: plan.file, content: plan.content, command: plan.command, applied: !!o.apply }, text);
  }).option("--apply", "kaydı gerçekten kur (yoksa yalnız basar)");

  const queue = program.command("queue").description("İşçi tarafı beyin-yazma kuyruğu (yerel Agent'a sorar)");
  const queueCall = async <T>(op: "queue-list" | "queue-flush" | "queue-drop", args: unknown): Promise<T> => {
    const w = workerContext();
    if (!w) throw new Error("queue: yalnız beyin olmayan işçi makinede kullanılır");
    return callLocal<T>(w.cfg, w.self, op, args);
  };
  def(queue, "list", "Bekleyen ve başarısız yazmalar", async (o: Opts) => {
    const r = await queueCall<{ entries: { seq: number; opId: string; cmd: string; id: string; state: string }[] }>("queue-list", {});
    out(o, r, r.entries.length ? r.entries.map((e) => `${e.seq}  ${e.state.padEnd(8)} ${e.cmd} ${e.id}  ${e.opId}`).join("\n") : "kuyruk boş");
  });
  def(queue, "flush", "Kuyruğu şimdi boşaltmayı dener", async (o: Opts) => {
    const r = await queueCall<{ sent: number; failed: number; remaining: number }>("queue-flush", {});
    out(o, r, `gönderilen ${r.sent}, başarısız ${r.failed}, kalan ${r.remaining}`);
  });
  def(queue, "drop <seq>", "Kuyruktaki (ya da başarısız) girdiyi siler", async (seq: string, o: Opts) => {
    const n = Number(seq);
    if (!Number.isInteger(n) || n < 1) throw new Error(`seq geçersiz: ${seq}`);
    const r = await queueCall<{ dropped: true }>("queue-drop", { seq: n });
    out(o, r, `silindi: ${n}`);
  });

  program.command("remote").description("Konsol istemcisi: komutu beyin Agent'ında çalıştırır (vlad remote [--op-id id] [--stdin] -- <vlad argv…>)")
    .option("--op-id <uuid>", "yazma tekrarında ilk sonucu döndürmek için sabit opId").option("--stdin", "stdin'i komuta ilet (--file - için)")
    .argument("[argv...]").action(async (argv: string[], o: Opts) => {
      try { await runRemote(argv, { opId: o.opId as string | undefined, stdin: !!o.stdin }); } catch (e) { fail(e); }
    });
  // --- /machines:B ---
}
