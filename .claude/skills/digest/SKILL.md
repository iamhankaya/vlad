---
name: digest
description: İşlenmemiş session raporlarını (kb/inbox) ve biten görevlerin kapanış raporlarını okuyup projelere göre gruplar; günlüğü, proje kartlarının Son aktivite ve Açık konular bölümlerini ve karar günlüğünü günceller, raporları işlenmiş olarak işaretler. Açılış özetinde işlenmemiş rapor varsa ya da kullanıcı "neler oldu", "günlüğü işle" dediğinde kullan.
---

# /digest — session raporlarını hafızaya işle

İki kaynak var:
- **Session raporları:** global SessionEnd hook'unun yazdığı ham raporlar. Her rapor: `session_id`, `cwd`, `project` (null olabilir), `task_id`, `ended`, `git` (branch, son commit'ler, değişen dosyalar), `excerpt` (son mesajlar), `user_message_count`.
- **Biten görevler:** kapanış raporu henüz işlenmemiş `done` görevler. Çalışan pencereleri `vlad task cleanup` ile zorla kapatıldığı için çoğu çalışan session'ının inbox raporu olmaz; o işin kaydı görev dosyasındaki `## Kapanış raporu`'dur.

## 1. Raporları al

```
vlad inbox list --json
vlad task list --undigested --json
```
İlki: `{"items":[{ "file": "...", "record": {...} }, ...]}`. İkincisi: `{"tasks":[{ "id", "project", "title", "updated", ... }]}`; her görev için `kb/tasks/<id>.md`'yi oku (`## Tanım` ve `## Kapanış raporu`). İkisi de boşsa "işlenecek rapor yok" de ve bitir.

Biten görev için olay tarihi `updated`'dır (görevin `done` yapıldığı an). Aynı görevin hem inbox raporu (`task_id` eşleşir) hem kapanış raporu varsa bunları **tek** günlük maddesinde birleştir.

## 2. Grupla ve anla

- `record.project`'e göre grupla; `null` olanları `cwd`'ye bakarak bilinen bir projeye bağlamaya çalış (`vlad project list --json`), olmuyorsa "Diğer" grubuna koy.
- Her session için 1–3 cümlelik özet çıkar: ne yapıldı, ne karar verildi, ne açık kaldı. Dayanak: `excerpt`, `git.recent_commits`, `git.changed_files`. Excerpt yetersizse ve gerçekten gerekiyorsa `transcript_path`'i oku.
- Biten görevler `project` alanına göre gruplanır. Özetin dayanağı kapanış raporudur (yapılanlar, testler, açık noktalar). Açık noktalar kartın `## Açık konular` bölümüne aday olur.
- `task_id` doluysa özeti o görevle ilişkilendir ve görev dosyasına session'ı yaz (görev varsa; yoksa atla):
  ```
  vlad task session <task_id> <session_id> --json
  ```
- Aynı `session_id`'ye sahip birden çok kayıt (devam ettirilmiş session) varsa bunları **tek** bir günlük maddesinde birleştir; her kayıt için ayrı madde yazma. Birleştirilen tüm dosyaları adım 6'da yine kapat.
- Tahmin yürütme; rapordan çıkmayan bir şeyi yazma.

## 3. Günlük

`ended` tarihine (YYYY-MM-DD, yerel) göre her gün için Markdown hazırla:
```markdown
## watchparty
- Oda senkronizasyonu WebSocket'e taşındı; 3 commit. (session abc123, görev T20261015-01)
## Diğer
- ...
```
Her madde kaynak session/görev ID'si taşır. Geçici dosyaya yaz ve:
```
vlad journal append <YYYY-MM-DD> --file <geçici.md> --json
```

## 4. Proje kartları

Etkilenen her proje için `kb/projects/<slug>.md`'yi oku, sonra kartın **tamamını** güncellenmiş hâliyle geçici dosyaya yaz:
- `## Son aktivite`: en yeni olaylar üstte, tarih + kısa özet + kaynak ID; en fazla ~10 madde tut.
- `## Açık konular`: yeni açılanları ekle, kapananları çıkar.
- `last_activity`: en yeni `ended` (mevcuttan yeniyse).
- Diğer bölümleri ve alanları koru.
```
vlad project write <slug> --file <geçici.md> --json
```

## 5. Kararlar

Raporlarda açık bir teknik/ürün kararı varsa (ör. "WebSocket kullanacağız"), her biri için gövde hazırla:
```markdown
- **Karar:** ...
- **Gerekçe:** ...
- **Kaynak:** session <id> / görev <id>
```
```
vlad decision add --project <slug> --title "<kısa başlık>" --body-file <geçici.md> --json
```
Emin olmadığın kararı yazma; kullanıcıya "Bunu karar olarak kaydedeyim mi?" diye sor.

## 6. Raporları kapat

Yalnızca başarıyla işlenen raporları:
```
vlad inbox done <dosya1> <dosya2> ... --json
vlad task digested <id1> <id2> ... --json
```
Bir adım hata verdiyse o raporları inbox'ta, o görevleri işlenmemiş bırak ve kullanıcıya söyle.

## 7. Hafızayı commit'le

```
vlad kb commit "digest <YYYY-MM-DD>" --json
```
Yalnızca `kb/` commit'lenir (inbox ve loglar `.gitignore`'da). Hata verirse kullanıcıya söyle.

## Kullanıcıya göster

Proje başına 1–3 satırlık özet, eklenen kararlar, açık konulardaki değişiklikler ve işlenen rapor sayısı. `task_id` taşıyan ve görevi hâlâ `running` görünen raporlar varsa `/status` öner.
