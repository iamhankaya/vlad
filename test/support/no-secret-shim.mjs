// F-vlad-337: yalnız test alt süreçleri için (vitest.config.ts NODE_OPTIONS=--import ile yüklenir): çocuk `node dist/cli.js` gerçek
// gizli mod dizinini görmesin diye süreç içi test seam'ini var olmayan geçici bir dizine çevirir (= mekanizma kapalı).
// Üretim dist'inde env ile açılan bir seam YOKTUR (TMPDIR/HOME çalışan kontrolünde, güvenli kök türetilemez; T20261113-22 incelemesi).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const tokenUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "dist", "mode", "token.js")).href;
  const { setSecretDirForTests } = await import(tokenUrl);
  setSecretDirForTests(process.env.VLAD_TEST_SECRET_DIR || join(tmpdir(), `vlad-test-nosecret-child-${process.ppid}`));
} catch { /* dist yok / başka node çocuğu: sessiz geç */ }
