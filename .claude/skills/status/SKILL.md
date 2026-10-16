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

Kullanıcıya önce kısa bir tablo göster: ID, proje, başlık, rol (`role` doluysa `vlad role list --json`'daki `title`, boşsa "—"), durum, son güncelleme. `newlyStalled` varsa ayrıca belirt. `inbox > 0` ise sonda `/digest` öner.

**Pipeline'lar ağaç olarak:** `kind: pipeline` görevleri (çatı) ve `parent`'ı dolu görevler (fazlar) tabloya düz girmez. Her çatı için `vlad task list --parent <çatı-id> --json` ile tüm fazları al (biten fazlar `active`'te yoktur) ve göster:
```
T20261016-03  watchparty  Oda sohbeti  [pipeline: running]
├─ T20261016-04  spec       Senior Analyst    done
├─ T20261016-05  kabul      Senior Tester     awaiting_approval  ← kapı  (bağımlı: -04)
├─ T20261016-06  uygulama   Senior Developer  running            (bağımlı: -04)
└─ T20261016-07  doğrulama  Senior Tester     queued             (bağımlı: -05, -06)
```
Satırlar: faz (`phase`), rol başlığı, durum, bağımlılık (`depends_on`); bekleyen kapıyı işaretle.

## 2. `awaiting_approval` görevler

`kind: pipeline` (çatı) ise adım 3'teki **son kapıya** git. Diğerleri için `kb/tasks/<id>.md`'yi oku ve göster:
- `## Kapanış raporu` (ne yapıldı, testler, açık noktalar) — özetle.
- Commit'ler ve diff özeti (worktree frontmatter'daki `worktree`; ana branch `main` değilse repo'nun ana branch'ini kullan; pipeline fazında `main` yerine entegrasyon branch'i `vlad/<çatı-id>`):
  ```
  git -C <worktree> log --oneline main..HEAD
  git -C <worktree> diff --stat main...HEAD
  ```
**`role: tester` ise:** Tester hatayı kanıtlamak için kasıtlı başarısız testler commit'leyebilir. Raporun `### Kırmızı bırakılan testler` bölümünü seçeneklerden önce göster. Liste boş değilse merge ana branch'in test suite'ini kırmızıya çevirir; varsayılan öneri merge değil, `### Önerilen düzeltmeler`'den bir Developer görevi açmaktır (`/delegate`, `--role developer`, kabul kriteri: o testlerin yeşile dönmesi). Merge yine seçenek olarak kalır ama bu riski açıkça söyle.
Pipeline'da kural entegrasyon branch'ine uyarlanır: `kabul`/`karakterizasyon` fazının kırmızı testleri beklenendir (developer'ın hedefi), entegrasyon branch'ine merge varsayılan öneridir. `doğrulama` fazında kırmızı test varsa varsayılan öneri, aynı çatı altında yeni bir `uygulama` fazı (developer, kabul kriteri: o testlerin yeşile dönmesi) ve ona bağlı yeni bir `doğrulama` fazı açmaktır (`/delegate` adım 4). Ana branch'e merge, doğrulama fazı yeşil bitmeden önerilmez.

Sonra seçenekleri sun:
1. **Merge et** (yerelde): önce `git -C <proje-yolu> branch --show-current` çalıştır, çıkan branch'i kullanıcıya göster ve merge'ün hedefinin bu branch olduğunu **açıkça onaylat**. Onaydan sonra (`git -C <proje-yolu> status` temiz olmalı)
   `git -C <proje-yolu> merge --no-ff vlad/<id>`
   **Pipeline fazında** hedef ana branch değil entegrasyon branch'idir: hedef olarak `vlad/<çatı-id>`'yi ve çatı görevin `worktree`'sini göster, onaylat; sonra (`git -C <çatı worktree> status` temiz olmalı)
   `git -C <çatı worktree> merge --no-ff vlad/<id>`
   Çakışma olursa `git -C <çatı worktree> merge --abort`, hatayı göster, görevi `done` yapma; seçenek 3 ile developer'a "`vlad/<çatı-id>` üzerine rebase et, çakışmayı çöz" iste. Research fazında merge yoktur; kabul = seçenek 4.
2. **Push + PR aç:** onaydan sonra
   `git -C <worktree> push -u origin vlad/<id>` ve `gh pr create --head vlad/<id> --fill` (worktree'de). PR linkini göster. (Pipeline fazında sunulmaz; PR son kapıda açılır.)
3. **Değişiklik iste:** istenen değişikliği al →
   `vlad task log <id> "Değişiklik isteği: <özet>"` ve `vlad task set <id> running --json`.
   Çalışanın session'ı açıksa (`ListAgents`) ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder; kapalıysa kullanıcıya worktree'de devam komutunu öner: `session_id` doluysa `claude --resume <session_id>`, boşsa `claude --continue`. Research fazında agent'ı değişiklik isteğiyle yeniden çalıştır (`/delegate` 5b).
4. **Olduğu gibi kabul et** (dışa eylem yok). Pipeline **dev** fazında sunma: merge'süz `done`, bağımlı fazların bu değişikliği görmeden başlaması demektir (spec §2, §6). Kullanıcı yine de isterse bu sonucu açıkça söyle ve bağımlı fazları başlatmadan önce ayrıca onay al.
5. **İptal et:** `vlad task set <id> cancelled --json`, ardından `vlad task cleanup <id> --json`.

Seçenek 1, 2 veya 4 tamamlandıktan sonra:
```
vlad task set <id> done --json
vlad task cleanup <id> --json
```
`cleanup` önce çalışanın penceresini (claude dahil) kapatır, sonra worktree'yi kaldırır; branch'i silmez. Bu yüzden `cleanup`'ı yalnızca görev `done`/`cancelled` olduktan sonra çalıştır; "değişiklik iste" akışında çalışma. Merge/push hatası olursa görevi `done` yapma; hatayı göster.
`cleanup` "worktree klasörü silinemedi, çalışan penceresi hâlâ açık olabilir" hatası verirse kullanıcıdan çalışanın penceresini kapatmasını iste, sonra aynı `cleanup` komutunu tekrar çalıştır. Klasörü elle silme.
Kapanan görevin kapanış raporu `/digest` ile günlüğe işlenir; açılış özetindeki "işlenmemiş rapor" sayısına dahildir.
Görevin `parent`'ı doluysa ardından adım 3.

## 3. Pipeline'ı ilerlet

Bir faz `done` olduktan (veya iptal edildikten) sonra:
```
vlad task ready --parent <çatı-id> --json
```
`{"tasks":[...]}` içindeki her fazı **sormadan** başlat — kullanıcı pipeline'ı taslakta onayladı: dev → `vlad task launch <id> --json` (**PowerShell aracıyla**, `/delegate` 5a), research → `/delegate` 5b, plan fazı → `/delegate` 6. Kullanıcıya hangi fazların başladığını söyle. Merge kapıları ise her zaman sorulur.

**Tüm fazlar `done`** (`vlad task list --parent <çatı-id> --json`; `cancelled` fazlar yerine yenisi açılmışsa onlar sayılmaz) → `vlad task set <çatı-id> awaiting_approval --json` ve son kapı:
- Doğrulama fazının sonucunu göster (tüm suite, kırmızı test var mı). Yeşil değilse ana branch'e merge önerme; adım 2'deki "yeni uygulama + doğrulama fazı" yolunu öner.
- Fazların `### Açık noktalar` bölümlerini (danışman rollerde eşdeğerleri) topla ve tek listede göster; kapsam dışı öneriler (ör. "CI'a ekle") burada kullanıcıya sunulur, istenirse ayrı görev açılır.
- Diff özeti: `git -C <çatı worktree> log --oneline main..HEAD` ve `git -C <çatı worktree> diff --stat main...HEAD`.

Seçenekler (açık onay):
1. **Ana branch'e merge:** `git -C <proje-yolu> branch --show-current` ile hedefi göster, onaylat; `git -C <proje-yolu> status` temizse `git -C <proje-yolu> merge --no-ff vlad/<çatı-id>`.
2. **Push + PR aç:** `git -C <çatı worktree> push -u origin vlad/<çatı-id>` ve `gh pr create --head vlad/<çatı-id> --fill`.
3. **Değişiklik iste:** çatı altına yeni faz aç (`/delegate` adım 4); çatıyı `vlad task set <çatı-id> running --json` ile geri al.
4. **İptal et:** aşağıdaki "pipeline'ı iptal et".

1 veya 2 tamamlanınca: `vlad task set <çatı-id> done --json` ve `vlad task cleanup <çatı-id> --json` (entegrasyon worktree'si kaldırılır, branch kalır).

**Faz `failed`/`cancelled`:** bağımlı fazlar `queued` kalır. Ağaçta göster ve seçenekleri sun:
- **Fazı yeniden oluştur:** aynı faz/rol/bağımlılıkla yeni görev (`/delegate` adım 4). Eski faza bağlı fazlar yeni ID'yi beklemez; onları `cancelled` yapıp yeni faza bağlı olarak yeniden oluştur.
- **Bağımlılığı kaldırarak devam et:** bağımlı fazları `cancelled` yapıp o bağımlılık olmadan yeniden oluştur, sonra `vlad task ready --parent <çatı-id> --json`.
- **Pipeline'ı iptal et:** açık tüm fazlar için `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`, sonra çatı için aynısı.
Kullanıcı döngüyü ortada büyütmek/küçültmek isterse de böyle: çatı altına faz ekle veya fazı iptal et; mevcut fazlar korunur.

## 4. `blocked` görevler

`## Sorular`'daki son **Soru:** satırını göster. Kullanıcı cevaplarsa:
```
vlad task answer <id> "<cevap>" --json
```
Çalışanın session'ı açıksa ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder.

## 5. `stalled` görevler

Son `## İlerleme` satırını ve `session_id`'yi göster. Seçenekler:
- **Devam:** `vlad task set <id> running --json`; kullanıcıya worktree'de devam komutunu öner: `session_id` doluysa `claude --resume <session_id>`, boşsa `claude --continue`.
- **İptal:** `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`.

## 6. Hatalı görevler (`failed` listesi)

`vlad status --json` çıktısındaki `failed` listesini kullan; her biri için `error` alanını göster.
- **`failed` durumundaki dev görevi** (birincil öneri): `vlad task set <id> cancelled --json` → `vlad task cleanup <id> --json` → kullanıcıya yeni bir görev oluşturmayı (`/delegate`) öner. Pipeline fazıysa adım 3'teki "faz `failed`/`cancelled`" seçeneklerini sun.
- **`queued` durumunda `error` dolu görev** (launch başarısız olmuş, worktree geri alınmıştır): yalnızca `vlad task launch <id> --json` ile yeniden dene.
- İstersen iptal de sunulur: `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`. Worktree zaten varsa `launch` durur; üzerine yazma, kullanıcıya sor.

## 7. Hafızayı commit'le

Bu akışta görev durumu değiştiyse (done, cancelled, cevap, değişiklik isteği, faz başlatma) sonunda:
```
vlad kb commit "status: <id> <yeni durum>" --push --json
```

## Kullanıcıya göster

Önce tablo (pipeline'lar ağaç), sonra onay/aksiyon bekleyen her görev için ayrı kısa blok ve numaralı seçenekler. Tek seferde bir görev için karar iste.
