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
- **Otomatik mod:** kullanıcıya soru soramadığın her bağlamda (`/status`'un otomatik digest adımı, zamanlanmış görev, gece modu) geçerlidir. Kural: **soru sorma, emin olmadığını yazma, listeye ekle.** Şunlar kayda geçmez; bunun yerine `vlad digest pending add --text "<madde, kaynağıyla>" --task <id> --project <slug> --json` çalıştır:
  - adım 5'te "emin olmadığın karar" ("Bunu karar olarak kaydedeyim mi?" diye sorulacak olan);
  - adım 4'te kartın Açık konular'ına "kullanıcı kararı bekliyor" türü madde (3b kontrolü onay bulmadıysa bile yazma, listeye ekle);
  - adım 4b'de önemi belirsiz bulgu (önemi tahmin etme; `bilgi` yazma, listeye ekle).
  Emin olunan her şey (raporun açıkça söylediği sonuç, günlük, bulgular, kart, özet) normal yazılır.
- **Onay bekleyen liste:** `vlad digest pending list [--all] --json` / `done <id> --note "<karar>"`. Kullanıcı bir maddeye karar verince ilgili kaydı (karar/bulgu/kart) CLI ile yaz, sonra maddeyi kapat. `vlad status --summary` açık madde sayısını verir; `CLAUDE.md` Açılış maddeleri gösterir.
- **Güvenlik ağı:** olay tetikli yol (status) kaçırılırsa Mac beyin oturumu için günlük zamanlanmış görev: `docs/otomatik-digest.md`. Bulutta ve Windows'ta güvenlik ağı yoktur.

## 0. Bulutta kb senkronu (`CLAUDE_CODE_REMOTE=true`)

kb ayrı private repoda (`iamhankaya/vlad-kb`; konum: `VLAD_KB_DIR` ya da `vlad.config.json`'daki `kbDir`). Bulutta bu akış kb'ye yazmadan **önce** (ilk yazma komutundan önce, bir kez) kb reposunu eşitle:
```
git -C <kbDir> pull --ff-only
```
Çakışma/ff yapılamazsa **dur**, yazma; kullanıcıya durumu bildir ve nasıl ilerleyeceğini sor. kbDir bulutta yoksa (`vlad` komutları "kb deposu bulunamadı" der) kullanıcıya `add_repo iamhankaya/vlad-kb` + `git clone https://github.com/iamhankaya/vlad-kb <kbDir>` gerektiğini söyle ve dur. Yerelde (`CLAUDE_CODE_REMOTE` yok) bu adım atlanır.

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

**Çok rapor (taslak agent'ları):** Raporlu görev sayısı büyükse (>10) ana bağlamı şişirmemek için proje (pipeline ise çatı) başına bir arka plan agent'ı (`sonnet`) başlat; her agent kendi grubunun görev dosyalarını okuyup günlük, kart, bulgu ve karar **taslağı** döndürür. Agent talimatına adım 3b (kullanıcı onayı kontrolü) aynen girer: onaylanmış konuyu açık nokta yazmasın, kaynağını belirtsin. Agent'lar kb'ye yazmaz; taslakları VLAD kontrol eder, `vlad` CLI ile yazar ve kartı doğrular (adım 3–6 aynen işler).

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

Kapanış raporlarının `### Açık noktalar` bölümündeki (danışman rollerde `### Varsayımlar`, `### Açık sorular ve varsayımlar`; designer'da `### Bulgular`) **ertelenen/çözülmeyen** maddeleri bulgu kaydına geçir; kaybolmasınlar. Çalışanlar maddeleri `- [önem] başlık — ayrıntı` biçiminde yazar; önem yoksa içerikten tahmin etme, kullanıcıya sor (ya da `bilgi`). Yalnızca "yapılmadı / atlandı / sonraya" türü gerçek işleri kaydet; salt bilgi notlarını ve zaten düzeltilmiş maddeleri atla.
1. Önce yinelemeyi önle: `vlad finding list --project <slug> --json`; aynı başlık zaten kayıtlıysa yenisini ekleme.
2. Ayrıntı varsa geçici dosyaya yaz, sonra:
   ```
   vlad finding add --project <slug> --severity <kritik|yüksek|orta|düşük|bilgi> --source <görev-id> --title "<başlık>" [--detail-file <md>] [--state deferred] --json
   ```
   Kullanıcı bilerek ertelediyse `--state deferred`, aksi halde `open`.
3. Rapor bir bulgunun düzeltildiğini söylüyorsa (ör. "F-alpha-003 giderildi"): `vlad finding set <id> fixed --by <görev-id> --json`; "yapmayacağız" kararı için `wontfix`.
4. Kritik/yüksek bulguları kullanıcıya ayrıca belirt.

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

### 5b. Proje durum özeti

Raporlarla etkilenen her proje için (kartlar, bulgular ve kararlar yazıldıktan sonra) kısa, kaynaklı bir durum özeti yaz; amaç ~500–1000 token. Sayıları ve açık kayıt listelerini kendin yazma: `vlad project status <slug> --json` koddan üretir; anlatı yalnız şunları içerir: **son doğrulanmış sonuç**, **mevcut hedef**, **engeller**, **sıradaki adım**, **geçerli karar ID'leri** (D-…); her iddianın yanında kaynak (görev/bulgu/karar ID'si ya da günlük tarihi).
```
vlad project summary <slug> --file <geçici.md> --json
```
Komut ilk satıra "Güncel: <zaman damgası>" ekler; bundan sonra eklenen kayıtlar özeti `bayat` yapar. Doğrula: `vlad project status <slug> --json` → `summary.state` `güncel` olmalı. Bu adımı işlemediğin projede özeti güncelleme (bayat kalması doğrudur). Eski kayıtlar için gerekirse önce `vlad kb search`.

### 5c. kb çelişki denetimi (lint)

Kartlar, özetler, kararlar ve hafıza yazıldıktan sonra tüm kb için bir kez `vlad kb lint --json` çalıştır (büyük kb'de ~75 sn; arka plan agent'ına verilebilir; sonucu `kb/logs/kb-lint.json` önbelleğine yazar ve `vlad status --summary` satırındaki "N kb çelişkisi" buradan gelir). Her işareti (`flags[]`: `code`, `file:line`, `id`, `suggestion`) CLI ile düzelt:
- `closed_finding_listed_open` / `finished_task_listed_active`: kart `## Açık konular`/sürüyor satırı elle yazılmış → `vlad project refresh <slug>`; blok dışı metinde satırı geçmişe çeviren düzeltmeyi `vlad project write` ile yap.
- `inactive_decision_listed_valid`: özet/kart listesinden kaldır (`vlad project summary`); geçerli liste `vlad decision list`.
- `expired_decision_valid`: süre gerçekten dolduysa `vlad decision set <id> geçersiz`; sürüyorsa kararı yeni `--until` ile yenile (`decision add --supersedes <id>`).
- `summary_stale`: adım 5b.
- `memory_stale_task` (hafıza dosyası, kb dışı): VLAD'a "hafızayı güncelle/sil" adımıdır, CLI yok; ilgili hafıza notunu düzeltir ya da silersin ve kullanıcıya söylersin.
Emin olmadığın işareti düzeltme: `vlad digest pending add --text "<kb lint: kod id dosya:satır — ne yapılmalı>" --project <slug>` ile onay bekleyen listeye ekle. Düzeltmelerden sonra `vlad kb lint` yeniden çalıştırıp işaret sayısının düştüğünü doğrula.

## 6. Raporları kapat

Yalnızca başarıyla işlenen raporları:
```
vlad inbox done <dosya1> <dosya2> ... --json
vlad task digested <id1> <id2> ... --json
```
Bir adım hata verdiyse o raporları inbox'ta, o görevleri işlenmemiş bırak ve kullanıcıya söyle.

## 7. Hafızayı commit'le

```
vlad kb commit "digest <YYYY-MM-DD>" --push --json
```
Yalnızca `kb/` commit'lenir (inbox ve loglar `.gitignore`'da). Hata verirse kullanıcıya söyle.

## Kullanıcıya göster

Skill kullanımı: `vlad audit skills --since <son digest tarihi> --json` çıktısının özet oranını ve eksik olanları tek satırda ekle (ayrıntı `/status` retrosundadır).

Proje başına 1–3 satırlık özet, kaydedilen bulgular (kritik/yüksek vurgulu), eklenen kararlar, açık konulardaki değişiklikler ve işlenen rapor sayısı. `task_id` taşıyan ve görevi hâlâ `running` görünen raporlar varsa `/status` öner.
