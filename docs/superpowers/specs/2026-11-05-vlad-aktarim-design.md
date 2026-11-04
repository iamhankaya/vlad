# VLAD aktarım: Mac ↔ Windows ortak pano ve dosya gönderme — tasarım

Tarih: 2026-11-05. Durum: taslak (kullanıcı onayı bekliyor).

## Niyet ve neden

Kullanıcı iki bilgisayarla çalışıyor: Mac mini (VLAD beyni, 192.168.1.33) ve Windows (işçi, 192.168.1.34). İkisi arasında metin ya da dosya taşımanın bugün kolay bir yolu yok. 2026-11-05 gecesi Windows oturumundaki devir notunu Mac oturumuna aktarmak için metni telefondan, Remote Control üzerinden kopyalamak zorunda kaldı. Taşınan şeyler hem metin parçaları (notlar, komutlar) hem de dosyalar (`google-services.json`, ekran görüntüleri) olabiliyor.

Amaç AirDrop/Windrop benzeri, aracısız bir yol:
- **Metin ve resim için ortak pano:** bir makinede kopyalanan öbüründe doğrudan yapıştırılır, ek adım yok.
- **Dosya için açık gönderme:** sağ tık → "Mac'e gönder" / "Windows'a gönder"; dosya karşı makinede İndirilenler'e düşer.
- **CLI:** aynı gönderme bir komutla da yapılabilir, böylece yapay zeka ajanları (VLAD çalışanları, Claude oturumları) da dosya gönderebilir.

## Hedefler

1. Ortak pano, iki yönde: düz metin ve resim (ör. Windows'ta Win+Shift+S ekran görüntüsü → Mac'te Cmd+V; Mac'te ekran görüntüsünü panoya alma → Windows'ta Ctrl+V).
2. Dosya ve klasör gönderme, iki yönde; karşı tarafta kullanıcının İndirilenler klasörü (Mac `~/Downloads`, Windows `%USERPROFILE%\Downloads`).
3. Gönderme yolları: Windows Gezgini sağ tık menüsü, Mac Finder sağ tık menüsü (Hızlı Eylem / Quick Action), CLI.
4. Gelen dosya için kısa sistem bildirimi ("Windows'tan dosya geldi: X").
5. CLI ajanların kullanabileceği biçimde: etkileşimsiz, `--json` çıktılı, açık çıkış kodlu.

## Hedef dışı (ilk sürüm)

- Telefon (Android). İkinci aşamada Mac Agent'ın ev ağında sunduğu bir web sayfası + tek seferlik QR eşleştirme ile eklenecek; bu tasarım onu engellemesin ama kurmasın.
- İnternet üzerinden aktarım; yalnız ev ağı (LAN).
- İkiden fazla makine arasında genel bir eşleştirme sistemi.
- Pano geçmişi, zengin metin (RTF/HTML) ve dosya listesi panosu; yalnız düz metin ve resim.
- Ayrı bir masaüstü uygulaması / arayüz penceresi.

## Başarısızlık sayılacaklar (anti-hedefler)

- Pano senkronunun bir döngüye girmesi (A→B→A sonsuz yankı) ya da kullanıcının yerel kopyaladığını eski bir uzak değerle ezmesi.
- Gelen dosyanın var olan bir dosyanın üzerine yazması.
- Yarım kalmış bir aktarımın İndirilenler'de tam dosya gibi görünmesi.
- VLAD'ın görev/kb işlerini yavaşlatması ya da bozması (aktarım, Agent'ın mevcut op'larını engellememeli).
- Kurulumun elle anahtar/port uğraşı gerektirmesi; mevcut çift anahtar yeterli olmalı.

## Kısıtlar ve mevcut altyapı

