import { nativeAllowed } from "../platform/native.js";
import type { AktarimDeps } from "../transfer/types.js";
import { createClipReceiver } from "./receive.js";

/**
 * Agent açılışında pano yoklamasını başlatır. `nativeAllowed()` false (VLAD_NO_NATIVE=1) ya da karşı makine tek değilse
 * (2'den çok makine) no-op + uyarı: gerçek pano/yardımcı süreç çağrısı yapılmaz. `stop` zamanlayıcıyı durdurur ve backend'i (yardımcı süreç) kapatır.
 */
export function startClipSync(d: AktarimDeps): { stop(): Promise<void> } {
  const noop = { stop: async () => {} };
  if (!nativeAllowed()) return noop;
  if (d.clip.peer === null) { d.clip.log("ortak pano devre dışı: karşı makine tek değil (yalnız iki makinede çalışır)"); return noop; }
  const { sync } = createClipReceiver(d.clip);
  sync.start();
  return { stop: async () => { await sync.stop(); await d.clip.backend.close(); } };
}
