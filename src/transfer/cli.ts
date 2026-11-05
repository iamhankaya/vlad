import { AgentClient } from "../agent/client.js";
import { readLocal, selfName } from "../fleet/state.js";
import { loadConfig } from "../kb/config.js";
import type { VladConfig } from "../kb/types.js";
import { RemoteError, type Os, type RemoteTransport } from "../fleet/types.js";
import { createNotifier, type Notifier } from "../platform/notify.js";
import { sendPaths, type SendResult } from "./send.js";

// `vlad send <yol...> [--to <makine>] [--json] [--notify]`. Hata fırlatır; src/cli.ts kabuğu fail()'e yönlendirir.
// Çıkış: 0 başarı (skipped dolu olsa da); 75 geçici (RemoteError.transient); 1 diğer (forbidden, eski Agent, yol yok,
// bilinmeyen --to, 2+ makinede --to yok, kendine gönderme, sınır aşımı, dosya değişti, uncertain, kısmi teslim).
// --json: stdout yalnız {"to","items","failed"?,"skipped","totalBytes"}. TTY ise ilerleme stderr'e. Hiçbir şey sormaz.
export interface SendCommandOpts { to?: string; json?: boolean; notify?: boolean; isTTY?: boolean }
/** Testte enjekte edilir; üretimde hepsi varsayılan (gerçek config, AgentClient, stdout/stderr, gerçek bildirim). */
export interface SendCommandIo {
  cfg?: VladConfig; self?: string; transport?: RemoteTransport; notifier?: Notifier;
  write?(s: string): void; writeErr?(s: string): void; sleep?(ms: number): Promise<void>;
}

function resolveTarget(cfg: VladConfig, self: string, to: string | undefined): string {
  const known = [...new Set([...(cfg.machines ?? []).map((m) => m.name), ...(cfg.brain ? [cfg.brain] : [])])];
  if (to !== undefined) {
    if (to === self) throw new Error(`kendine gönderilemez: ${to}`);
    if (!known.includes(to)) throw new Error(`bilinmeyen makine: ${to} (tanımlılar: ${known.join(", ") || "yok"})`);
    return to;
  }
  const others = known.filter((n) => n !== self);
  if (others.length === 1) return others[0]!;
  throw new Error(others.length === 0 ? "karşı makine tanımlı değil (vlad.config.json machines)" : `--to gerekli (makineler: ${others.join(", ")})`);
}

/** `--args-env`: yollar `VLAD_ARG_COUNT` + `VLAD_ARG_1..n` ortam değişkenlerinden (Windows VBS başlatıcısı; komut satırı/%VAR% yorumlamasından kaçınır). */
export function argsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const n = Number(env.VLAD_ARG_COUNT);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new Error("VLAD_ARG_COUNT geçersiz (--args-env)");
  return Array.from({ length: n }, (_, i) => {
    const v = env[`VLAD_ARG_${i + 1}`];
    if (!v) throw new Error(`VLAD_ARG_${i + 1} boş ya da yok (--args-env)`);
    return v;
  });
}

/** runSendCommand'in bildirdiği hatalar: kabuk (src/cli.ts) aynı hatayı ikinci kez bildirmesin. */
const notified = new WeakSet<object>();

/**
 * `--notify` ile `vlad send` hatası runSendCommand'e hiç varmadan atılmışsa (işçi forward reddi, `--args-env`/yol doğrulaması)
 * kabuk bunu çağırır; sağ tıktan gönderen (gizli VBS) hatayı yine görür (F-vlad-237). Bildirim hatası yutulur.
 */
export async function notifySendFailure(e: unknown, o: { notify?: boolean }, io: { notifier?: Notifier; os?: Os } = {}): Promise<void> {
  if (!o.notify || (typeof e === "object" && e !== null && notified.has(e))) return;
  try {
    await (io.notifier ?? createNotifier(io.os ?? (process.platform as Os))).notify("Gönderilemedi", `gönderilemedi: ${e instanceof Error ? e.message : String(e)}`);
  } catch { /* bildirim hatası asıl hatayı değiştirmez */ }
}

export async function runSendCommand(paths: string[], o: SendCommandOpts, io: SendCommandIo = {}): Promise<void> {
  const write = io.write ?? ((s: string) => { process.stdout.write(s); });
  const writeErr = io.writeErr ?? ((s: string) => { process.stderr.write(s); });
  // Başlatma ve hedef çözme de bildirim sınırının içinde (F-vlad-222): sağ tıktan gönderen hata görmeden kalmasın.
  let cfg: VladConfig | undefined, to: string | undefined;
  const tell = async (title: string, body: string) => {
    if (!o.notify) return;
    try {
      const os: Os = cfg?.machines?.find((m) => m.name === io.self)?.os ?? (process.platform as Os);
      await (io.notifier ?? createNotifier(os)).notify(title, body);
    } catch { /* bildirim hatası gönderimin sonucunu değiştirmez */ }
  };
  const showProgress = !!o.isTTY && !o.json;
  let r: SendResult;
  try {
    cfg = io.cfg ?? loadConfig();
    const self = io.self ?? selfName();
    to = resolveTarget(cfg, self, o.to);
    const transport = io.transport ?? new AgentClient({ self, keys: readLocal().keys, config: () => cfg! });
    const peerOs = cfg.machines?.find((m) => m.name === to)?.os;
    r = await sendPaths(transport, {
      to, paths, sleep: io.sleep, peerOs,
      onProgress: showProgress ? (p) => writeErr(`\r${Math.floor((p.sentBytes / Math.max(p.totalBytes, 1)) * 100)}% ${p.sentBytes}/${p.totalBytes} ${p.file}\x1b[K`) : undefined,
    });
  } catch (e) {
    if (showProgress) writeErr("\n");
    if (to === undefined) await tell("Gönderilemedi", `gönderilemedi: ${e instanceof Error ? e.message : String(e)}`);
    else if (e instanceof RemoteError && e.code === "uncertain") await tell(`${to}: teslim belirsiz`, `sonuç belirsiz, ${to} makinesinde İndirilenler'e bak`);
    else await tell(`${to}'a gönderilemedi`, `gönderilemedi: ${e instanceof Error ? e.message : String(e)}`);
    if (typeof e === "object" && e !== null) notified.add(e);
    throw e;
  }
  if (showProgress) writeErr("\n");

  if (o.json) write(JSON.stringify({ to: r.to, items: r.items, ...(r.failed ? { failed: r.failed } : {}), skipped: r.skipped, totalBytes: r.totalBytes }) + "\n");
  else {
    write(`${r.items.length} öğe → ${r.to} (${r.totalBytes} bayt): ${r.items.map((i) => i.name).join(", ")}\n`);
    for (const s of r.skipped) writeErr(`atlandı (${s.reason}): ${s.path}\n`);
  }
  if (r.failed) {
    await tell(`${to}'a gönderilemedi`, `gönderilemedi: ${r.failed.name}: ${r.failed.error}`);
    const err = new RemoteError("failed", `failed: kısmi teslim: ${r.failed.name}: ${r.failed.error}`, to);
    notified.add(err);
    throw err;
  }
  await tell(`${to}'a gönderildi`, r.items.map((i) => i.name).join(", "));
}
