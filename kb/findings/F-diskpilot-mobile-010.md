---
id: F-diskpilot-mobile-010
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-81
title: Kısmi silme/NotVerified durumunda rapor başlığı 'Hiçbir şey silinmedi'
created: 2026-10-22T18:27:12+00:00
updated: 2026-10-22T18:27:12+00:00
---

## Ayrıntı
presentation/DeleteFlow.kt:308-309: başlık Failed(…silindi) ve NotVerified'ı saymıyor. Düzeltme: PartiallyDeleted sonucu veya sayaçlı Failed → başlık Partial.
