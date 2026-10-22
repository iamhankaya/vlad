---
id: F-diskpilot-mobile-007
project: diskpilot-mobile
severity: orta
state: open
source_task: T20261022-81
title: TrashPurge yol kapısı onaylı koruma kurallarından geniş
created: 2026-10-22T18:27:12+00:00
updated: 2026-10-22T18:27:12+00:00
---

## Ayrıntı
core/delete/TrashPaths.kt:26-30, GuardedDeletionGateway.kt:65-67, DeletionExecutor.kt:111-115: kökte standart olmayan klasör, Android/media/<yüklü paket> (WhatsApp Databases/Backups dahil), gizli ara klasörlerdeki is_trashed=1 .trashed- dosyaları boşaltılabiliyor; F-005 gate ve sohbet dışlaması bu rotada yok. Düzeltme: yalnız standart klasörler + .trash-storage, Android/ reddi.
