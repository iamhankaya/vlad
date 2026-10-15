---
name: vlad-worker
description: VLAD tarafından başlatılmış bir çalışan session'ının protokolü. Başlangıç prompt'u "Sen bir VLAD çalışanısın" diyorsa veya VLAD_TASK_ID ortam değişkeni tanımlıysa, göreve başlamadan önce yükle ve adımları sırayla uygula.
---

# VLAD çalışan protokolü

Sen VLAD'ın devrettiği tek bir görev üzerinde çalışan bir session'sın. Kullanıcıyla Türkçe konuş. **Doğruluk kaynağı görev dosyasıdır**; ilerlemeni, sorularını ve raporunu her zaman `vlad` CLI ile oraya yaz.

## 0. Görevini bul

- Görev ID'si ortamdadır: `VLAD_TASK_ID` (Bash: `echo $VLAD_TASK_ID`, PowerShell: `$env:VLAD_TASK_ID`).
- VLAD kökü: `VLAD_HOME` (yoksa `C:\dev\vlad`). Görev dosyası: `<VLAD_HOME>/kb/tasks/<id>.md`.
- `VLAD_TASK_ID` yoksa dur ve kullanıcıya görev ID'sini sor.

## 1. Oku

- Görev dosyası: `## Tanım`, `## Kabul kriterleri`, `## Bağlam`, frontmatter'daki `project`, `autonomy`, `branch`.
- Proje kartı: `<VLAD_HOME>/kb/projects/<project>.md`.
- Bu dosyaları **elle düzenleme**; yalnızca okursun.
- Çalıştığın klasör görevin worktree'sidir ve `vlad/<id>` branch'indesin (`git branch --show-current` ile doğrula).

## 2. Çalış (yetki seviyene göre)

- `autonomy: plan` → Yalnızca plan yaz, kod yazma. Planı `vlad task report` ile onaya sun (adım 6) ve dur.
- `autonomy: commit` / `pr` → Mevcut iş akışını kullan: brainstorming/plan → TDD → review. Kabul kriterlerinin her birini karşıla.

## 3. İlerleme kaydı

Önemli adımlarda (plan hazır, ilk testler geçti, review bitti vb.):
```
vlad task log <id> "<kısa Türkçe açıklama>"
```
Uzun süre sessiz kalma: kayıt `staleAfterHours`'tan eskirse görev `stalled` sayılır.

## 4. Soru sorma

Kullanıcı kararı gerektiren bir belirsizlikte tahmin yürütme:
```
vlad task ask <id> "<soru, seçenekleriyle>"
```
Ardından **bildirim gönder** (adım 7) ve cevabı bekle. Cevap görev dosyasının `## Sorular` bölümüne `**Cevap:**` olarak yazılır; bildirim gelince veya kullanıcı söyleyince dosyayı yeniden oku.

## 5. Commit ve sınırlar

- Yalnızca `vlad/<id>` branch'inde commit'le.
- `autonomy: pr` ise: `git push -u origin vlad/<id>` ve `gh pr create`.
- **Asla merge etme. Asla başka bir branch'e push etme.** `autonomy: commit` veya `plan` ise hiç push etme.

## 6. Kapanış raporu

Bitince raporu Markdown olarak geçici bir dosyaya yaz. Başlıklar yalnızca `###` veya daha derin olmalı; `## ` ile başlayan satır görev dosyasının bölümünü böler:
```markdown
### Yapılanlar
### Test sonuçları
(çalıştırılan komutlar ve sonuçları)
### Kabul kriterleri
(her biri: karşılandı / karşılanmadı + neden)
### Açık noktalar
```
ve:
```
vlad task report <id> --file <rapor.md>
```
Görev `awaiting_approval` olur. Ardından **bildirim gönder** (adım 7).

## 7. VLAD'a bildirim

Durum değiştiğinde (soru sordun, rapor yazdın):
1. `vlad session name` çalıştır. Başarısızsa bildirimi **sessizce atla**.
2. `ListAgents` çalıştır. Dönen ad listede yoksa bildirimi **sessizce atla**.
3. Varsa:
   `SendMessage({to: "<ad>", message: "VLAD görev <id>: <state> — görev dosyasına bak"})`
   (`<state>`: `blocked`, `awaiting_approval` veya `failed`).

Bildirim yalnızca bir dürtmedir; asıl bilgi görev dosyasındadır. Bildirim gönderilemezse VLAD durumu `/status` ile dosyadan okur — bu bir hata değildir.

## Hata durumu

Görevi tamamlayamıyorsan (ortam bozuk, gereksinim imkânsız) nedenini `vlad task log <id> "…"` ile yaz ve `vlad task set <id> failed` çalıştır, sonra bildirim gönder.
