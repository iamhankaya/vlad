// Config overlay okuyucusu (T20261110-03 sözleşmesi, T20261110-05 gövde). Birleşim `src/kb/config-layer.ts`'te (kb katmanı setup'ı import edemez);
// `src/kb/config.ts:27` loadConfig, `src/kb/home.ts` resolveKbDir ve `src/agent/forward.ts` workerState aynı birleşimi kullanır.
import { getVladHome } from "../kb/home.js";
import { loadConfig } from "../kb/config.js";
import type { VladConfig } from "../kb/types.js";

export { LOCAL_CONFIG_FILE } from "../kb/config-layer.js";

/** Overlay yokken sonuç bugünkü `loadConfig(home)` ile derin eşit olur (kullanıcının kurulumu değişmez). */
export function loadLayeredConfig(home: string = getVladHome()): VladConfig {
  return loadConfig(home);
}