- Her iki makinede VLAD Agent çalışıyor: tek TCP portu (7437), HMAC imzalı istekler, ±120 sn tazelik, çift anahtar (D-vlad-057; `vlad.local.json` → `keys.<karşı-taraf>`). Ayrıntı: `docs/machines-agent-security.md`.
- Agent çerçeve sınırı 8 MiB (`MAX_FRAME_BYTES`, `src/agent/frame.ts`); yanıt sınırı 6 MiB. Büyük dosyalar parçalı gönderilmeli.
- Op'lar rol tablosuyla izinli (`src/agent/ops/index.ts` `ALLOWED`); bugün işçi → beyin yalnız `ping`, `apply-write`. Aktarım op'ları iki yönde de izinli olmalı.
- Kanal şifresiz (düz TCP, yalnız imza). Kullanıcı panoda parola/anahtar geçmesinde sakınca görmüyor (2026-11-05); ev ağı varsayımı geçerli.
- Mac Agent launchd ile (com.vlad.agent), Windows Agent oturum açılışında zamanlanmış görevle (VladAgent) başlıyor; ikisi de kullanıcı oturumunda çalışıyor, yani panoya ve kullanıcı klasörlerine erişebilir.
- Mac Agent'ı launchd altında: panoya erişim (pbcopy/pbpaste, NSPasteboard) GUI oturumu gerektirir; LaunchAgent (kullanıcı oturumu) olmalı, LaunchDaemon değil.

## Kullanıcının verdiği kararlar

- Metin: otomatik ortak pano. Dosya: açık gönderme.
- Dosya gönderme: sağ tık menüsü; gelen dosya İndirilenler'e.
- CLI olsun; ajanlar da kullanabilsin.
- Pano resimleri de taşısın.
- İlk sürüm yalnız iki bilgisayar; telefon sonraki aşama.
- Panoda hassas metnin geçmesi sorun değil.

## VLAD'ın önerdiği ve kullanıcının itiraz etmediği

- Aktarım vlad'ın içinde yaşar (yeni CLI komutları + Agent op'ları), ayrı uygulama değil. Kimlik/imza için mevcut Agent kanalı kullanılır; yeni eşleştirme adımı yok.
- Klasörler de gönderilebilir.

## Davranış

### Ortak pano

- Her makinenin Agent'ı yerel panoyu izler (değişim olayı ya da kısa aralıklı yoklama; seçim kurucunun). Yerel değişiklik olunca içerik karşı makineye gönderilir, karşı Agent kendi panosuna yazar.
- Yankı önleme: uzaktan yazılan içerik "uzaktan geldi" olarak işaretlenir (içerik özeti/sayaç); onu yazan Agent bu değişikliği geri göndermez.
- Son yazan kazanır: aynı anda iki tarafta kopyalama olursa zaman damgası yeni olan geçerli.
- Türler: düz metin (UTF-8) ve resim (PNG olarak taşınır; Windows'ta DIB/PNG, Mac'te PNG/TIFF dönüşümü kurucunun).
- Boyut sınırı: metin 1 MiB, resim 20 MiB (kurucunun önerisi; aşan içerik senkronlanmaz, yerelde günlüğe not düşülür).
- Karşı makine kapalı/ulaşılamazsa pano içeriği kuyruğa alınmaz; yalnız son değer anlamlı olduğu için bağlantı geri gelince en son içerik bir kez gönderilebilir (isteğe bağlı, kurucunun).
- Aç/kapa: `vlad clip on|off|status`. Varsayılan açık.

### Dosya gönderme

- CLI: `vlad send <yol...> --to <makine> [--json]`. Birden çok dosya ve klasör kabul eder. Klasör, yapısı korunarak gönderilir.
- Çıkış: başarıda 0, karşı makine ulaşılamazsa 75 (mevcut uzak launch ile tutarlı), diğer hatalarda 1; hata stderr'e `{"error", "details"}` (vlad CLI sözleşmesi).
- `--json` çıktısı: gönderilen her öğe için ad, boyut, karşı taraftaki son yol.
- Parçalı aktarım: çerçeve sınırının altında parçalar; her parça imzalı. Karşı tarafta geçici bir ad altında (ör. `.vlad-part` uzantısı ya da gizli geçici klasör) toplanır, tamamlanınca bütünlük denetimi (SHA-256) yapılır ve son ada atomik taşınır. Yarım aktarım İndirilenler'de görünmez.
- Ad çakışması: var olan dosyanın üzerine yazılmaz; `ad (1).ext`, `ad (2).ext` biçiminde yeni ad verilir (her iki işletim sisteminin alışkanlığı).
- Yol güvenliği: gelen adlar yalnız İndirilenler altında çözülür; `..`, mutlak yol, sürücü harfi, ters bölü/ileri bölü karışıklığı, ayrılmış Windows adları (CON, NUL…) ve işletim sistemine göre geçersiz karakterler temizlenir ya da reddedilir. Sembolik bağlar gönderilmez (izlenmez).
- Boyut: tek aktarımda üst sınır 4 GiB (kurucunun önerisi).
- Bildirim: aktarım bitince karşı makinede sistem bildirimi (Mac Bildirim Merkezi, Windows toast); başlık "<makine>'den dosya geldi", gövde ad ve sayı. Bildirime tıklayınca dosyanın yeri açılırsa iyi olur (kurucunun).
- Gönderen tarafta: CLI ilerleme gösterir (TTY değilse göstermez); sağ tık yolunda tamamlandığında bildirim.

