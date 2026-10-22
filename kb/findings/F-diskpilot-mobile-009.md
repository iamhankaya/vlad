---
id: F-diskpilot-mobile-009
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-81
title: Çöp boşaltma silmesi MATCH_INCLUDE; geri yükleme yarışında çöpte olmayan
  dosya silinebilir
created: 2026-10-22T18:27:12+00:00
updated: 2026-10-22T18:27:12+00:00
---

## Ayrıntı
app/android/MediaStoreTrash.kt:147-148: delete(uri, MATCH_INCLUDE). Düzeltme: MATCH_ONLY (+ _data = ? parametresi).
