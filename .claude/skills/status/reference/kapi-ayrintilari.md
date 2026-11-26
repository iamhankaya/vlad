# status — kapi-ayrintilari (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

### Uzak makinedeki görev (`vlad machine list`, görev bir işçiye yerleşmişse)

Görev beyin dışında bir makinede koşuyorsa (`vlad task list --json` → görevin makinesi; config'te `machines` varken) kapı komutları yerel `git -C` yerine uzak op'larla yapılır (ayrıntı `integrate` skill'inde): `vlad task gate <id> [--target integration|task]`, `vlad task merge-preview <id> [--into <dal>]`, `vlad task merge <id> [--into <dal>] [--message …]`. Görev yerelse bu komutlar reddedilir (`/integrate` yerel akışı). Uzak `merge` push etmez (çakışmada geri alır); push/PR yine yalnız açık onayla. Makine kapalı/ulaşılamazsa komutlar çıkış kodu **75** (geçici hata) verir: sonra tekrar dene, yerelde elle merge etme. Ölü bir makinedeki belirsiz launch rezervasyonu ve pipeline pin'i `vlad task release <id>` ile bırakılır; işçi ulaşılamıyorsa `--force` (işçide yetim pencere kalabilir; kullanıcıya söyle).

## Tester ve kırmızı testler

**`role: tester` ise:** Tester hatayı kanıtlamak için kasıtlı başarısız testler commit'leyebilir. Raporun `### Kırmızı bırakılan testler` bölümünü seçeneklerden önce göster. Liste boş değilse merge ana branch'in test suite'ini kırmızıya çevirir; varsayılan öneri merge değil, `### Önerilen düzeltmeler`'den bir Developer görevi açmaktır (`/delegate`, `--role developer`, kabul kriteri: o testlerin yeşile dönmesi). Merge yine seçenek olarak kalır ama bu riski açıkça söyle.
Pipeline'da kural entegrasyon branch'ine uyarlanır: `kabul`/`karakterizasyon` fazının kırmızı testleri beklenendir (developer'ın hedefi), entegrasyon branch'ine merge varsayılan öneridir. `doğrulama` fazında kırmızı test varsa varsayılan öneri, aynı çatı altında yeni bir `uygulama` fazı (developer, kabul kriteri: o testlerin yeşile dönmesi) ve ona bağlı yeni bir `doğrulama` fazı açmaktır (`/delegate` adım 4). Ana branch'e merge, doğrulama fazı yeşil bitmeden önerilmez.

## Test itirazı hızlı yolu

**Test itirazı hızlı yolu listesi:** raporda `### Test itirazı (hızlı yol)` varsa kapıda her maddeyi gözden geçir: yalnız **mekanik** düzeltmeler (regex, sabit, bayrak, metin/dize, yeni geçerli değer) kabul edilir ve diff yalnız ilgili assert satırlarına dokunmalıdır (`git diff <taban>...HEAD -- <test dosyası>`). Testin **niyetini** değiştiren (bekleneni gevşeten, assert silen, senaryoyu atlayan) bir değişiklik hızlı yol sayılmaz: merge önerme, kullanıcıya göster ve "Test itirazı" akışına (adım 4) çevir ya da değişiklik iste. Liste kullanıcıya özetlenir; tester görevi açıksa ona `vlad task log <tester-id>` ile bilgi düş.

## Role ve faza özel kapı kontrolleri

**Ara denetim (`denetim` fazı pipeline ortasındaysa):** kritik/yüksek bulgular sonraki `uygulama` fazının girdisidir; kalan fazların Tanım'ına ekle (`/delegate` adım 4), orta/düşük bulguları son kapı listesine ekle.

**`role: devops` ise:** `### Prova matrisi`ni ve `### Prova edilemeyenler`'i göster; kırmızı senaryo varsa merge/canlıya alma önerme. Devops gerçek sunucuya dağıtım yapmaz; canlıya alma ayrıca onaylanır.

**`role: developer` ve CLI davranışı/JSON alanı/kavram anlamı değişen faz/görevde (metin etki taraması):** diff `src/` içindeki bir komutun davranışını, `--json` alanını ya da bir kavramın anlamını (ör. eşik) değiştiriyorsa raporun `### Yapılanlar`'ında `Metin etki taraması: <kavram> → <dosya:satır listesi | yok>` satırı olmalı. Satır yoksa merge önerme, değişiklik iste (çalışan `grep -rn` ile skill/doküman metnini tarayıp günceller). Kısa kontrol: `git diff <taban>..<dal> --stat` ile `src/`'de CLI değişikliği var, rapor satırı yok → değişiklik isteği; satırdaki dosya:satır listesi diff'te yoksa da isteği geri çevir. Sözleşme testleri (`test/skills/skill-cli-contract.test.ts`, `test/cli/skill-json-contract.test.ts`) yalnız var olmayan komut/bayrak/alan atfını yakalar, anlam kaymasını yakalamaz.

**`role: developer` ve UI'ya dokunan faz/görevde:** raporun `### Test sonuçları`/`### Açık noktalar`'ında UI öz-kontrolü (ekran görüntüsü) yoksa ya da "öz-kontrol yapılamadı" somut hata çıktısı (denenen komut + hata metni) olmadan yazılmışsa değişiklik isteğiyle geri çevir (gerekçesiz "yapılamadı" kabul edilmez); raporda `impeccable audit:` özet satırı yoksa ya da bulgular ne düzeltilmiş ne `### Açık noktalar`'da ise aynı şekilde sor.

**Tasarım kapısında ek seçim:** kullanıcı `tasarım` kapısında tasarımda çizilmemiş bir ek/varyant seçerse sözleşme fazını başlatmadan önce `delegate` skill'indeki "Tasarımdan sonra gelen kullanıcı seçimi" kuralını uygula (designer ek turu, DESIGN.md'ye ekleme; gece modunda da).

**`role: designer` ise:** `tasarım` fazında `docs/design/` dosyalarını ve `### Token'lar` tablosunu göster; entegrasyon branch'ine merge varsayılan öneridir. **Görsel onay kapısı:** `tasarım` kapısında ekran görüntülerini (`### Görsel yönler` ve `### Görsel turlar`) kullanıcıya göstermeden ve açık görsel onay almadan sonraki uygulama fazlarını başlatma; gece modunda da bu kapı kullanıcıya sorulur, otonom geçilmez. `denetim` fazı kod değiştirmez; `### Bulgular` tablosunu göster. Kritik veya yüksek önemde bulgu varsa varsayılan öneri, doğrulamadaki kırmızı test kuralıyla aynıdır: yeni bir `uygulama` fazı (kabul kriteri: o bulguların giderilmesi) ve ona bağlı yeni `doğrulama` + `denetim` fazları. Yalnızca orta/düşük bulgular varsa bunları son kapıdaki açık noktalar listesine ekle.

## Son kapı: prova ve dispatch

- **`prova` fazı varsa** (devops; `### Prova matrisi`, `### Bulunan hatalar`, `### Prova edilemeyenler` bölümlerini göster): kırmızı senaryo veya çözülmemiş bulunan hata varsa canlıya alma/dağıtım önerme; önce düzeltme fazı öner. `Prova edilemeyenler` doluysa kalan riski kullanıcıya açıkça söyle.
- **Dispatch iş akışı kontrolü:** pipeline `workflow_dispatch` iş akışı eklediyse dosyanın ana dalda olduğunu doğrula (`git -C <proje-yolu> cat-file -e <ana-dal>:<iş-akışı-yolu>`); yalnız entegrasyon dalında varsa merge/PR önermeden önce kullanıcıya "yalnız dispatch iş akışı ana dalda yok" de.

## Son kapı: çok projeli çatı

- Çatı birden çok projede faz çalıştırdıysa (`vlad task list --json --full` → `integration_worktrees` birden fazla satır) kapı doğrulamasını, diff özetini ve merge/PR'ı **her projenin** entegrasyon worktree'sinde ayrı ayrı yap ve sun; son kapı onayı projeler arası ortak tek karardır.

### Görevi digest et (otomatik, D-vlad-061)

Kapanan (`done`) tek görev için `.claude/skills/digest/SKILL.md` akışını **otomatik mod**da yalnız o görev için uygula: `vlad task list --undigested --json` yerine doğrudan `/digest <görev-id>`. Sırayla: günlük, bulgular (`vlad finding add`), kartın Açık konular, durum özeti (`vlad project summary`), `vlad task digested <id>`, `vlad kb commit "digest <id>" --push`. Çok görevli toplu digest bu adımın işi değildir (kullanıcı `/digest` der).

Kullanıcı sorusu yok: emin olunmayan karar ve "kullanıcı kararı bekliyor" maddesi yazılmaz, `vlad digest pending add --text "<madde>" --task <id> --project <slug>` ile onay bekleyen listeye eklenir. Sonunda kullanıcıya tek satır: "digest edildi: <id>; N madde onayını bekliyor" (N = `vlad digest pending list --json`). Digest hata verirse görevi `digested` işaretleme, kullanıcıya söyle; `done` durumu geri alınmaz.

## Test itirazı sorusu (blocked)

**Test itirazı** (soru `Test itirazı:` ile başlıyorsa; developer bir kabul testini yanlış buluyor): soruyu, itiraz edilen testi ve tester'ın görevini (`T…`) kullanıcıya göster, özetle ve şu seçenekleri sun: (a) **tester'a yönlendir** — tester görevi hâlâ açıksa `vlad task log <tester-id> "Test itirazı: …"` düş ve çalışana ilet, kapanmışsa yeni bir kısa `kabul` düzeltme fazı aç (`/delegate` adım 4, rol `tester`); (b) **VLAD karar verir** — spec/sözleşmeye bakıp testin doğru/yanlış olduğunu gerekçesiyle söyle (kullanıcı onayıyla); testi sen düzenlemezsin. Cevabı `vlad task answer` ile developer'a yaz ("test düzeltilecek, şu görev/commit" veya "test doğru, gerekçe"). Karar kullanıcıda değilse bile kayda geçer: `vlad task log`.