### Sağ tık menüsü

- Windows: Gezgin bağlam menüsünde "Mac'e gönder" (dosya ve klasör). Kurulum `vlad install` içinde (kullanıcı kayıt defteri, yönetici gerektirmeyen yol tercih edilir; ör. HKCU ya da SendTo klasörü).
- Mac: Finder'da "Windows'a gönder" Hızlı Eylemi (Automator/Kısayollar servisi), `vlad install` kurar.
- Her ikisi de arkada `vlad send ... --to <karşı-makine>` çalıştırır; hedef ad config'teki `machines` listesinden gelir.

### Ajanlar için

- `vlad send` etkileşimsizdir ve onay sormaz. VLAD çalışanı (ör. Windows'taki bir görev) ekran görüntüsünü ya da raporu `vlad send shot.png --to mac --json` ile beyne atabilir.
- Pano için ajan komutu: `vlad clip get|set` (yerel panoyu okur/yazar; ortak pano açıksa set karşıya da yayılır). Kurucu bunu ucuz bulursa ekler; bulamazsa hedef dışı bırakıp söyler.

## Güvenlik notları

- Kimlik: istekler mevcut çift anahtarla imzalı; yalnız eşli makine gönderebilir.
- Dikkat (kurucu ele almalı): ele geçirilmiş bir makine karşı makinenin panosuna içerik yazabilir; kullanıcı bunu terminale yapıştırırsa komut çalışır. İlk sürüm için kabul edilen risk olarak belgelenmeli (iki makine de kullanıcının; ev ağı). Pano içeriği hiçbir zaman otomatik çalıştırılmaz.
- Gelen dosya hiçbir zaman otomatik açılmaz/çalıştırılmaz; Windows'ta İnternet'ten geldi işareti (Mark-of-the-Web) eklenip eklenmeyeceği kurucunun kararı, belgelenmeli.
- Kanal şifresiz: içerik ağda düz akar. Kullanıcı kabul etti; belgeye yazılır. Agent TLS (F-vlad-120) gelirse aktarım da ondan yararlanır.
- Bu iş Agent'a yeni yüzey ekliyor (dosya yazma, pano yazma); pipeline'da güvenlik incelemesi (security-reviewer) ve ara Codex kapısı uygulanır.

## Kurucuya bırakılanlar

- Pano izleme yöntemi (olay mı yoklama mı, aralık), resim biçim dönüşümleri, native erişim yolu (PowerShell/.NET, `osascript`/Swift yardımcı, npm paketi).
- Parça boyutu, eşzamanlı parça sayısı, yeniden deneme.
- Sağ tık kurulumunun teknik yolu (HKCU kaydı, SendTo, Quick Action dosyası).
- Bildirim mekanizması.
- Aktarımın Agent'ın mevcut op'larını engellememesi için iş parçacığı/akış düzeni (ör. aktarım op'larının ayrı kuyrukta işlenmesi).

## Sonraki aşama (bu sürümde değil)

- Android telefon: Mac Agent'ın LAN'da sunduğu bir web sayfası; tek seferlik QR ile eşleştirme ve kısa ömürlü belirteç; dosya yükle/indir, ortak panonun son değerini gör/kopyala.
