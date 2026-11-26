---
name: status
description: Aktif görevlerin durumunu gösterir; onay bekleyen görevler için kapanış raporu ve diff özetini sunup push/PR/merge/değişiklik kararını alır, takılan ve soru soran görevleri yönetir. Kullanıcı "durum ne", "görevler ne alemde", "onay bekleyen var mı" dediğinde veya açılış özeti onay/takılma gösterdiğinde kullan.
---

# /status — görev takibi ve onay

**Onay kapısı:** push, PR ve merge için `CLAUDE.md` "Yetki sınırları" geçerlidir; seçenekleri sun, cevabı bekle; varsayılan eylem yoktur.

## 0. Bulutta kb senkronu (`CLAUDE_CODE_REMOTE=true`)

`CLAUDE.md` "Bulutta kb senkronu" bölümü geçerlidir: kb'ye ilk yazmadan önce bir kez uygula; yerelde atla.

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

### 1b. Bulut görevleri ve 2-cloud. Bulut merge kapıları (`CLAUDE_CODE_REMOTE=true`)

Aktif bulut görevi (`session_id`'li `running`/`blocked`) varsa ya da bulut görevinin merge kapısı geldiyse **önce `reference/bulut.md`'yi oku** ve uygula: yabancı commit kontrolü (`vlad kb check`), `get_session`/`list_events` → `vlad task ingest`, GitHub PR kapıları. Yerelde atla.

### Kapı doğrulaması (`gate`)

Kapı yordamı (gate koşusu, ön kontrol, ingest-preview, kayıt dosyası yeniden üretimi, merge adımları) `integrate` skill'inde tek kaynaktır: kapı eyleminden önce `integrate` skill'ini **Skill aracıyla yükle** (komutları ezberden/kopyadan koşma) ve uygula. Skill yüklenemezse kapı eylemi **durur** ve kullanıcıya söylenir; sessiz yedek yok. Kırmızı gate'te merge önerme. **Merge, push ve PR yine açık onay ister.**

### Uzak makinedeki görev (`vlad machine list`)

Görev beyin dışında bir işçide koşuyorsa kapı komutları uzak op'larla yapılır (`vlad task gate|merge-preview|merge`; çıkış kodu **75** = geçici hata, yerelde elle merge etme). Ayrıntı: `reference/kapi-ayrintilari.md` §Uzak makinedeki görev.

## 2. `awaiting_approval` görevler

`kind: pipeline` (çatı) ise adım 3'teki **son kapıya** git. Diğerleri için görevi `vlad kb get <id> --json` ile oku (arşivdekini de bulur; dosya yolunu varsayma) ve göster:
- `## Kapanış raporu` (ne yapıldı, testler, açık noktalar) — özetle.
- Commit'ler ve diff özeti (worktree frontmatter'daki `worktree`; ana branch `main` değilse repo'nun ana branch'ini kullan; pipeline fazında `main` yerine entegrasyon branch'i `vlad/<çatı-id>`):
  ```
  git -C <worktree> log --oneline main..HEAD
  git -C <worktree> diff --stat main...HEAD
  ```
  Diff ya da test çıktısı uzunsa özeti bir `sonnet` agent'ına yaptırabilirsin (isteğe bağlı; agent yalnız okur, sonucu VLAD kontrol eder).
**`role: tester` ya da `kabul`/`karakterizasyon`/`doğrulama` fazı:** kırmızı test kuralı `reference/kapi-ayrintilari.md` §Tester ve kırmızı testler (`### Kırmızı bırakılan testler`'i seçeneklerden önce göster).
**Güvenlik incelemesi:** kural `integrate` K1'dedir (tetikleyici, kademe, tur sınırı, `exposure` istisnası); merge'den önce uygula.
**Bulgu turu kuralı (D-genel-008):** tek kaynak `digest` §4b (düzeltme fazında yalnız kritik/yüksek yeni bulgu tur açar; orta bulgu fazın merge'ünü durdurmaz, tur açmaz, son kapı listesine girer, düşük/bilgi bulgu olmaz (D-genel-033); bulgu çözen görevin açık noktaları için `digest` skill'ine bak). Toplu kapanış `vlad finding set … --reason …`; eski düşük/bilgi yığını için `/bulgu-tarama`.

**Ara Codex kapısı:** tetikleyici, tur sınırı ve loglama `integrate` K2'dedir; faz merge'ünden önce uygula.

**Test itirazı hızlı yolu:** raporda `### Test itirazı (hızlı yol)` varsa `reference/kapi-ayrintilari.md` §Test itirazı hızlı yolu'nu uygula (yalnız mekanik düzeltme kabul; niyet değişikliği hızlı yol değildir).

**Entegrasyon öncesi kontrol (yalnız pipeline dev fazı, `parent` dolu):** `task close` raporda kanıt satırı yoksa durur; satır var ama sonuç kırmızıysa (çakışma, kırmızı) merge önerme, çalışana düzeltme iste (seçenek 3). Tek görevde bu kanıt istenmez.

**Role/faza özel kapı kontrolleri:** rapor şunlardan biriyse `reference/kapi-ayrintilari.md`'deki bölümü uygula: `denetim` fazı pipeline ortasında (ara denetim); `role: devops` (prova matrisi, canlıya alma önerme); `role: developer` + UI (ekran görüntülü öz-kontrol ve `impeccable audit:` satırı zorunlu, yoksa değişiklik isteğiyle geri çevir); `tasarım` kapısında ek seçim; `role: designer` (görsel onay kapısı, `denetim` bulguları).

Sonra seçenekleri sun:
1. **Merge et:** önce `vlad task close <id> --json` (onaysız: ön kontrol + gate + çakışma, sonra `confirm`'de durur, `summary` hedef/diff'i verir); hedefi kullanıcıya göster, **açık onay** al, sonra `vlad task close <id> --yes --json` (merge, done, cleanup, Kapatılan bulgular, `kb commit --push` tek komutta; ayrıntı `integrate` skill'i). Projeler arası ve bulut PR için `integrate` 5. adım elle. Merge başarısızsa `done` yapma.
2. **Push + PR aç:** onaydan sonra
   `git -C <worktree> push -u origin vlad/<id>` ve `gh pr create --head vlad/<id> --fill` (worktree'de). PR linkini göster. (Pipeline fazında sunulmaz; PR son kapıda açılır.)
3. **Değişiklik iste:** istenen değişikliği al →
   `vlad task log <id> "Değişiklik isteği: <özet>"` ve `vlad task set <id> running --json`.
   Çalışanın session'ı açıksa (`ListAgents`) ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder; kapalıysa kullanıcıya worktree'de devam komutunu öner: `session_id` doluysa `claude --resume <session_id>`, boşsa worktree'deki tek transcript için `claude --resume` (o da yoksa taze oturum; `--continue` önerilmez, F-vlad-097). Research fazında agent'ı değişiklik isteğiyle yeniden çalıştır (`/delegate` 5b).
4. **Olduğu gibi kabul et** (dışa eylem yok). Pipeline **dev** fazında sunma: merge'süz `done`, bağımlı fazların bu değişikliği görmeden başlaması demektir (spec §2, §6). Kullanıcı yine de isterse bu sonucu açıkça söyle ve bağımlı fazları başlatmadan önce ayrıca onay al.
5. **İptal et:** gerekçe **zorunludur** (`--reason` olmadan CLI hata verir); kullanıcıdan kısa gerekçeyi al, yoksa sor. `vlad task set <id> cancelled --reason "<gerekçe>" --json` gerekçeyi `## İlerleme`'ye `İptal: <gerekçe>` olarak yazar (`/setup-audit` bunu sayar); ardından `vlad task cleanup <id> --json`.

Seçenek 1 `task close` ile yapıldıysa `done`/`cleanup` zaten bitmiştir (JSON `steps`; durduysa `stopped_at` adımından sonra aynı komut yeniden koşulur). Seçenek 2 veya 4 tamamlandıktan sonra:
```
vlad task set <id> done --json
vlad task cleanup <id> --json
```
`cleanup` önce çalışanın penceresini (claude dahil) kapatır, sonra worktree'yi kaldırır; branch'i silmez. Bu yüzden `cleanup`'ı yalnızca görev `done`/`cancelled` olduktan sonra çalıştır; "değişiklik iste" akışında çalışma. Merge/push hatası olursa görevi `done` yapma; hatayı göster.
`cleanup` "worktree klasörü silinemedi, çalışan penceresi hâlâ açık olabilir" hatası verirse kullanıcıdan çalışanın penceresini kapatmasını iste, sonra aynı `cleanup` komutunu tekrar çalıştır. Klasörü elle silme.
Kapanan görevin kapanış raporu `/digest` ile günlüğe işlenir; açılış özetindeki "işlenmemiş rapor" sayısına dahildir.
**`task set <id> done` uyarısı:** `--json` çıktısında `summaryStale: true` (+ `warnings`) varsa kartın `## Durum özeti` bu görevi kapsamıyor (özet görevden eski; "bayat" eşiğiyle ilgisi yok); "Görevi digest et (otomatik)" adımı (aşağıdaki bölüm) bunu kapatır (her `done`'da çıkması beklenir: görevin kendisi özetten yenidir), atlandıysa kullanıcıya söyle. `task digested` da özet görevi hâlâ kapsamıyorsa `warnings`'e "özet bu görevi kapsamıyor" yazar (5b atlanmış): özeti yaz. **Digest edilmemiş done görev uyarısı:** `vlad status --summary --json` → `undigested` > 0 ise (özet satırında "N done görev digest edilmedi (en eski: <tarih>)", JSON'da `oldestUndigested`) açılışta tek satır uyarı ver ve `/digest` öner; "Görevi digest et (otomatik)" uygulanmamış demektir.
**Bayat özet kontrolü:** `integrate` K8; görev `done` olduktan sonra uygula.

**kb çelişkisi kontrolü:** `vlad status --summary --json` → `kbLint: {count, byCode, at}` son tam `vlad kb lint` koşusunun önbelleğidir (hook lint çalıştırmaz; `at` boşsa hiç koşulmamış, "lint N gün önce" eskiyi gösterir). `count > 0` ise tek satır söyle ("3 kb çelişkisi: finished_task_listed_active ×3") ve işaretleri düzeltmek için `vlad kb lint --json` + `/digest` §5c öner; süresi dolmuş karar (`project status` → `decisions.expired`) varsa ID'siyle an.
**Görevi digest et (otomatik):** görev `done` olunca bekleme; "Görevi digest et" bölümünü (aşağıda) o görev için uygula (`/digest <id>`, otomatik mod). Tek görev yeter, toplu digest gerekmez. Bunu bayat özet kontrolünden önce yap; digest özeti güncellediği için çoğu zaman `/digest` önerisi gereksiz kalır.
Görevin `parent`'ı doluysa ardından adım 3.

## 3. Pipeline'ı ilerlet

Bir faz `done` olduktan (veya iptal edildikten) sonra:
```
vlad task ready --parent <çatı-id> --json
```
`{"tasks":[...],"held_by_limit":[...],"running":N,"maxParallel":M|null}` — `tasks` `maxParallel` sınırına uyan başlatılabilir fazlardır; `held_by_limit` sınır yüzünden bekleyenlerdir (başlatma; bir çalışan bitince `task ready`'yi tekrar çalıştır, kullanıcıya "N faz maxParallel nedeniyle bekliyor" de). **Entegrasyon dalı kırmızıyken** (son CI/gate koşusu kırmızı; `gh run list --branch vlad/<çatı-id> --limit 1`) yeni faz başlatma ve faz merge etme: önce kırmızıyı düzeltme fazıyla gider. `tasks` içindeki her fazı **sormadan** başlat — kullanıcı pipeline'ı taslakta onayladı: dev → `vlad task launch <id> --json` (**PowerShell aracıyla**, `/delegate` 5a), research → `/delegate` 5b, plan fazı → `/delegate` 6. Kullanıcıya hangi fazların başladığını söyle. Merge kapıları ise her zaman sorulur.

**Tüm fazlar `done`** (`vlad task list --parent <çatı-id> --json`; `cancelled` fazlar yerine yenisi açılmışsa onlar sayılmaz) → `vlad task set <çatı-id> awaiting_approval --json` ve son kapı:
- **`prova` fazı / dispatch iş akışı kontrolü (son kapı):** `reference/kapi-ayrintilari.md` §Son kapı: prova ve dispatch (kırmızı prova canlıya almayı engeller; yalnız entegrasyon dalındaki dispatch iş akışı için uyar).
- Doğrulama fazının sonucunu göster (tüm suite, kırmızı test var mı) ve **kapı doğrulamasını** yap (yukarıdaki "Kapı doğrulaması (`gate`)": kartta `gate` varsa onunla, yoksa ad hoc koşu + uyarı). Yeşil değilse ana branch'e merge önerme; adım 2'deki "yeni uygulama + doğrulama fazı" yolunu öner.
- **Codex review (3. göz), tur sınırı ve yedek:** `integrate` K3–K4 (komutlar `second-opinion`'da). Orta bulgular kapıda listelenir (düşük/bilgi bulgu olmaz, D-genel-033).
- **Çok makineli gate:** `integrate` K6; yeşil satırı eksik makine varken merge/PR önerme.
- **Codex tur ölçümü:** son kapıda karar sunulmadan önce `integrate` K5 satırını yaz.
- Fazların `### Açık noktalar` bölümlerini (danışman rollerde eşdeğerleri) topla ve tek listede göster; ayrıca açık bulguları ekle (`vlad finding list --project <slug> --state open,deferred --json`; kritik/yüksek olanlar kapıda ayrıca vurgulanır); kapsam dışı öneriler (ör. "CI'a ekle") burada kullanıcıya sunulur, istenirse ayrı görev açılır.
- **Çok projeli çatı** (`integration_worktrees` >1): kapı doğrulaması, diff ve merge/PR her projede ayrı, onay ortak; ayrıntı `reference/kapi-ayrintilari.md` §Son kapı: çok projeli çatı.
- Diff özeti: `git -C <çatı worktree> log --oneline main..HEAD` ve `git -C <çatı worktree> diff --stat main...HEAD`.

Seçenekler (açık onay):
1. **Ana branch'e merge:** `git -C <proje-yolu> branch --show-current` ile hedefi göster, onaylat; adımlar `integrate` skill'indedir (`vlad/<çatı-id>`).
2. **Push + PR aç:** `git -C <çatı worktree> push -u origin vlad/<çatı-id>` ve `gh pr create --head vlad/<çatı-id> --fill`.
3. **Değişiklik iste:** çatı altına yeni faz aç (`/delegate` adım 4); çatıyı `vlad task set <çatı-id> running --json` ile geri al.
4. **İptal et:** aşağıdaki "pipeline'ı iptal et".

1 veya 2 tamamlanınca: `vlad task set <çatı-id> done --json` ve `vlad task cleanup <çatı-id> --json` (çatının `integration_worktrees` listesindeki (`vlad task list --json --full`; kısa çıktıda yok) her projedeki entegrasyon worktree'si kaldırılır; diskte olmayan atlanır, branch'ler kalır).

**Faz kapısı ve son kapı digest'i:** her faz `done` olunca (adım 2'deki gibi) o faz görevi, çatı `done` olunca çatı görevi için "Görevi digest et" bölümünü uygula (çatının kapanış raporu yoktur; `/digest` pipeline kuralıyla fazların açık noktalarını işler).
### Görevi digest et (otomatik, D-vlad-061)

Görev `done` olunca `/digest <görev-id>`'yi **otomatik modda yalnız o görev için** uygula (soru yok; emin olunmayanı `vlad digest pending add`'e ekle; hata olursa `digested` işaretleme). Adım sırası ve kullanıcıya tek satır bildirim: `reference/kapi-ayrintilari.md` §Görevi digest et.

### Gece / yetki modu ve bekçi

Gece/yetki modu kuralları (faz ve son kapı merge'ü, push yetkisi, durdurma koşulları, pencere) ve **sabah raporu** `integrate` K7–K8'de tek yerde tanımlıdır; başta `vlad mode status` bak (özet satırında da görünür) ve K7–K8'i uygula.

**Bekçi** (gece modu açıkken ya da `vlad mode watch on`): kendini 20–30 dk arayla uyandır (`/loop` dinamik ya da `ScheduleWakeup`). Her uyanışta `vlad task idle --minutes 30 --json`; listelenen her görev için `gh run list --branch <branch> --limit 1` ile CI'a bak. CI bitmiş ama rapor yoksa, soru `answer`'lanmış ama çalışan sürmemişse ya da 30 dk değişiklik yoksa çalışanı `SendMessage` ile dürt ve `vlad task log <id> "bekçi: dürtüldü (<neden>)"` yaz. Yeni `awaiting_approval`/`blocked` varsa bu skill'in akışını işlet. Bekçiyi `vlad mode off` ya da pencerenin bitişi kapatır.

**Faz `failed`/`cancelled`:** bağımlı fazlar `queued` kalır. Ağaçta göster ve seçenekleri sun:
- **Fazı yeniden oluştur:** aynı faz/rol/bağımlılıkla yeni görev (`/delegate` adım 4). Eski faza bağlı `queued` fazları iptal etmeden yeni ID'ye bağla: `vlad task deps <bağımlı-id> --set <yeni-id,…>` (yalnız `queued` fazda; doğrulama ve döngü kontrolü CLI'dadır).
- **Bağımlılığı kaldırarak devam et:** bağımlı fazları `cancelled` yapıp o bağımlılık olmadan yeniden oluştur, sonra `vlad task ready --parent <çatı-id> --json`.
- **Pipeline'ı iptal et:** açık tüm fazlar için `vlad task set <id> cancelled --reason "<gerekçe>" --json` + `vlad task cleanup <id> --json`, sonra çatı için aynısı.
Kullanıcı döngüyü ortada büyütmek/küçültmek isterse de böyle: çatı altına faz ekle veya fazı iptal et; mevcut fazlar korunur.

## 4. `blocked` görevler

`## Sorular`'daki son **Soru:** satırını göster. Kullanıcı cevaplarsa:
```
vlad task answer <id> "<cevap>" --json
```
Çalışanın session'ı açıksa ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder.

**Test itirazı** (soru `Test itirazı:` ile başlıyorsa): `reference/kapi-ayrintilari.md` §Test itirazı sorusu — tester'a yönlendir ya da VLAD karar verir; testi sen düzenlemezsin; cevap `vlad task answer` + `vlad task log`.

## 5. `stalled` görevler

Son `## İlerleme` satırını ve `session_id`'yi göster. Seçenekler:
Seçenekler: **Devam** (`vlad task resume <id> --json`; hata verirse yanlış worktree'de devam ettirme; local/desktop/cloud kipleri ve `notify_when_idle` aboneliği: `reference/stalled-devam.md`), **uzak makine erişilemiyor** (`vlad machine ping <ad>`, çıkış 75 = tekrar dene; aynı dosya), **İptal** (aşağıda).
- **İptal:** `vlad task set <id> cancelled --reason "<gerekçe>" --json` + `vlad task cleanup <id> --json`.

## 6. Hatalı görevler (`failed` listesi)

`vlad status --json` çıktısındaki `failed` listesini kullan; her biri için `error` alanını göster.
- **`failed` durumundaki dev görevi** (birincil öneri): `vlad task set <id> cancelled --reason "<gerekçe>" --json` → `vlad task cleanup <id> --json` → kullanıcıya yeni bir görev oluşturmayı (`/delegate`) öner. Pipeline fazıysa adım 3'teki "faz `failed`/`cancelled`" seçeneklerini sun.
- **`queued` durumunda `error` dolu görev** (launch başarısız olmuş, worktree geri alınmıştır): yalnızca `vlad task launch <id> --json` ile yeniden dene.
- İstersen iptal de sunulur: `vlad task set <id> cancelled --reason "<gerekçe>" --json` + `vlad task cleanup <id> --json`. Worktree zaten varsa `launch` durur; üzerine yazma, kullanıcıya sor.

## 7. Hafızayı commit'le

Bu akışta görev durumu değiştiyse (done, cancelled, cevap, değişiklik isteği, faz başlatma) sonunda:
```
vlad kb commit "status: <id> <yeni durum>" --push --json
```

## Kullanıcıya göster

Önce tablo (pipeline'lar ağaç), sonra onay/aksiyon bekleyen her görev için ayrı kısa blok ve numaralı seçenekler. Tek seferde bir görev için karar iste.
