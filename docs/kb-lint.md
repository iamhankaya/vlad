# `vlad kb lint`

Salt okuma çelişki denetimi (kb'ye yazmaz). Proje kartlarını, `decisions/*.md` dosyalarını ve config'teki
`memoryDirs` klasörlerindeki `.md` dosyalarını tarar; metindeki T…/F-…/D-… atıflarının bulunduğu cümleyi
gerçek kaydın durumuyla karşılaştırır.

```
vlad kb lint [--project <slug>] [--strict] [--json]
```

- Çıkış kodu: işaret varsa **0** (bilgi); hata (ör. bilinmeyen proje) **1**; `--strict` ile işaret varsa **1**.
- `memoryDirs` (vlad.config.json, isteğe bağlı): `["C:\Users\<ad>\.claude\projects\<proje>\memory"]`; mutlak ya da VLAD_HOME'a göreli. Yoksa hafıza taranmaz; okunamayan klasör `warnings`'e yazılıp atlanır.
- Taranmayanlar: kod çitleri (```), `src/kb/derived.ts` işaretleri (`<!-- vlad:derived NAME -->` … `<!-- /vlad:derived -->`) arasındaki türetilmiş bloklar.
- Bağlam yalnız ID'nin bulunduğu **cümlede** aranır (`. ; ! ?` sınırı); "açık değil", "bekleyen iş yok", "kalmadı" olumsuzlamaları sayılmaz. `## Son aktivite` altındaki tarihle başlayan satırlar tarihsel anlatıdır, işaretlenmez. `## Açık konular` altında kapalı bir kaydı anmak her zaman işarettir.

## Kodlar

| kod | ne zaman |
|---|---|
| `closed_finding_listed_open` | `fixed`/`wontfix` bulgu Açık konular'da ya da açık/bekliyor/yapılacak bağlamında |
| `finished_task_listed_active` | `done`/`cancelled` görev Açık konular'da ya da sürüyor/devam ediyor/çalışıyor/bekliyor bağlamında |
| `inactive_decision_listed_valid` | `geçersiz`/`yerine-geçti` karar "geçerli kararlar" listesinde |
| `expired_decision_valid` | `Durum: geçerli` kararın başlık/metnindeki "… 2026-10-28 08:00'e kadar" (ya da `until YYYY-MM-DD`) süresi geçmiş; yalnız saat verilmediyse gün sonu |
| `memory_stale_task` | hafıza notu `done`/`cancelled` göreve bağlı yetki/plan içeriyor ("yalnız T… çatısı", "… bitince") |
| `summary_stale` | kartın `## Durum özeti` tazeliği `bayat` ya da `yok` (aktif projeler; `vlad project status` ile aynı sinyal) |

## `--json` şeması

```json
{
  "flags": [{
    "code": "closed_finding_listed_open",
    "file": "projects/vlad.md",        // kb'ye göre göreli; hafıza dosyalarında mutlak yol
    "line": 13,                         // 1 tabanlı, dosyanın tamamında
    "id": "F-vlad-160",                 // summary_stale için proje slug'ı
    "actual_state": "fixed",            // kayıttaki gerçek durum (fixed, done, geçersiz, bayat, yok, ...)
    "message": "…", "suggestion": "…",
    "project": "vlad"                   // null: projesi bilinmeyen hafıza notu
  }],
  "counts": { "closed_finding_listed_open": 1 },
  "scanned": { "projects": 1, "decisions": 1, "memory": 0 },
  "warnings": []
}
```

İşaretler proje, dosya, satır sırasıyla gelir; insan okunur çıktı projeye göre gruplanır.

## Entegrasyon (T20261103-13)

- **Önbellek ve `status --summary`:** `vlad kb lint` (`--project` olmadan) bitince özetini `kb/logs/kb-lint.json`'a yazar (`{count, byCode, at}`; `logs/` kb reposunda gitignored; yazılamazsa sessizce atlanır). `vlad status --summary` bu dosyayı **okur**, lint çalıştırmaz (tüm kb ~75 sn, hook bütçesi 1–2 sn): satıra `N kb çelişkisi` eklenir, 24 saatten eskiyse `(lint N gün önce)`; JSON'da `kbLint: {count, byCode, at}` (önbellek yoksa `{count: 0, byCode: {}, at: null}`). `summary_stale` sayıya girmez; bayat özet zaten ayrı bildirilir (`staleSummaries`). Önbelleği yenileyen: `/digest` §5c ve gece modu sabah raporu (`/status`).
- **Süreli karar:** `vlad decision add --until <YYYY-MM-DD | YYYY-MM-DDTHH:MM[:SS][±hh:mm]>` kararın başlığının altına `- **Süre:** <değer>` satırı yazar (yalnız tarih: o günün sonuna kadar yerel saat; geçersiz tarih hata verir). Süre geçince `expired_decision_valid` (`--until` varsa metindeki "…'e kadar" tarihinden önceliklidir), `vlad project status` (`decisions.expired`, son kararlarda `expired: true`) ve `vlad decision list` ("doldu") işaretler. Karar otomatik geçersiz olmaz: yenile (`decision add --supersedes`) ya da `decision set <id> geçersiz`.
- **Hafıza dizini:** config `memoryDirs` yoksa varsayılan `~/.claude/projects/<VLAD_HOME'da harf/rakam dışı her karakter → ->/memory` (Windows'ta `%USERPROFILE%\.claude\projects\C--dev-vlad\memory`). Dizin yoksa (bulut, başka makine) uyarı bile vermeden atlanır; okunamayan dizin uyarı verir.
