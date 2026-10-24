# VLAD mobil — tasarım (Android, Kotlin + Compose)

Kaynak: `docs/superpowers/specs/2026-10-24-vlad-mobile-design.md` §5, §7.3, §11–13. Kullanıcı seçimi: taslak A'nın üst kısmı (senden beklenenler + çalışan satırları) + taslak C'nin sabit sohbet kutusu.
Dosyalar: bu belge (ekranlar, akışlar, durumlar, metinler), `tokens.md` (Compose'a çevrilebilir token'lar), `mockups/index.html` (15 statik ekran; açık/koyu ve "Yazı %200" anahtarı).

## İlkeler

1. **Önce karar.** Kullanıcı telefonu karar vermek için açar: ekranın üstü "Senden bekleniyor", altı sabit sohbet.
2. **Dış eylem = açık metin.** Düğme "ne olacak"ı değil, kart "ne olacak"ı söyler: hedef branch, PR, head SHA. Onay parmak iziyle, SHA'ya bağlı.
3. **Renk tek başına anlam taşımaz.** Her durum: ikon + metin etiketi + renk.
4. **Sessiz uygulama.** Bildirim yalnız karar ve faz sonu; aynı olay tek bildirim.
5. **Kayıpsız.** Hata metinleri "ne oldu, ne kaybolmadı, ne yapabilirsin" söyler (durum `kb/`'dedir).

## Gezinme

Alt gezinme (NavigationBar, 4 hedef, etiket her zaman görünür): **Bugün · Projeler · Hafıza · Ayarlar**. Ayarlar (eşleşmiş cihazlar, tema, bildirim kanalları, çıkış) mockup dışında standart M3 liste; içeriği §Ayarlar'da. Kart ayrıntısı ve proje ayrıntı ekranları üst çubukta geri okuyla açılır; sistem geri hareketi aynı davranır. Bildirim, kartın ayrıntı ekranını doğrudan açar (derin bağlantı `vlad://card/<id>`); geri → Bugün.

## Ekranlar

Mockup numaraları `mockups/index.html`'deki başlıklardır.

### 1–4. Bugün (spec §5.1) — mockup 1, 2, 3, 4
**Amaç:** tek bakışta ne bekliyor, kim çalışıyor; VLAD'la sohbet.
**Yerleşim (yukarıdan aşağı):** üst çubuk (başlık, bildirim geçmişi) → *(varsa)* devralma kartı (§14) → **Senden bekleniyor [sayı]** kartları → **Çalışanlar** satırları → sabit sohbet alanı → alt gezinme. Kaydırılan alan yalnız ortası.

**Senden bekleniyor kartları** (sıra: kırmızı CI/çakışma ve onay kapısı önce, sonra sorular; aynı tür içinde eski önce). Her kart: durum etiketi, proje · faz, başlık (en çok 2 satır), özet (3 satır, sonra "…"), eylemler. Sol 4 dp şerit durum rengi (bekleyen karar `tertiary`, hata `error`).

| Kart türü | Etiket (ikon) | Eylemler (birincil ilk) | Dış etki |
|---|---|---|---|
| Onay kapısı | Onay bekliyor (gavel) | **Merge et** · Rapor · Değişiklik iste | Merge → onay akışı (§5.3) |
| Çalışan sorusu | Soru (help) | **Cevapla** · Ayrıntı | Yok |
| Test itirazı | Test itirazı (help) | **Cevapla** · Ayrıntı | Yok |
| Kırmızı CI / çakışma | Kırmızı CI / Çakışma (warning) | **Ayrıntı** · VLAD'a sor | Yok |
| VLAD sorusu | VLAD soruyor (help) | **Cevapla** | Soru dış eylemse (etiket vb.) cevap bir onay kartına döner |
| Sohbetten istenen eylem | Onay bekliyor (gavel) | **Onayla…** · Vazgeç | Onay akışı |

**Çalışan satırı** (kart değil, liste satırı; çizgiyle ayrılır): durum ikonu, görev adı · faz, durum etiketi + süre, son `[VLAD:LOG]` adımı (1 satır, sonra "…"), ilerleme varsa çubuk (`progressbar`, % metni ekran okuyucuya). Çalışan durumları: Çalışıyor, Takıldı (error), Sınır nedeniyle bekliyor (tertiary; spec §12), Bitti. "Sınır nedeniyle bekliyor" satırı ek açıklama taşır: "Kullanım sınırı yakın; yeni faz başlamadı." ve en altta o durumdaki tüm fazlar için tek *banner* (`banner.lim`) gösterilir.

**Sohbet kutusu** (sabit; `imePadding`): üstte son cevabın akan balonu (en çok 4 satır; dokununca tam sohbet geçmişi sheet'i açılır), altında girdi (56 dp, çok satırda 5 satıra kadar) + gönder düğmesi (48 dp). Cevap parça parça eklenir (caret göstergesi, `aria-live=polite`; her parçada değil cümle sonunda duyurulur). Gönderim sırasında girdi kilitlenmez ama ikinci gönderim sıraya girer; kalıcı oturum meşgulse "VLAD yanıtlıyor…" (düğme "Durdur" olur). Serbest metin "evet" dış eylemi tetiklemez: VLAD bir **onay kartı** üretir, kart Senden bekleniyor'a düşer ve balonda "Onay kartı oluşturdum — Bugün'de" bağlantısı görünür (spec §5.3).

**Durumlar**
| Durum | Davranış / metin |
|---|---|
| Yükleniyor | İlk açılışta iskelet kartlar (2 sn'den uzunsa); sonraki açılışlarda önbellek anında, üstte ince ilerleme çubuğu |
| Boş | İkon + "Senden bekleyen yok" / "Karar gerektiğinde bildirim alırsın." Çalışanlar: "Şu an çalışan yok. VLAD'a "X projesinde Y'yi yap" yazarak başlat." |
| Hata (5xx) | Hata kartı: "Durum alınamadı" / "Sunucu 503 döndü. VLAD oturumu yeniden başlıyor olabilir. Hiçbir şey kaybolmadı: durum kb/'de." + **Yeniden dene**. Sohbet açık kalır |
| Çevrimdışı | Üstte koyu banner "Sunucuya ulaşılamıyor. Son güncelleme 14:02." + Yeniden dene. Önbellekten okuma; **dış eylem ve sohbet kapalı** (onay yalnız güncel SHA'yla). Bağlantı gelince banner kendiliğinden kalkar, snackbar "Bağlandı" |
| Yetkisiz (401: cihaz iptal) | Tam ekran: "Bu cihazın eşleşmesi kaldırıldı." + **Yeniden eşleştir** (§13) |
| Salt okunur (etkin VLAD başka makinede) | Devralma kartı (§14); eylem ve sohbet kapalı |
| Sınır | Çalışan satırı + banner (yukarıda) |

### 5. Kart ayrıntısı — merge kapısı — mockup 5
**Amaç:** karar vermeden önce kanıt görmek.
Üst çubuk: geri + başlık ("Faz PR'ı #52"). Sırayla:
1. Durum etiketi + proje · faz.
2. **"Onaylarsan ne olacak"** kutusu (kenarlık `tertiary`): Eylem (PR #52'yi merge et), **Hedef** branch, **Kaynak** branch, **Head SHA** (12 hane, mono), **Koşul** (CI yeşil, Codex incelemesi). Altında: "SHA değişirse işlem yapılmaz; yeniden onay istenir."
3. **Rapor özeti** (en çok 6 satır) + "Tam raporu oku" (kapanış raporunu açar; salt okunur).
4. **Diff özeti**: "6 dosya · +412 −3" + ilk 10 dosya yolu (mono, kutu içinde yatay kaydırılır, satır sayısı sınırlı; tam diff için GitHub bağlantısı, harici tarayıcı).
5. **İkinci göz bulguları**: iki sütun değil **alt alta** (dar ekran): *Claude* ve *Codex* alt başlıkları; her bulgu: önem etiketi (kritik/yüksek/orta/düşük) + tek cümle. Kritik/yüksek varsa "Merge et" düğmesi **kapalı** ve üstte "Kritik/yüksek bulgu var: merge önerilmez" (spec §7.1); "Değişiklik iste" açık. Codex yoksa: "Codex incelemesi yapılamadı" (kapı kilitlenmez).
6. Alt sabit eylem çubuğu: **Merge et…** (birincil, üç nokta onay adımı olduğunu belirtir) · Değişiklik iste.

"Değişiklik iste": sheet, çok satırlı metin + **Gönder**. Dış etkisi yok (çalışana iletilir), parmak izi gerekmez.

**Durumlar:** yükleniyor (başlık + iskelet), rapor yok ("Rapor henüz gelmedi" — Merge et kapalı), bulgu yok ("Bulgu yok"), CI kırmızı (Merge et kapalı; neden metni), çakışma (aynı, "Çakışma var: çalışan çözmeli"), zaten merge edilmiş ("Merge edildi · a3f9c21" yeşil, eylemler kalkar).

### 6–7. Onay akışı (spec §5.3) — mockup 6, 7
Dış etkili **her** eylem (merge, push, PR, etiket, dış yayın, silme, devredilmeyenler) aynı 5 adımı izler (mockup üstündeki şerit):

1. **Kart / ayrıntı:** "Merge et…" (üç nokta).
2. **Onay sheet'i** (modal bottom sheet): başlık "PR #52'yi merge etmeyi onayla"; **Hedef**, **PR**, **Head SHA** (12 hane), **Etki** ("Geri alınması commit gerektirir."); **Parmak iziyle onayla** (birincil, tam genişlik, 48 dp+) ve **Vazgeç**. Sheet açıkken arka plan scrim; sheet dışına dokunmak vazgeçmektir.
3. **Sistem biyometrik:** `BiometricPrompt`, `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`; başlık "VLAD'ı onayla", alt başlık "PR #52 · a3f9c21e8b04 → vlad/T…-94" (kullanıcı ne onayladığını sistem diyaloğunda da görür). Negatif düğme: "İptal". İmza anahtarı Keystore'da `setUserAuthenticationRequired(true)`; her onayda doğrulama (zaman penceresi yok).
4. **Gönderim:** imzalı istek (eylem, hedef, PR, `expectedHeadSha`, nonce, zaman damgası). Sheet "Gönderiliyor…" gösterir (düğme kapalı, ilerleme göstergesi). Zaman aşımı 20 sn → "Yanıt alınamadı. Merge edildi mi? Kartı yenile." (otomatik yeniden deneme **yok**: çift eylem riski).
5. **Sonuç** (snackbar/kart, sonuç sheet'in yerine geçer):
   - Başarı: snackbar "Merge edildi · a3f9c21"; kart "Bitti" durumuna geçer, Senden bekleniyor'dan kalkar.
   - SHA değişti: hata kartı "PR'a yeni commit düştü — Onayladığın SHA a3f9c21, güncel e07b1d4. Hiçbir şey merge edilmedi." + **Güncel haliyle gözden geçir**.
   - Diğer red sebepleri (aynı biçim): "CI kırmızı", "Onay/devir reddedildi", "Bu cihazın eşleşmesi kaldırıldı", "Cihaz kilidi 3 kez başarısız: 30 sn bekle".
   - Biyometrik iptal/başarısız: hiçbir şey gönderilmez; sheet açık kalır, "Onay verilmedi."

**Yetki devri ile yapılan eylemler** onay istemez, ama bildirimle haber verilir ("Otomatik merge edildi — devir: faz PR'ları, CI yeşil") ve Bugün'de geçmiş satırı olarak 24 saat görünür. Devredilmeyen eylemler (release etiketi, dış yayın, silme, güvenlik etkili karar, kapsam değişikliği) devir olsa bile kart onayı ister.

### 8. Soru / test itirazı — cevapla — mockup 8
Üst: tür etiketi, proje · faz · görev. Gövde: sorunun tam metni. **Hızlı cevap** seçenekleri (çalışan seçenek sunduysa filtre çipi gibi tek seçim) + **Kendi cevabın** çok satırlı alan. Alt sabit: **Cevabı gönder**. Dış etkisi yok, parmak izi yok; ardından kart kalkar, snackbar "Cevap iletildi". Test itirazında ek seçenek: "Tester'a yönlendir". Hata: "Cevap iletilemedi — taslak korundu" (metin kaybolmaz).

### 9–10. Projeler (salt okunur, spec §5.2) — mockup 9, 10
Liste: kart başına ad, tek satır özet (son aktivite), etiketler (açık kritik/yüksek bulgu sayısı `error`, aktif pipeline `primary`). Sıralama: bekleyen karar olanlar önce, sonra son aktivite.
Ayrıntı: üstte üç filtre çipi sekmesi **Özet · Bulgular · Pipeline**.
- **Özet:** kart özeti, son aktivite, açık konular.
- **Bulgular:** önem sırasıyla (kritik → bilgi), her satır: ID (mono), önem etiketi, durum (open/deferred), tek satır başlık; dokununca ayrıntı. Boş: "Açık bulgu yok."
- **Pipeline:** ağaç (çatı → fazlar; bağımlı faz iç içe). Her düğüm: durum etiketi + görev kısa kimliği + faz adı. Dokunma hedefi satır tamamı ≥ 48 dp. Ağaç ekran okuyucuda `tree/treeitem` ("2 / 5 faz bitti" özeti çatıda).
Yüklenemedi / boş durumlar Bugün'dekiyle aynı kalıp (kart içinde hata + Yeniden dene).

### 11–12. Hafıza (salt okunur) — mockup 11, 12
Arama: üstte 56 dp arama alanı (SearchBar), altında filtre çipleri **Tümü · Karar · Günlük · Görev · Rapor · Kart**. Sonuç: kaynak yolu (mono, ikincil), tarih/bölüm, eşleşen satır (vurgu: `tertiaryContainer` zemin, ayrıca altı çizili değil kalın değil — vurgu renk + zemin; ekran okuyucuya "vurgulu" okunmaz, metin zaten okunur). Boş: "Sonuç bulunamadı. Başka kelime dene." Hata: "Arama yapılamadı" + Yeniden dene. Çevrimdışı: son 20 açılan belge önbellekten.
Okuma: salt okunur markdown (başlıklar, listeler, kod blokları; kod blokları kutu içinde yatay kaydırılır, diğer her şey satır kırar). Üstte yol + "salt okunur" etiketi. Yazı boyutu sistemi izler; `bodyLarge`, satır yüksekliği 1,6.

### 13. Eşleştirme (ilk kurulum, spec §6) — mockup 13
Tek ekran, sunucu adresi + kod. Adımlar: (1) kullanıcı sunucuda `vlad pair` çalıştırır (terminalde 6 haneli kod + QR); (2) telefonda **QR tara** (kamera izni isteği öncesi tek cümle gerekçe) ya da 6 haneli kodu yazar; sunucu adresi QR'dan gelir ya da elle girilir; (3) **Eşleştir** → telefon Keystore'da anahtar çifti üretir, açık anahtarı kodla yollar; (4) başarı → Bugün.
Durumlar: kod geçersiz/süresi doldu ("Kod süresi doldu ya da kullanıldı. Sunucuda yeni kod üret."), adres ulaşılamıyor ("Sunucuya ulaşılamıyor. Adresi ve internetini kontrol et."), kamera izni reddedildi ("Kamera izni yok. Kodu elle yazabilirsin."), eşleşiyor (düğme ilerleme göstergesi, kapalı), başarı (kısa onay + yönlendirme). Parola yok; metin: "Telefon kendi anahtarını üretir; cihaz sunucudan iptal edilebilir."
Eşleşmemiş cihaz bu ekran dışında hiçbir şey görmez.

### 14. Etkin VLAD devralma kartı (spec §13) — mockup 14
Bugün'ün en üstünde, kullanılabilir olan her şeyin önünde: "Etkin VLAD başka makinede / Windows VLAD etkin / Son nabız 2 dk önce (14:08). İkisi aynı anda yazmasın diye bu VLAD salt okunur." Eylemler: **Devral** (dış etkisi var: kayıt commit'lenir → onay akışı, parmak izi; hedef "etkin VLAD = sunucu", SHA yerine kayıt revizyonu) · Salt okunur kal. Nabız bayatsa (>5 dk): "Windows VLAD'dan 12 dk'dır ses yok" ve **Devral** birincil. Devralınca: kart kalkar, Windows tarafı bir sonraki yazmada salt okunur olur; snackbar "VLAD etkin oldu. Çalışanlar durmaz."

### 15. Bildirimler — mockup 15
Kanallar: **Karar bekliyor** (yüksek önem, ses+titreşim), **Faz bitti** (normal), **Otomatik işlem** (düşük, sessiz). Aynı olay için tek bildirim (olay kimliğiyle `notificationId`; güncellenirse yerinde değişir). Dokunma → ilgili kartın ayrıntısı. Bildirimde dış eylem düğmesi **yok** (merge bildirimden onaylanmaz); yalnız "Aç".
Bildirim metinleri (başlık / gövde):
| Olay | Başlık | Gövde |
|---|---|---|
| Onay kapısı | Onayın gerekiyor | `<proje> · <faz>: PR #<n> merge kapısında` |
| Soru | Çalışan soruyor | `<proje> · <faz>: <soru ilk 80 karakter>` |
| Test itirazı | Test itirazı | `<proje> · <faz>: <itiraz ilk 80>` |
| Kırmızı CI | CI kırmızı | `<proje> · PR #<n>: <job> başarısız` |
| Çakışma | Merge çakışması | `<proje> · PR #<n> çözülmeyi bekliyor` |
| VLAD sorusu | VLAD soruyor | `<soru ilk 80>` |
| Faz bitti | Faz bitti | `<proje> · <faz>: rapor geldi` |
| Faz merge edildi | Faz merge edildi | `<proje> · <faz>: #<n> merge edildi` |
| Otomatik işlem | Otomatik merge edildi | `<proje> · PR #<n>, devir "<kapsam, koşul>" ile` |
| Sınır | Sınır nedeniyle bekliyor | `<n> faz bekliyor; sınır açılınca devam eder` (yalnız ilk kez, günde en çok 1) |
Kilit ekranında hassas içerik: gövde "Onayın gerekiyor" kısa sürümüne iner (proje adı gizlenir) — cihaz kilitliyken `VISIBILITY_PRIVATE` + herkese açık sürüm "Yeni bir karar bekliyor".

### Ayarlar (mockup dışı, M3 standart liste)
Eşleşmiş cihazlar (bu cihaz, son görülme; cihaz iptali sunucudan, telefonda yalnız "Bu cihazdan çık"), Tema (Sistem/Açık/Koyu), Bildirim kanalları (sistem ayarına bağlantı), Sunucu adresi, Sürüm (APK commit'i), Sunucu durumu (VLAD oturumu canlı mı, son nabız).

## Bileşenler

| Bileşen | Varyantlar | Durum |
|---|---|---|
| `TopBar` | başlık / geri + başlık | M3 `TopAppBar` |
| `BottomNav` | 4 hedef, rozet noktası | M3 `NavigationBar` |
| `DecisionCard` | onay kapısı, soru, test itirazı, CI/çakışma, VLAD sorusu, onay isteği | yeni (M3 `Card` üstü) |
| `WorkerRow` | çalışıyor, takıldı, bekliyor (sınır), bitti; ilerlemeli/ilerlemesiz | yeni |
| `StatusTag` | onay, soru, hata, çalışıyor, bekliyor, bitti, nötr | yeni (M3 `AssistChip` görünümü, tıklanamaz) |
| `ChatDock` | boş, yazıyor, akıyor, kapalı (çevrimdışı/salt okunur) | yeni |
| `StreamBubble` | akıyor, bitti, hata | yeni |
| `ConfirmSheet` | merge, push, PR, etiket, devral | yeni (M3 `ModalBottomSheet`) |
| `FactList` | anahtar–değer (hedef, PR, SHA) | yeni |
| `CodeChip` | SHA, branch, görev ID | yeni (mono) |
| `FindingItem` | Claude, Codex; önem | yeni |
| `PipelineTree` | iç içe düğüm | yeni |
| `SearchResult` | vurgulu metin | yeni |
| `Banner` | çevrimdışı, sınır | yeni |
| `EmptyState`, `ErrorCard`, `SkeletonCard` | — | yeni |
| `Snackbar`, `Button` (filled/tonal/outlined/text/danger), `FilterChip`, `SearchBar`, `TextField` | — | M3 mevcut |

## Erişilebilirlik

- **Dokunma hedefi ≥ 48 dp:** tüm düğme, çip, satır, gezinme hedefi. Görsel küçükse (çip 32 dp) hit-area 48 dp. Bitişik hedefler arası ≥ 8 dp. Durum etiketleri dokunulmaz (hedef değil). Mockup'ta tüm `button`'lar ölçüldü: 0 öğe < 48 px.
- **Kontrast:** metin ≥ 4.5:1, ikon/çerçeve/odak ≥ 3:1, açık ve koyu temada ayrı doğrulanır (tokens.md). Renk tek başına anlam taşımaz (ikon + metin etiketi).
- **Koyu tema:** sistem izler; saf siyah yok (`#0E1514`), yüzeyler 3 kademe (low/container/high) ile ayrışır; kart çerçevesi `outlineVariant`; durum renkleri koyuda açık tonlara kayar (`error` `#F2B8B5`).
- **Büyük yazı (200%) taşmasız:**
  - Tüm metin `sp`; sabit yükseklik yok (yalnız `minHeight`).
  - Metinler kırılır (`overflow-wrap`); başlık ≤ 2 satır sonra "…", ama **eylem düğmeleri ve durum etiketleri asla kırpılmaz** (etiket çok satıra büyür).
  - Eylem düğmeleri satır sığmazsa alt alta dizilir (`FlowRow`); birincil eylem önce.
  - Alt gezinme etiketi tek satır, 2 satıra büyüyebilir, ikon üstte; 4 hedef kalır.
  - **Sohbet alanı** büyük yazıda ekranı yemez: akan cevap balonu 2 satıra iner (dokununca tam geçmiş), girdi 1 satır + gönder; sohbet alanı + gezinme ekranın en çok %45'i.
  - Kod/SHA kutuları kutu içinde kırılır (SHA 12 hanede bile).
  - Doğrulama: mockup `Yazı %200` anahtarı (çerçeve yazı boyutu 14 → 28 px) 15 ekranın hepsinde render edildi, 1× ve 2× görüntülerin farklı olduğu bayt/piksel düzeyinde doğrulandı; yatay taşma yok. Not: statik mockup; Compose'ta `fontScale = 2f` ile `@Preview` ve ekran görüntüsü testleri developer'a bırakıldı (bkz. kabul).
- **Ekran okuyucu (TalkBack):** her kart tek odak grubu; okuma sırası: tür etiketi → proje · faz → başlık → özet → eylemler. İkon-only düğmelerde `contentDescription` ("Gönder", "Geri", "Bildirim geçmişi"). Akan cevap `liveRegion=polite`, cümle sonlarında. İlerleme çubuğu `progressBar` yüzde değeriyle. Sheet açılınca odak başlığa, kapanınca açan düğmeye döner. Ağaç `tree/treeitem`.
- **Hareket:** "hareketi azalt"ta geçişler anlık, caret yanıp sönmez; ilerleme çubuğu kalır (anlam taşır).
- **Odak/klavye:** harici klavyede Tab sırası görsel sırayla; odak halkası 3 dp `primary`.
- **Güvenlik/gizlilik:** `FLAG_SECURE` kapalı (ekran görüntüsü kullanıcı kararı) ama son uygulamalar ekranında içerik gizlenir (onay sheet'i açıkken pencere güvenli).

## Kabul kriterleri

- Tüm ekranlar ve durumlar için mockup + metin: **karşılandı** (15 mockup + bu belge; Ayarlar ve tam sohbet geçmişi sheet'i metinle tanımlı, mockup'ı yok).
- `### Token'lar` tablosu: **karşılandı** (`tokens.md`; rapor metninde de var).
- Dokunma ≥ 48 dp, koyu tema, 200% notları: **karşılandı**.
- Dış eylem kartlarında hedef + SHA, onay akışı çizili: **karşılandı** (mockup 5–7, mockup başı şerit).

## Varsayımlar ve açık noktalar

1. Taslak sayfasına (claude.ai/artifact/PUDq…) erişilmedi; düzen spec §5.1 tarifinden kuruldu.
2. Renk/tipografi spec §10'a göre serbest; marka kararı yok: teal birincil + amber "bekliyor" bir **öneri** (karar kullanıcıya ait; değişirse yalnız `tokens.md` değişir).
3. Kilit ekranında proje adının gizlenmesi (bildirim gizliliği) tasarım varsayımı.
4. Zaman aşımında otomatik yeniden deneme yok (çift merge riski) — sunucu tarafında `nonce` tekilliği ile birlikte düşünülmeli (architect).
5. Mockup'lar statik HTML; Compose çıktısı ve gerçek cihaz TalkBack testi yapılmadı.
6. "Devral" onayı ve Ayarlar → cihaz iptali için sunucu API kapsamı architect planına bağlı.
