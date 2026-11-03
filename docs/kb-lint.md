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
