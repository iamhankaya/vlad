# Dosya aktarımı: alıcı (A1)

Tasarım: `docs/superpowers/specs/2026-11-05-vlad-aktarim-design.md`. Bu belge alıcı tarafını anlatır
(`src/transfer/{paths,receive,ledger}.ts`, `src/platform/notify.ts`). Gönderici ve `vlad send` A2'dedir.

Varsayım: ev ağı. Agent'ın portu (7437) internete açılmamalıdır; güvenlik duvarı/yönlendirme kullanıcı sorumluluğundadır.
Aktarım düz TCP üzerinden imzalı (çift anahtar HMAC) isteklerle gider; içerik ağda şifresizdir.

## Akış

`xfer-begin` → `xfer-chunk`… → `xfer-commit` (ya da `xfer-abort`). Anahtar `ctx.from + "\0" + id`; `id` yalnız 32 küçük harf hex.
Durumlar: `receiving → committing → committed | aborted`. Aktarım başına bir mutex tüm op'ları sıralar.

- **begin:** manifest doğrulanır (`bad_request: manifest geçersiz: …`, `bad_request: yol geçersiz: …`). Aynı id + aynı manifest idempotenttir
  (`receiving` ise `received` döner, ilerleme sıfırlanmaz). Teslim kaydında `committed` varsa `state:"committed"` + `items` döner
  (gönderici yeniden yüklemez); `committing` kaydı `uncertain` verir. Ajan yeniden başlamışsa (bellek kaybı) hazırlık klasörü
  sıfırlanıp aynı id ile yeniden başlar.
- **chunk:** `offset == alınan` ise yazar; geçmiş aralık bayt bayt aynıysa "zaten alındı" döner, farklıysa `conflict`. Beyan boyutu aşılamaz.
- **commit:** her dosyada boyut ve SHA-256 doğrulanır, sonra öğe başına atomik yayımlanır. Tekrar commit aynı sonucu verir.
- **abort:** hazırlık silinir; olmayan aktarım için idempotenttir.

## Yol güvenliği (alıcı tek yetkili)

`sanitizeEntryPath`: boş/mutlak/`.`/`..`/boş bileşen, `\`, `:` (ADS), denetim ve yön geçersiz kılma karakterleri, bileşen ≤ 255,
toplam ≤ 240, derinlik ≤ 32, `.vlad-incoming` üst düzey adı reddedilir; NFC'ye normalleştirilir. Windows alıcıda ek olarak
`<>"|?*`, sondaki nokta/boşluk ve ayrılmış adlar (`CON`, `COM¹`, `CON.tar.gz`…). Manifestte aynı yol (harf duyarsız), `a` ile `a/b`
birlikte ve ata bileşenlerde harf çakışması reddedilir; en çok 10.000 öğe, 4 GiB toplam.

Hazırlık: `<İndirilenler>/.vlad-incoming/<id>/` (0700, `meta.json`), dosyalar `O_EXCL` ile oluşur, alıcı yalnız normal dosya ve dizin yaratır.
Hazırlık kökü ve klasörü `lstat` ile symlink olmadığı doğrulanır.

## Teslim garantisi

Öğe (üst düzey dosya/dizin) başına atomik: bir öğe ya tamamen İndirilenler'dedir ya hiç yoktur. Dosya `link` (+ `EXDEV/ENOTSUP/EPERM` için
`copyFile` `COPYFILE_EXCL` yedeği), dizin POSIX'te `mkdir` rezervasyonu + `rename` (Windows'ta `rename`) ile yayımlanır. Ad çakışmasında
harf duyarsız `ad (1).ext` seçilir; mevcut dosya, dizin ya da (kırık) symlink asla ezilmez. Çoklu öğede biri başarısız olursa öncekiler kalır;
sonuç `{items, failed}` döner (hiç öğe yayımlanmadıysa istek hata verir). Kısmi başarıda kayıt `committing` kalır: tekrar commit `uncertain` döner
(otomatik yeni id yok).

Teslim kaydı: `<stateDir>/xfer/delivered/<sha256(anahtar)>.json`, atomik temp+rename. Yayımlamadan önce `committing`, her öğeden sonra
güncellenir, bitince `committed`. Yayımlama sırasında çökme → `uncertain: teslim sonucu belirsiz; İndirilenler'e bak`.

## Kaynak sınırları

Atomik kapasite rezervasyonu (`statfs` + rezerve edilen toplam, 1 GiB boş tampon), 8 GiB hazırlık kotası (yetim klasörler dahil),
en çok 4 etkin aktarım, 5 dk etkinlik zaman aşımı, yetim `.vlad-incoming/<id>` 24 saat sonra süpürülür. Süpürme yalnız `meta.json` sahipli,
etkin olmayan, `<id>` biçimli klasörleri siler; sembolik bağı izlemez, kullanıcı dosyalarına dokunmaz. Alıcıda yalnız `fs.promises` kullanılır
(Agent op'larını engellemez). Hata eşlemesi: `ENOSPC` → `too_large: boş alan yetersiz`; `EPERM/EACCES` → `failed: İndirilenler erişimi reddedildi
(macOS Gizlilik: Dosyalar ve Klasörler)`.

## clip-image

`purpose: "clip-image"`: tek `clip.png`, ≤ 20 MiB, `meta {eventTs, rank}` zorunlu; commit'te PNG imzası + IHDR boyut sınırı (w·h ≤ 64 000 000),
sonra `ClipImageSink.apply`. İndirilenler'de iz ve bildirim yok; teslim kaydı yazılır (çift uygulama engeli).

## Bildirim

`<makine>'den dosya geldi`; çoklu öğede tek bildirim. Metin Mac'te `osascript` argv'siyle, Windows'ta `VLAD_TOAST_*` ortam değişkenleriyle
geçer; kabuk dizesine gömülmez. Bildirim hatası teslimi bozmaz. `VLAD_NO_NATIVE=1` iken gerçek çalıştırıcı `NativeDisabledError` verir.

## Bilinen sınırlar

- Mark-of-the-Web / karantina işareti eklenmez (karar `docs/aktarim.md`).
- Kısmi teslim kaydı `committed` değil `committing` kalır (sözleşmedeki `LedgerRecord` değişmedi).
- Windows toast betiği ve Windows `rename` yolları macOS'ta çalıştırılamadı; birim testleri yalnız komut kurucusunu ve `os: "win32"` mantığını sınar.
