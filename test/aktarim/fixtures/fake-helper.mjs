// Pano yardımcı protokolünün (satır başına JSON istek/yanıt) taklidi. Gerçek pano yok: bellekteki sahte pano.
// Davranış bayrakları argv'den: crash-after=N (N. istekte yanıtlamadan çık), hang (hiç yanıt verme), bump-later (yazmadan sonra sayaç gecikmeli +1),
// state=<yol> + hang-first=N | crash-first=N (süreç sayısı dosyada tutulur: ilk N başlatma takılır/çöker, sonrası sağlam), racy-read (ilk okumada sayaç okuma sırasında değişir), both (metin+resim birlikte), pid-file=<yol> (pid'i yaz).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const flags = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.split("="); return [k, v ?? true]; }));
const spawnNo = flags.state ? (existsSync(flags.state) ? Number(readFileSync(flags.state, "utf8")) : 0) + 1 : 1;
if (flags.state) writeFileSync(flags.state, String(spawnNo));
if (flags["pid-file"]) writeFileSync(flags["pid-file"], String(process.pid));
let n = 1, text = null, png = null, handled = 0, bumpPending = false, raced = false;
const reply = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0)); // stdin EOF → çık
rl.on("line", (line) => {
  handled++;
  if (flags.hang || spawnNo <= Number(flags["hang-first"] ?? 0)) return;
  if (spawnNo <= Number(flags["crash-first"] ?? 0)) process.exit(3);
  if (flags["crash-after"] && handled >= Number(flags["crash-after"])) process.exit(3);
  const f = line.split("\t"); const r = { id: Number(f[0]), c: f[1], kind: f[2], expect: Number(f[3]), b64: f[4] };
  if (r.c === "count") { if (bumpPending) { n++; bumpPending = false; } return reply({ id: r.id, ok: true, n }); }
  if (r.c === "read") {
    const before = n;
    if (flags["racy-read"] && !raced) { raced = true; n++; }
    return reply({ id: flags["bad-id"] ? 999 : r.id, ok: true, n: before, after: n, text, png });
  }
  if (r.c === "write") {
    if (r.expect !== n) return reply({ id: r.id, ok: true, written: false, n });
    if (r.kind === "text") { text = r.b64; png = flags.both ? "iVBORw0KGgo=" : null; } else { png = r.b64; text = null; }
    if (flags["bump-later"]) bumpPending = true; else n++; // gecikmeli pano: sayaç yazma yanıtından SONRA artar
    return reply({ id: r.id, ok: true, written: true, n });
  }
  reply({ id: r.id, ok: false, err: "bilinmeyen komut" });
});
