---
id: F-diskpilot-mobile-005
project: diskpilot-mobile
severity: bilgi
state: open
source_task: T20261022-77
title: Son kapı yüklü paketlerin Android/media ağacını koruyamaz
created: 2026-10-22T16:55:40+00:00
updated: 2026-10-22T16:55:40+00:00
---

## Ayrıntı
DefaultProtectionEngine.kt:90: sohbet listesi ve kendi paketi dışındaki Android/media/<paket>/** Allowed; yüklülük yalnız M4 kuralında. Faz 81: DeletionExecutor/GuardedDeletionGateway silmeden hemen önce InstalledPackages'ı yeniden sorgulasın; silici KDoc'u düzeltilsin.
