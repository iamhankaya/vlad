// Config overlay okuyucu sözleşmesi (T20261110-03). Gövde uygulama fazında (4a): `vlad.config.json` (tracked) üstüne
// `vlad.config.local.json` (gitignored) sığ birleşim, `null` anahtarı siler, birleşim `config` şemasıyla doğrulanır.
// `src/kb/config.ts:27`, `src/kb/home.ts:20`, `src/agent/forward.ts:21` bu tek fonksiyona geçer (üçü aynı sonucu verir).
import type { VladConfig } from "../kb/types.js";

export const LOCAL_CONFIG_FILE = "vlad.config.local.json";

/** Overlay yokken sonuç bugünkü `loadConfig(home)` ile derin eşit olmalıdır (kullanıcının kurulumu değişmez). */
export function loadLayeredConfig(_home?: string): VladConfig {
  throw new Error("not implemented: loadLayeredConfig (uygulama fazı 4a)");
}
