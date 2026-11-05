import { notImplemented } from "../platform/not-implemented.js";

// Sözleşme (S) → gövde A2. Hata fırlatır; cli.ts kabuğu fail()'e yönlendirir.
// Çıkış: 0 başarı (skipped dolu olsa da); 75 geçici (RemoteError.transient); 1 diğer (forbidden, eski Agent, yol yok,
// bilinmeyen --to, 2+ makinede --to yok, kendine gönderme, sınır aşımı, dosya değişti, uncertain, kısmi teslim).
// --json: stdout yalnız {"to","items","failed"?,"skipped","totalBytes"}. TTY ise ilerleme stderr'e. Hiçbir şey sormaz.
export interface SendCommandOpts { to?: string; json?: boolean; notify?: boolean; isTTY?: boolean }
export function runSendCommand(_paths: string[], _o: SendCommandOpts): Promise<void> { return notImplemented("runSendCommand"); }
