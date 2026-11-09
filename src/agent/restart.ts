import { win32 } from "node:path";

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

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/**
 * Windows yardımcısı: pid dosyası kaybolana (en çok 60 sn) kadar bekler, sonra başlatma betiğini açar (`portTaken` çift başlatmayı zaten önler).
 * `-EncodedCommand`: yollar kabuk tırnaklamasına girmez; tek tırnak PowerShell dizgesinde ikilenir.
 */
export function winRestartHelper(o: { pidFile: string; startCmd: string; systemRoot: string | undefined }): { file: string; args: string[] } {
  const script = [
    `$t = (Get-Date).AddSeconds(60)`,
    `while ((Test-Path -LiteralPath ${q(o.pidFile)}) -and ((Get-Date) -lt $t)) { Start-Sleep -Milliseconds 500 }`,
    `if (Test-Path -LiteralPath ${q(o.pidFile)}) { exit 1 }`,
    `Start-Sleep -Seconds 2`,
    `Start-Process -FilePath ${q(o.startCmd)} -WindowStyle Hidden`,
  ].join("\n");
  return {
    file: win32.join(o.systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
