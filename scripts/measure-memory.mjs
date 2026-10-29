#!/usr/bin/env node
// Ölçüm (T20261030-01): "nerede kalmıştık / ne karar vermiştik" sorularında eski ve yeni okuma yolunun
// okuduğu bayt ve yanıt kanıtı. Gerçek kb'ye YAZMAZ: --kb ile verilen bir KOPYA üzerinde çalışır
// (bilinen geçersiz kararı kopyada `decision set` ile işaretler). Kullanım:
//   node scripts/measure-memory.mjs --kb <kb-kopyası> [--json]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const args = process.argv.slice(2);
const kbArg = args[args.indexOf("--kb") + 1];
if (!kbArg || !args.includes("--kb")) { console.error("kullanım: --kb <kb kopyası> (gerçek kb'ye yazılmaz)"); process.exit(2); }
const kb = realpathSync.native(resolve(kbArg));
if (!kb.startsWith(realpathSync.native(tmpdir()) + sep)) { console.error(`kb kopyası geçici dizinde olmalı: ${kb}`); process.exit(2); }

const env = { ...process.env, VLAD_KB_DIR: kb };
const vlad = (...a) => {
  const r = spawnSync("node", [cli, ...a], { encoding: "utf8", env, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`vlad ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const fold = (s) => [...s].map((c) => (c === "İ" || c === "I" || c === "ı" ? "i" : c.toLowerCase().normalize("NFD")[0])).join("");

// kopyada geçişi yap ve bilinen geçersiz kararı işaretle (VLAD'ın merge sonrası yapacağı gibi)
vlad("decision", "migrate");
const wp = JSON.parse(vlad("decision", "list", "--project", "watchparty", "--all", "--json")).decisions;
const old = wp.find((d) => d.title === "Ses dönüştürme mimarisi");
const cur = wp.find((d) => d.title.startsWith("Ses dönüştürme yalnız yerel"));
if (old && cur && old.status === "geçerli") vlad("decision", "set", old.id, "yerine-geçti", "--superseded-by", cur.id);

const Q = [
  { q: "watchparty ses dönüştürme kararı ne?", project: "watchparty", query: "ses dönüştürme", facts: ["yalnız yerel"], stale: ["Ses dönüştürme mimarisi"] },
  { q: "vlad: yetkinin tek kaynağı ne?", project: "vlad", query: "yetki tek kaynağı", facts: ["Yetki tek kaynağı config"] },
  { q: "ashen-bastion: katman istisnaları kararı?", project: "ashen-bastion", query: "katman istisnaları", facts: ["Katman istisnaları yalnız azalır"] },
  { q: "diskpilot: SİL onayı nasıl karara bağlandı?", project: "diskpilot", query: "SİL onayı", facts: ["tr-TR"] },
  { q: "vlad: cleanup silme yarışı kararı?", project: "vlad", query: "cleanup silme yarışında", facts: ["fail-closed"] },
  { q: "vlad: kb bakımı/arşiv işi hangi görev?", project: "vlad", query: "kb bakımı arşiv", facts: ["T20261029-42"] },
];

const read = (p) => readFileSync(p, "utf8");
const listMd = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listMd(join(d, e.name)) : e.name.endsWith(".md") ? [join(d, e.name)] : [])) : []);

/** Eski yol (eski CLAUDE.md): proje kartı + projeyi anan günlükler + decisions/<proje>.md + sorguyu içeren en çok 3 görev dosyası, hepsi tam okunur. */
function oldPath(q) {
  const parts = [];
  const card = join(kb, "projects", `${q.project}.md`);
  if (existsSync(card)) parts.push(read(card));
  for (const f of listMd(join(kb, "journal"))) { const t = read(f); if (fold(t).includes(q.project)) parts.push(t); }
  const dec = join(kb, "decisions", `${q.project}.md`);
  if (existsSync(dec)) parts.push(read(dec));
  const words = fold(q.query).split(/\s+/);
  let n = 0;
  for (const f of listMd(join(kb, "tasks"))) {
    if (n >= 3) break;
    const t = read(f);
    if (words.every((w) => fold(t).includes(w))) { parts.push(t); n++; }
  }
  return parts.join("\n");
}

/** Yeni yol: proje durumu + geçerli karar listesi + sınırlı arama (hepsi --json). */
function newPath(q) {
  return [
    vlad("project", "status", q.project, "--json"),
    vlad("decision", "list", "--project", q.project, "--json"),
    vlad("kb", "search", q.query, "--project", q.project, "--limit", "8", "--json"),
  ].join("\n");
}

const rows = Q.map((q) => {
  const o = oldPath(q), n = newPath(q);
  const has = (txt) => q.facts.every((f) => fold(txt).includes(fold(f)));
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  // geçersiz karar: eski yolda geçerli diye okunabilir (durum yok); yeni yolda geçerli listede olmamalı
  const validList = vlad("decision", "list", "--project", q.project, "--json");
  const staleSeen = (q.stale ?? []).map((s) => ({ old: fold(o).includes(fold(s)), newValid: fold(validList).includes(fold(s)) }));
  return { soru: q.q, eski_bayt: bytes(o), yeni_bayt: bytes(n), eski_kanıt: has(o), yeni_kanıt: has(n), bayat_karar: staleSeen };
});

if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log("| soru | eski bayt | yeni bayt | oran | kanıt eski/yeni | bayat karar (eski okunur / yeni geçerli listede) |");
  console.log("|---|---:|---:|---:|---|---|");
  for (const r of rows) {
    console.log(`| ${r.soru} | ${r.eski_bayt} | ${r.yeni_bayt} | ${(r.yeni_bayt / r.eski_bayt).toFixed(2)} | ${r.eski_kanıt ? "var" : "yok"}/${r.yeni_kanıt ? "var" : "yok"} | ${r.bayat_karar.map((b) => `${b.old}/${b.newValid}`).join(",") || "-"} |`);
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  console.log(`| toplam | ${sum("eski_bayt")} | ${sum("yeni_bayt")} | ${(sum("yeni_bayt") / sum("eski_bayt")).toFixed(2)} | | |`);
}
