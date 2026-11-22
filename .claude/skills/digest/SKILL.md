---
name: digest
description: İşlenmemiş session raporlarını (kb/inbox) ve biten görevlerin kapanış raporlarını okuyup projelere göre gruplar; günlüğü, proje kartlarının Son aktivite ve Açık konular bölümlerini ve karar günlüğünü günceller, raporları işlenmiş olarak işaretler. Açılış özetinde işlenmemiş rapor varsa ya da kullanıcı "neler oldu", "günlüğü işle" dediğinde kullan.
---

# /digest — session raporlarını hafızaya işle

İki kaynak var:
- **Session raporları:** global SessionEnd hook'unun yazdığı ham raporlar. Her rapor: `session_id`, `cwd`, `project` (null olabilir), `task_id`, `ended`, `git` (branch, son commit'ler, değişen dosyalar), `excerpt` (son mesajlar), `user_message_count`.
- **Biten görevler:** kapanış raporu henüz işlenmemiş `done` görevler. Çalışan pencereleri `vlad task cleanup` ile zorla kapatıldığı için çoğu çalışan session'ının inbox raporu olmaz; o işin kaydı görev dosyasındaki `## Kapanış raporu`'dur.

## Otomatik mod ve tek görev kipi (D-vlad-061)

- **Tek görev kipi:** `/digest <görev-id>` yalnız o görevi işler: adım 1'de inbox ve `task list --undigested` yerine `vlad kb get <id> --json` okunur (inbox'ta `task_id` eşleşen kayıt varsa onu da al); adım 2–7 aynen, yalnız o görev (pipeline fazıysa çatı altına yazılır; çatı `done` ise çatı görevi). `/status` görev `done` olunca bunu çağırır.
- **Otomatik mod** (kullanıcıya soru soramadığın her bağlam: `/status`'un otomatik digest adımı, zamanlanmış görev, gece modu): **soru sorma, emin olmadığını yazma, `vlad digest pending add` ile listeye ekle.** Hangi maddelerin kayda geçmediği, onay bekleyen liste komutları ve güvenlik ağı: `reference/otomatik-mod.md` (otomatik modda önce oku).

## 0. Bulutta kb senkronu (`CLAUDE_CODE_REMOTE=true`)

`CLAUDE.md` "Bulutta kb senkronu" bölümü geçerlidir: kb'ye ilk yazmadan önce bir kez uygula; yerelde atla.

## 1. Raporları al

```
vlad inbox list --json
vlad task list --undigested --json
```
İlki: `{"items":[{ "file": "...", "record": {...} }, ...]}`. İkincisi: `{"tasks":[{ "id", "project", "title", "updated", ... }]}`; her görev için `vlad kb get <id> --json` ile (içerik `content` alanında) oku: `## Tanım`, `## İlerleme`, `## Sorular` (cevaplar dahil) ve `## Kapanış raporu`. Pipeline fazında çatının (`parent`) `## İlerleme` bölümünü de oku. Kullanıcı onay/karar/teyitleri çoğunlukla İlerleme ("Kullanıcı teyidi", "[KARAR]") ve Sorular'dadır. İkisi de boşsa "işlenecek rapor yok" de ve bitir.

Biten görev için olay tarihi `updated`'dır (görevin `done` yapıldığı an). Aynı görevin hem inbox raporu (`task_id` eşleşir) hem kapanış raporu varsa bunları **tek** günlük maddesinde birleştir.

## 2. Grupla ve anla

- `record.project`'e göre grupla; `null` olanları `cwd`'ye bakarak bilinen bir projeye bağlamaya çalış (`vlad project list --json`), olmuyorsa "Diğer" grubuna koy.
- Her session için 1–3 cümlelik özet çıkar: ne yapıldı, ne karar verildi, ne açık kaldı. Dayanak: `excerpt`, `git.recent_commits`, `git.changed_files`. Excerpt yetersizse ve gerçekten gerekiyorsa `transcript_path`'i oku.
- Görevin `role` alanı doluysa günlük maddesi rol başlığıyla başlar (ör. "Senior Tester: …"; başlık `vlad role list --json`'dan).
- Biten görevler `project` alanına göre gruplanır. Özetin dayanağı kapanış raporudur (yapılanlar, testler, açık noktalar). Açık noktalar (danışman rol raporlarında eşdeğerleri: `### Varsayımlar`, `### Açık sorular ve varsayımlar`) kartın `## Açık konular` bölümüne aday olur.
- **Pipeline:** `parent`'ı dolu görevleri (fazlar) çatı görev altında topla; ayrı madde yazma. Tek günlük maddesi çatının başlığı ve ID'siyle başlar, fazlar alt madde olur (faz, rol başlığı, bir cümle, görev ID'si). Çatının durumunu `kb/tasks/<parent>.md`'den oku: henüz `done` değilse maddeye "(devam ediyor)" ekle; `done` ise (çatının kapanış raporu yoktur) son kapının sonucunu ve fazların açık noktalarını yaz. Adım 6'da işlenen fazları, çatı listedeyse onu da kapat.
- `task_id` doluysa özeti o görevle ilişkilendir ve görev dosyasına session'ı yaz (görev varsa; yoksa atla):
  ```
  vlad task session <task_id> <session_id> --json
  ```
- Aynı `session_id`'ye sahip birden çok kayıt (devam ettirilmiş session) varsa bunları **tek** bir günlük maddesinde birleştir; her kayıt için ayrı madde yazma. Birleştirilen tüm dosyaları adım 6'da yine kapat.
- Tahmin yürütme; rapordan çıkmayan bir şeyi yazma.

**Çok rapor (>10 görev):** proje/çatı başına bir `sonnet` taslak agent'ı; **agent prompt'una adım 3b (kullanıcı onayı kontrolü) aynen girer** (onaylanmış konuyu açık nokta yazmasın, kaynağını belirtsin). Agent'lar kb'ye yazmaz; taslağı VLAD kontrol eder, `vlad` CLI ile yazar ve kartı doğrular. Önce `reference/toplu-ve-lint.md` §Çok rapor'u oku.

## 3. Günlük

`ended` tarihine (YYYY-MM-DD, yerel) göre her gün için Markdown hazırla:
```markdown
## watchparty
- Oda senkronizasyonu WebSocket'e taşındı; 3 commit. (session abc123, görev T20261015-01)
- Oda sohbeti pipeline'ı (devam ediyor). (görev T20261016-03)
  - spec — Senior Analyst: 5 senaryo, 2 açık soru. (T20261016-04)
  - uygulama — Senior Developer: sohbet modülü + unit testler. (T20261016-06)
## Diğer
- ...
```
Her madde kaynak session/görev ID'si taşır. Geçici dosyaya yaz ve:
```
vlad journal append <YYYY-MM-DD> --file <geçici.md> --json
```

## 3b. Kullanıcı onayı kontrolü (adım 4 ve 4b'den önce)

Bir açık noktayı **bulgu** (4b) ya da kartta **"kullanıcı kararı bekliyor"** türü açık konu (4) olarak yazmadan önce onay/karar/teyit/düzeltme şu kaynaklarda aranır:
- görevin ve çatının `## İlerleme` / `## Sorular` bölümleri;
- projenin kullanıcı listesi görevi (başlığında "Kullanıcıdan beklenenler" geçen açık görev; ör. Ashen için T20261023-96);
- kararlar: `vlad decision list --project <proje> --all --json` ve konuya göre `vlad kb search "<sorgu>" --project <proje> --type decision --json` (eski tek dosya `decisions.md` yalnız `vlad kb maintain` çalışmamış kb'de);
- sonraki fazların kapanış raporları.

Bulunursa madde açılmaz (bulgu varsa doğrudan `fixed`/`wontfix`: `vlad finding set <id> <durum> --by <görev-id>`) ve günlükte kaynağıyla belirtilir ("kullanıcı teyit etti, kaynak: T…/İlerleme"). Gerekçe: 2026-10-25 digest'inde teyitli Zyfen SFX lisansı (F-ashen-bastion-051) bulgu olarak açıldı ve kartlara bayat "kullanıcı kararı bekliyor" maddeleri yazıldı. Kartın `## Çalışma notları`'ndaki 2026-10-22 digest dersiyle (kapanmış maddeyi açık yazma) aynı çizgidedir; o dersi tekrar yazma, ona atıf yap.

## 4. Proje kartları

Etkilenen her proje için `kb/projects/<slug>.md`'yi oku, sonra kartın **tamamını** güncellenmiş hâliyle geçici dosyaya yaz:
- `## Son aktivite`: **elle yazma.** Tamamen koddan üretilir (`<!-- vlad:derived recent-activity -->` bloğu: son ~10 done görev + geçerli karar); bloğu yalnız açık `vlad project refresh` ekler (ilk eklemede mevcut elle satırlar bloğun altında aynen kalır; hiçbir tazeleme blok dışı metni silmez, kancalar blok yoksa kartı değiştirmez). Bloğa elle yazma; bloğu olduğu gibi bırak, eski elle satırları gerekirse `vlad project write` ile sen temizle.
- `## Açık konular`: **bulgu listesini elle yazma.** Açık+ertelenen bulgular `<!-- vlad:derived open-findings -->` bloğunda koddan üretilir (önem sırası, `F-…` ID'leri); bloğa dokunma. Yalnız blok dışındaki elle anlatıyı güncelle (kullanıcı kararı bekleyenler, makine/ortam notları): yeni açılanı ekle, kapananı çıkar.
- `## Çalışma notları`'na **dokunma** (kalıcı dersler; yalnızca `vlad project note` ve retro yazar). Kartı yeniden yazarken bölümü aynen koru.
- `## Durum özeti`'ne **dokunma** (yalnızca `vlad project summary` yazar, adım 5b). Kartı yeniden yazarken bölümü aynen koru.
- `last_activity`: en yeni `ended` (mevcuttan yeniyse).
- Diğer bölümleri ve alanları koru.
- Yeniden yazmadan önce adım 3b'yi uygula: onaylanmış bir konuyu "kullanıcı kararı bekliyor" diye yazma.
```
vlad project write <slug> --file <geçici.md> --json
```
`project write`, `finding add|set` ve `task set <id> done` ilgili kartın türetilen bloğunu kendiliğinden tazeler (`decision add|set` tazelemez); yine de adımların sonunda `vlad project refresh <slug>` (ya da `--all`) çalıştır — blokları kayıtlardan yeniden üretir, blok dışı metne dokunmaz.
**Doğrula:** yazdıktan sonra kartı yeniden oku (`vlad project list --json` ya da kart dosyası) ve türetilen blokların (`open-findings`, `recent-activity`) kayıtlarla uyuştuğunu, elle yazılan Açık konular anlatısının ve `## Çalışma notları`'nın değişmediğini kontrol et (2026-10-25'te Son aktivite/Açık konular yarım uygulandı).

## 4b. Bulgular

Kapanış raporlarının `### Açık noktalar` bölümündeki (danışman rollerde `### Varsayımlar`, `### Açık sorular ve varsayımlar`; designer'da `### Bulgular`) **ertelenen/çözülmeyen** maddeleri bulgu kaydına geçir; kaybolmasınlar. Çalışanlar maddeleri `- [önem] başlık — ayrıntı` biçiminde yazar; önem yoksa içerikten tahmin etme, kullanıcıya sor (ya da `bilgi`; otomatik modda tahmin etme, `digest pending add` ile listeye ekle). Yalnızca "yapılmadı / atlandı / sonraya" türü gerçek işleri kaydet; salt bilgi notlarını ve zaten düzeltilmiş maddeleri atla. Çalışanın kapsam dışı taramada bulup **bilerek dokunmadığı** ve somut etkisi olmadığını yazdığı `düşük`/`bilgi` maddeleri ("bırakıldı", "nadir", "yeni regresyon değil") de bulgu açmaz; yalnız günlük maddesinde tek satır anılır. Bulgu yalnız somut etkisi olan ya da gerçekten ertelenmiş iş için açılır (gerekçe: 2026-11-03 T20261103-28 — iki bulgu kapanırken iki etkisiz kenar notu bulgu olarak açıldı, F-vlad-192/193 wontfix).
1. Önce yinelemeyi önle: `vlad finding list --project <slug> --json`; aynı başlık zaten kayıtlıysa yenisini ekleme.
2. Ayrıntı varsa geçici dosyaya yaz, sonra:
   ```
   vlad finding add --project <slug> --severity <kritik|yüksek|orta|düşük|bilgi> --source <görev-id> --title "<başlık>" [--detail-file <md>] [--state deferred] --json
   ```
   Kullanıcı bilerek ertelediyse `--state deferred`, aksi halde `open`. Çıktıda `warnings: [{"similar": "F-…"}]` (stderr'de "uyarı: benzer açık bulgu") varsa aynı projede benzer başlıklı açık bulgu var (F-vlad-desktop-166/177 gibi ikizler): yeni kaydı **birleştir** (mevcut bulgunun ayrıntısına not düş, yenisini `vlad finding set <yeni> wontfix --reason "<mevcut ID> ile aynı kök"` ile kapat) ya da emin değilsen `vlad digest pending add` ile onaya taşı; bulgu yine de oluşturulmuştur.
3. **Kapatmayı önce raporun `### Kapatılan bulgular` bölümünden yap** (satır: `F-<proje>-NNN — fixed|zaten düzelmiş — kanıt`): her tam ID için `vlad finding set <id> fixed --by <görev-id> --reason "<kanıt>"`'ı aşağıdaki kurallarla uygula (bilinmeyen/zaten kapalı ID'yi atla ve günlükte an). Bölüm yoksa eski davranış: rapor metni bir bulgunun düzeltildiğini söylüyorsa (ör. "F-alpha-003 giderildi"). **Kısaltılmış/aralık ID'yi (`F-014,017-024`, `F-024`) genişletmeye çalışma**: kapatma, `vlad digest pending add --text "<satır>" --task <id> --project <slug>` ile onaya taşı. Aşağıda: `vlad finding set <id> fixed --by <görev-id> --json`; "yapmayacağız" kararı için `wontfix` (`--reason "<gerekçe>"` zorunlu; bulgu dosyasına `## Kapanış` olarak yazılır). Birden çok bulgu aynı durumdaysa tek komut: `vlad finding set <id1> <id2> … <durum> [--reason …] [--by …]` (hepsi ya da hiçbiri). Uzun süredir açık bulgu yığınını toplu taramak için `/bulgu-tarama`.
4. Kritik/yüksek bulguları kullanıcıya ayrıca belirt.

**Tekrarlayan sınıf:** raporun `### Açık noktalar`'ında `tekrarlayan sınıf: <ad>, önceki: <commit/ID>` satırı varsa (developer kuralı) önem `orta` olan bulgu olarak kaydet (yukarıdaki yinelemeyi önleme kuralıyla: aynı sınıf adı zaten açıksa yenisini açma, mevcut bulgunun ayrıntısına yeni görevi ekle). Bulgu çözen görevde de bu satır `[regresyon]`/`[kalan]` etiketi beklemeden kaydedilir.
**Düzeltme fazı (D-genel-008):** düzeltme fazının raporundan çıkan yeni bulgu yalnız kritik/yüksekse değişiklik turu gerektirir; orta/düşük bulgu `vlad finding add` ile kaydedilir ama tur açmaz, son kapı listesine girer.

**Bulgu çözen görev:** görevin amacı bulgu çözmekse (`## Tanım`/`## Bağlam` bir `F-…`'yi kapatıyor) raporundaki `### Açık noktalar` maddelerinden yalnız şunlar bulgu olur: (i) `[regresyon]` — görevin getirdiği regresyon, (ii) kritik/yüksek önemli madde, (iii) çözülen bulgunun kalan kısmı (`[kalan F-…]`). (iii)'te **yeni bulgu açılmaz**: mevcut bulgu açık kalır (ya da `vlad finding set <id> open`) ve kalan kısım o bulgunun ayrıntısına/günlüğe not edilir. Diğer maddeler raporda kalır, günlükte tek satır anılır; bulgu açılmaz. Çalışan etiketlemediyse raporu okuyup sınıfla; emin olmadığını `vlad digest pending add` ile ekle. Gerekçe: bulgu çözen görev yeni bulgu zinciri üretip hijyeni bozuyordu (kullanıcı, 2026-11-09).

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
Karar yazmadan önce projenin geçerli kararlarına bak (`vlad decision list --project <slug> --json`):
- Yeni karar eskisinin yerine geçiyorsa `--supersedes <eski-id>` ekle (eski otomatik `yerine-geçti` olur, iki yönlü bağlanır).
- Eski karar yerine bir şey gelmeden geçersiz kaldıysa: `vlad decision set <id> geçersiz --json`; yanlışlıkla işaretlenmişse `vlad decision set <id> geçerli`.
- `add` yeni `D-<proje>-NNN` ID'sini döner; günlükte ve özette bu ID ile an.
- Süreli karar (gece yetkisi, "…'e kadar" izni, geçici istisna): `--until <YYYY-MM-DD | YYYY-MM-DDTHH:MM>` ekle. Süre geçince `vlad status`, `project status` ve `kb lint` kararı "süresi dolmuş geçerli karar" diye işaretler; metne tarih gömmek yerine bunu kullan.
Emin olmadığın kararı yazma; kullanıcıya "Bunu karar olarak kaydedeyim mi?" diye sor.

### 5b. Proje durum özeti (atlanamaz son adım)

**Bu adım atlanamaz:** 6. adımdan (`inbox done`, `task digested`) önce, raporlarla etkilenen her proje için çalışır. Özet yazılmadıkça görev özet borcu açık kalır: özet yazılamıyorsa (emin olunmayan içerik, otomatik mod, hata) borç kaybolmasın diye o proje için `vlad digest pending add --text "<proje> özeti yazılamadı: <neden>" --task <id> --project <slug> --json` ekle ve kullanıcıya söyle (sessizce geçme); bu durumda görev yine `task digested` olabilir, özet borcu pending listesinde izlenir. Paused/archived projede 5b zorunlu değildir (`staleSummaries` yalnız aktif projeleri sayar). Raporlarla etkilenen her proje için (kartlar, bulgular ve kararlar yazıldıktan sonra) kısa, kaynaklı bir durum özeti yaz; amaç ~500–1000 token. Sayıları ve açık kayıt listelerini kendin yazma: `vlad project status <slug> --json` koddan üretir; anlatı yalnız şunları içerir: **son doğrulanmış sonuç**, **mevcut hedef**, **engeller**, **sıradaki adım**, **geçerli karar ID'leri** (D-…); her iddianın yanında kaynak (görev/bulgu/karar ID'si ya da günlük tarihi).
```
vlad project summary <slug> --file <geçici.md> --json
```
Komut ilk satıra "Güncel: <zaman damgası>" ekler; bundan sonra eklenen kayıtlar özeti `bayat` yapar. Doğrula: `vlad project status <slug> --json` → `summary.state` `güncel` olmalı. Doğrulama `bayat`/`yok` dönerse özeti yeniden yaz ya da yukarıdaki `digest pending add` ile onaya taşı; "bayat kalması doğrudur" diye geçme. `vlad task set <id> done` zaten `summaryStale: true` + uyarı verir; bu adım o uyarının kapanışıdır. Eski kayıtlar için gerekirse önce `vlad kb search`.

### 5c. kb çelişki denetimi (lint)

Kartlar, özetler, kararlar ve hafıza yazıldıktan sonra tüm kb için bir kez `vlad kb lint --json` çalıştır; her işareti CLI ile düzelt, emin olmadığını `vlad digest pending add` ile onaya taşı, sonra lint'i yeniden koşup sayının düştüğünü doğrula. İşaret koduna göre düzeltme listesi: `reference/toplu-ve-lint.md` §5c.

## 6. Raporları kapat

Yalnızca başarıyla işlenen raporları:
```
vlad inbox done <dosya1> <dosya2> ... --json
vlad task digested <id1> <id2> ... --json
```
Bir adım hata verdiyse o raporları inbox'ta, o görevleri işlenmemiş bırak ve kullanıcıya söyle.

**Arşiv (adım 7'den önce):** `vlad kb maintain --days 14 --json` (varsayılan zaten 14 gün; arşiv şeffaftır, silme yok; `digested` boş `done` görev arşivlenmez, adım 6'da işlenmiş işaretlenenler yaşı dolmuşsa taşınır). Hata verirse kullanıcıya söyle, commit'e devam et.

**Worktree temizliği (F-vlad-375; arşivden sonra, adım 7'den önce):** `vlad task cleanup --merged --dry-run --json` ile bak, sonra `vlad task cleanup --merged --json` çalıştır. Yalnız `done`/`cancelled` olup dalı hedefine (çatı entegrasyon dalı ya da ana dal) tamamen girmiş görevlerin worktree'sini kaldırır; dal silinmez; açık pencere, kirli ya da merge edilmemiş worktree'ye dokunmaz, `atlandı: <id>: <neden>` satırlarını verir. Atlananlardan kullanıcı kararı gerekeni (kirli/merge edilmemiş) söyle; hata verirse (çıkış 1) kullanıcıya söyle, commit'e devam et. Açılış özetinde `UYARI: disk boş alanı …` varsa bu adımı hemen çalıştır.

## 7. Hafızayı commit'le

```
vlad kb commit "digest <YYYY-MM-DD>" --push --json
```
Yalnızca `kb/` commit'lenir (inbox ve loglar `.gitignore`'da). Hata verirse kullanıcıya söyle.

## Kullanıcıya göster

Skill kullanımı: `vlad audit skills --since <son digest tarihi> --json` çıktısının özet oranını ve eksik olanları tek satırda ekle (ayrıntı `/status` retrosundadır).

Proje başına 1–3 satırlık özet, kaydedilen bulgular (kritik/yüksek vurgulu), eklenen kararlar, açık konulardaki değişiklikler ve işlenen rapor sayısı. `task_id` taşıyan ve görevi hâlâ `running` görünen raporlar varsa `/status` öner.
