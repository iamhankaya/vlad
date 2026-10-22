---
id: F-diskpilot-mobile-001
project: diskpilot-mobile
severity: orta
state: fixed
source_task: T20261022-77
title: Ağaç silme yarıda kalınca Skipped(Missing) raporlanıyor
created: 2026-10-22T16:55:39+00:00
updated: 2026-10-22T18:53:05+00:00
fixed: 2026-10-22T18:53:05+00:00
---

## Ayrıntı
core/io/NioPermanentDeleter.kt:185,199,204-207 (yakalama :63-66). İkinci geçişte NoSuchFileException/AccessDenied → N dosya silinmişken Skipped(Missing)/Failed (silinen sayısız). Düzeltme: ikinci geçiş yerel try/catch; deletedFiles>0 ise Failed("…; N dosya, B bayt silindi"); Skipped yalnız hiçbir şeye dokunulmadıysa. Test: ikinci geçişte dosya silen fake. Faz T20261022-81'de, silici yürütücüye bağlanmadan önce.
