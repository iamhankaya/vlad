import { win32 } from "node:path";
import { psQuote as q } from "../launcher/terminal.js";

// Agent yeniden başlatma (T20261109-10, spec S23/S24): selfUpdate başarıyla bitince yeni kod için süreç yeniden başlar.
// Mac: çıkış (launchd KeepAlive geri getirir). Windows: schtasks onlogon yeniden başlatmaz; WMI ile iş nesnesi dışında bir yardımcı süreç
// pid dosyası kaybolunca `agent-start.cmd`'yi açar. Yardımcı başlamazsa Agent ÇIKMAZ (ölü kalmasın).

export interface RestartDeps {
  platform: NodeJS.Platform;
  /** yanıtın gitmesi için ilk bekleme */
  delayMs: number;
  pollMs: number;
  /** uçuştaki op'lar bu süre içinde bitmezse yine de yeniden başlar (Agent sonsuza kadar bakımda kalmasın) */
  maxWaitMs: number;
  inflight(): number;
  /** Agent'ı temiz kapatır ve süreci sonlandırır */
  stop(): void;
  /** çıkıştan önce: yeniden başlatmayı sağlayacak yolu doğrular/başlatır (Mac: launchd plist'i var mı; Windows: WMI yardımcısı). Fırlatırsa Agent çıkmaz. */
  helper(): Promise<void>;
  onFail(msg: string): void;
}

const seen = new WeakSet<object>();

/** Gecikmeden sonra uçuşta op kalmayınca (ya da maxWait dolunca) yeniden başlatır. Aynı `deps` ile ikinci çağrı yok sayılır. */
export function scheduleRestart(d: RestartDeps): void {
  if (seen.has(d)) return;
  seen.add(d);
  const t0 = Date.now();
  const fire = async () => {
    try { await d.helper(); } catch (e) { seen.delete(d); d.onFail((e as Error).message); return; } // seen silinir: sonraki selfUpdate yeniden deneyebilsin (bayrak onFail'de kalkar)
    d.stop();
  };
  const tick = () => {
    if (d.inflight() === 0 || Date.now() - t0 >= d.delayMs + d.maxWaitMs) void fire();
    else setTimeout(tick, d.pollMs);
  };
  setTimeout(tick, d.delayMs);
}

/**
 * Windows yardımcısı: pid dosyası kaybolana (en çok 60 sn) kadar bekler, sonra başlatma betiğini açar (`portTaken` çift başlatmayı zaten önler).
 * `-EncodedCommand`: yollar kabuk tırnaklamasına girmez; tek tırnak PowerShell dizgesinde ikilenir.
 */
export function winRestartHelper(o: { pidFile: string; startCmd: string; systemRoot: string | undefined; watch?: { host: string; port: number; repo: string } }): { file: string; args: string[] } {
  const w = o.watch;
  const rollback = w ? (["dist", "node_modules"] as const).map((n) => `if (Test-Path -LiteralPath ${q(win32.join(w.repo, `${n}-old`))}) { Remove-Item -LiteralPath ${q(win32.join(w.repo, n))} -Recurse -Force -ErrorAction SilentlyContinue; Rename-Item -LiteralPath ${q(win32.join(w.repo, `${n}-old`))} -NewName ${q(n)} -ErrorAction SilentlyContinue }`) : [];
  const script = [
    `$t = (Get-Date).AddSeconds(60)`,
    `while ((Test-Path -LiteralPath ${q(o.pidFile)}) -and ((Get-Date) -lt $t)) { Start-Sleep -Milliseconds 500 }`,
    `if (Test-Path -LiteralPath ${q(o.pidFile)}) { exit 1 }`,
    `Start-Sleep -Seconds 2`,
    `Start-Process -FilePath ${q(o.startCmd)} -WindowStyle Hidden`,
    // sağlık + geri alma: yeni süreç 60 sn içinde dinlemezse yedekler geri yüklenip yeniden başlatılır; dinlerse yedekler silinir
    ...(w ? [
      `function Test-Listen { try { $c = New-Object System.Net.Sockets.TcpClient; $a = $c.BeginConnect(${q(w.host)}, ${Number(w.port)}, $null, $null); $ok = $a.AsyncWaitHandle.WaitOne(800) -and $c.Connected; $c.Close(); return $ok } catch { return $false } }`,
      `$t = (Get-Date).AddSeconds(60); $up = $false`,
      `while (-not $up -and (Get-Date) -lt $t) { if (Test-Listen) { $up = $true } else { Start-Sleep -Seconds 1 } }`,
      `if ($up) {`,
      ...(["dist-old", "node_modules-old"] as const).map((n) => `  Remove-Item -LiteralPath ${q(win32.join(w.repo, n))} -Recurse -Force -ErrorAction SilentlyContinue`),
      `} else {`,
      ...rollback.map((l) => `  ${l}`),
      `  Start-Process -FilePath ${q(o.startCmd)} -WindowStyle Hidden`,
      `}`,
    ] : []),
  ].join("\n");
  return {
    file: win32.join(o.systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

/** Temiz kapanış: kapatma takılırsa (clip/aktarım) `timeoutMs` sonra yine temizler ve çıkar; çıkmayan süreç bakım bayrağını kalıcı açık tutmasın. Aynı `o` ile ikinci çağrı yok sayılır. */
const stopping = new WeakSet<object>();
export function gracefulStop(o: { close(): Promise<void>; cleanup(): void; exit(code: number): void; timeoutMs: number }): void {
  if (stopping.has(o)) return;
  stopping.add(o);
  let done = false;
  const timer = setTimeout(() => fin(), o.timeoutMs);
  const fin = () => { if (done) return; done = true; clearTimeout(timer); try { o.cleanup(); } catch { /* çıkış engellenmez */ } o.exit(0); };
  o.close().catch(() => undefined).then(fin);
}
