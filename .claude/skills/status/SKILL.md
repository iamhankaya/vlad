---
name: status
description: Aktif görevlerin durumunu gösterir; onay bekleyen görevler için kapanış raporu ve diff özetini sunup push/PR/merge/değişiklik kararını alır, takılan ve soru soran görevleri yönetir. Kullanıcı "durum ne", "görevler ne alemde", "onay bekleyen var mı" dediğinde veya açılış özeti onay/takılma gösterdiğinde kullan.
---

# /status — görev takibi ve onay

**Onay kapısı:** `git push`, `gh pr create` ve merge yalnızca kullanıcının o görev ve o eylem için verdiği **açık onaydan** sonra yapılır. Seçenekleri sun, cevabı bekle; varsayılan eylem yoktur.

## 1. Durumu oku

```
vlad status --json
```
Çıktı: `counts` (duruma göre sayılar), `active` (aktif görevler), `newlyStalled` (bu çağrıda `stalled` yapılanlar), `failed` (hatalı görevler: `failed` durumundakiler ve `error` alanı dolu `queued` olanlar), `inbox` (işlenmemiş rapor sayısı).

Kullanıcıya önce kısa bir tablo göster: ID, proje, başlık, durum, son güncelleme. `newlyStalled` varsa ayrıca belirt. `inbox > 0` ise sonda `/digest` öner.

## 2. `awaiting_approval` görevler

Her biri için `kb/tasks/<id>.md`'yi oku ve göster:
- `## Kapanış raporu` (ne yapıldı, testler, açık noktalar) — özetle.
- Commit'ler ve diff özeti (worktree frontmatter'daki `worktree`; ana branch `main` değilse repo'nun ana branch'ini kullan):
  ```
  git -C <worktree> log --oneline main..HEAD
  git -C <worktree> diff --stat main...HEAD
  ```
Sonra seçenekleri sun:
1. **Merge et** (yerelde): önce `git -C <proje-yolu> branch --show-current` çalıştır, çıkan branch'i kullanıcıya göster ve merge'ün hedefinin bu branch olduğunu **açıkça onaylat**. Onaydan sonra (`git -C <proje-yolu> status` temiz olmalı)
   `git -C <proje-yolu> merge --no-ff vlad/<id>`
2. **Push + PR aç:** onaydan sonra
   `git -C <worktree> push -u origin vlad/<id>` ve `gh pr create --head vlad/<id> --fill` (worktree'de). PR linkini göster.
3. **Değişiklik iste:** istenen değişikliği al →
   `vlad task log <id> "Değişiklik isteği: <özet>"` ve `vlad task set <id> running --json`.
   Çalışanın session'ı açıksa (`ListAgents`) ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder; kapalıysa kullanıcıya worktree'de devam komutunu öner: `session_id` doluysa `claude --resume <session_id>`, boşsa `claude --continue`.
4. **Olduğu gibi kabul et** (dışa eylem yok).
5. **İptal et:** `vlad task set <id> cancelled --json`, ardından `vlad task cleanup <id> --json`.

Seçenek 1, 2 veya 4 tamamlandıktan sonra:
```
vlad task set <id> done --json
vlad task cleanup <id> --json
```
`cleanup` önce çalışanın penceresini (claude dahil) kapatır, sonra worktree'yi kaldırır; branch'i silmez. Bu yüzden `cleanup`'ı yalnızca görev `done`/`cancelled` olduktan sonra çalıştır; "değişiklik iste" akışında çalışma. Merge/push hatası olursa görevi `done` yapma; hatayı göster.
`cleanup` "worktree klasörü silinemedi, çalışan penceresi hâlâ açık olabilir" hatası verirse kullanıcıdan çalışanın penceresini kapatmasını iste, sonra aynı `cleanup` komutunu tekrar çalıştır. Klasörü elle silme.
Kapanan görevin kapanış raporu `/digest` ile günlüğe işlenir; açılış özetindeki "işlenmemiş rapor" sayısına dahildir.

## 3. `blocked` görevler

`## Sorular`'daki son **Soru:** satırını göster. Kullanıcı cevaplarsa:
```
vlad task answer <id> "<cevap>" --json
```
Çalışanın session'ı açıksa ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder.

## 4. `stalled` görevler

Son `## İlerleme` satırını ve `session_id`'yi göster. Seçenekler:
- **Devam:** `vlad task set <id> running --json`; kullanıcıya worktree'de devam komutunu öner: `session_id` doluysa `claude --resume <session_id>`, boşsa `claude --continue`.
- **İptal:** `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`.

## 5. Hatalı görevler (`failed` listesi)

`vlad status --json` çıktısındaki `failed` listesini kullan; her biri için `error` alanını göster.
- **`failed` durumundaki dev görevi** (birincil öneri): `vlad task set <id> cancelled --json` → `vlad task cleanup <id> --json` → kullanıcıya yeni bir görev oluşturmayı (`/delegate`) öner.
- **`queued` durumunda `error` dolu görev** (launch başarısız olmuş, worktree geri alınmıştır): yalnızca `vlad task launch <id> --json` ile yeniden dene.
- İstersen iptal de sunulur: `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`. Worktree zaten varsa `launch` durur; üzerine yazma, kullanıcıya sor.

## Kullanıcıya göster

Önce tablo, sonra onay/aksiyon bekleyen her görev için ayrı kısa blok ve numaralı seçenekler. Tek seferde bir görev için karar iste.
