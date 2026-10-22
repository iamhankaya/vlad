---
id: F-diskpilot-mobile-008
project: diskpilot-mobile
severity: orta
state: open
source_task: T20261022-81
title: M9 öğesi MediaStore okunamazsa düz dosya silmesine düşüyor
created: 2026-10-22T18:27:12+00:00
updated: 2026-10-22T18:27:12+00:00
---

## Ayrıntı
presentation/DeleteFlow.kt:151-156, delete/DeletionPlanner.kt:38-44,60-61: rows hatası/satır çöpte değil → M9 adayı Permanent rotasıyla NioPermanentDeleter'a gidiyor. Düzeltme: M9 purge değilse droppedProtected; M9 seçiliyken MediaStore okunamazsa MediaUnreadable reddi.
