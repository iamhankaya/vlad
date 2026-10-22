---
id: F-diskpilot-mobile-014
project: diskpilot-mobile
severity: düşük
state: fixed
source_task: T20261022-81
title: F-004 yalnız ilk geçişte görülen dizinleri karşılaştırıyor
created: 2026-10-22T18:27:13+00:00
updated: 2026-10-22T18:43:39+00:00
fixed: 2026-10-22T18:43:39+00:00
---

## Ayrıntı
NioPermanentDeleter.kt:203-224: araya eklenen dizin kontrolsüz. Düzeltme: dirKeys'te olmayan dizinde dur; dosya başına fileKey/boyut.
