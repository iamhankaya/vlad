---
id: F-diskpilot-mobile-004
project: diskpilot-mobile
severity: düşük
state: open
source_task: T20261022-77
title: Silmede TOCTOU (ata dizin bağ/yeniden adlandırma ile değiştirilir)
created: 2026-10-22T16:55:40+00:00
updated: 2026-10-22T16:55:40+00:00
---

## Ayrıntı
io/NioPermanentDeleter.kt:86,131,179-204. JDK openat yok. Android paylaşılan depolamada uygulamaların bağ oluşturamadığı doğrulanmadı. Sertleştirme: postVisitDirectory'de fileKey (inode) ilk geçişle karşılaştır. Faz 83 cihazda ln -s denemesi.
