---
id: F-diskpilot-mobile-003
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-77
title: NFC tekil eşleme (Kelvin K) üst düzey klasör korumasını aşabilir
created: 2026-10-22T16:55:40+00:00
updated: 2026-10-22T16:55:40+00:00
---

## Ayrıntı
model/PathSyntax.kt:240, DefaultProtectionEngine.kt:63. 'AudiobooKs' NFC+lowercase = 'audiobooks'. Düzeltme: ASCII olmayan üst düzey parça asla standart sayılmasın / normalleştirme koruma sınırını değiştiriyorsa reddet. Faz 81.
