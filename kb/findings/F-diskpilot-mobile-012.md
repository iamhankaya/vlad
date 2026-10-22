---
id: F-diskpilot-mobile-012
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-81
title: Durdur sonrası biriken çöp partisi yine gönderiliyor
created: 2026-10-22T18:27:13+00:00
updated: 2026-10-22T18:27:13+00:00
---

## Ayrıntı
DeletionExecutor.kt:57-72: stopped iken flush(). Düzeltme: flush yok, Skipped(Cancelled).
