---
id: F-diskpilot-mobile-002
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-77
title: Unicode case folding (ſ) yasak listelerini aşabilir
created: 2026-10-22T16:55:40+00:00
updated: 2026-10-22T16:55:40+00:00
---

## Ayrıntı
protect/DefaultProtectionEngine.kt:78-90. 'Databaſes'.lowercase(ROOT) != 'databases'; casefold dosya sisteminde Databases/kendi paketi yasakları aşılabilir. Gerçekçilik düşük (yollar tarayıcıdan gelir). Düzeltme: ASCII dışı paket/parça adını reddet veya tam case folding; contract tablosuna ſ satırları. Faz 81.
