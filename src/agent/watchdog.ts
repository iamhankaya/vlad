// Yeniden başlatma sağlık bekçisi (T20261109-10, spec S23/S24 değişiklik turu): selfUpdate sonrası Agent çıkarken ayrık bir süreç olarak başlar
// (Mac). Eski süreç portu bırakana, sonra yeni süreç dinleyene kadar bekler: dinlerse yedekleri (dist-old, node_modules-old) siler; belirlenen
// sürede dinlemezse dist ve node_modules'ı yedekten geri yükler ve (varsa) WD_KICK komutunu çalıştırır. Yeni dist açılışta çöküyorsa kod kendini
// kurtaramaz, bu yüzden bekçi self-contained düz JS'tir (`node -e`, yeni dist'e bağımlı değil). Windows karşılığı restart.ts `winRestartHelper` içindedir.
// Ortam: WD_HOST, WD_PORT, WD_REPO, WD_WAIT_MS (varsayılan 60000; her faz için), WD_KICK (JSON argv, isteğe bağlı).
export const WATCHDOG_JS = String.raw`
const net = require("net"), fs = require("fs"), cp = require("child_process"), path = require("path");
const E = process.env, host = E.WD_HOST, port = Number(E.WD_PORT), repo = E.WD_REPO, wait = Number(E.WD_WAIT_MS) || 60000;
const probe = () => new Promise((res) => {
  const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); res(false); }, 800);
  s.once("connect", () => { clearTimeout(t); s.destroy(); res(true); });
  s.once("error", () => { clearTimeout(t); res(false); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (want, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await probe()) === want) return true; await sleep(300); } return false; };
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
(async () => {
  if (!(await until(false, wait))) process.exit(0);
  if (await until(true, wait)) { rm(path.join(repo, "dist-old")); rm(path.join(repo, "node_modules-old")); process.exit(0); }
  for (const [cur, old] of [["dist", "dist-old"], ["node_modules", "node_modules-old"]]) {
    const o = path.join(repo, old);
    if (fs.existsSync(o)) { rm(path.join(repo, cur)); fs.renameSync(o, path.join(repo, cur)); }
  }
  if (E.WD_KICK) { try { const a = JSON.parse(E.WD_KICK); cp.spawnSync(a[0], a.slice(1), { stdio: "ignore" }); } catch (e) {} }
  process.exit(0);
})();
`;
