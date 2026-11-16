// Uzaktan onay kabul testleri (T20261116-05): `approver-run-entry.mjs` yürütücüsünün çalıştırdığı SAHTE vlad CLI'ı.
// Gerçek dist/cli.js'e dokunmaz: argv'yi ve env ANAHTAR adlarını (değerleri DEĞİL; token yalnız biçim bayrağı olarak) FAKE_RECORD dosyasına JSON satırı olarak ekler.
import { appendFileSync } from "node:fs";

const t = process.env.VLAD_MODE_TOKEN ?? null;
const rec = {
  argv: process.argv.slice(2),
  envKeys: Object.keys(process.env).sort(),
  home: process.env.HOME ?? null,
  vladHome: process.env.VLAD_HOME ?? null,
  tokenShape: t === null ? null : /^VMT2\.\d+\.[0-9a-f]{32}\.[0-9a-f]{64}\.[0-9a-f]{64}$/.test(t) ? "VMT2" : "other",
  cwd: process.cwd(),
  pid: process.pid,
};
if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify(rec) + "\n");
process.stdout.write("fake-ok\n");
