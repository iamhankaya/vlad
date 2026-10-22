---
id: F-diskpilot-mobile-011
project: diskpilot-mobile
severity: düşük
state: fixed
source_task: T20261022-81
title: Son kapı belirteci tek kullanımlık değil, itemKey rota/mediaId içermiyor
created: 2026-10-22T18:27:12+00:00
updated: 2026-10-22T18:43:39+00:00
fixed: 2026-10-22T18:43:39+00:00
---

## Ayrıntı
GuardedDeletionGateway.kt:61-64, Delete.kt:34-35,60: covers üyeliği; itemKey = candidateId|path|mode. Bugün sömürülemez (kapı yalnız AppContainer'da). Düzeltme: route (+mediaId) itemKey'e; kapıda da tek kullanım.
