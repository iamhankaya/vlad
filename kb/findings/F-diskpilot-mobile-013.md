---
id: F-diskpilot-mobile-013
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-81
title: Bayat tarama yalnız begin'de kontrol ediliyor
created: 2026-10-22T18:27:13+00:00
updated: 2026-10-22T18:27:13+00:00
---

## Ayrıntı
DeleteFlow.kt:143,200-209; SkipReason.StaleScan kullanılmıyor. Düzeltme: proceed/confirmPermanent'ta yaş yeniden kontrolü.
