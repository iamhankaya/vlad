# VLAD aktarım: Mac ↔ Windows dosya ve pano

İki makine arasında dosya gönderme ve ortak pano. Ayrıntı: dosya gönderme [aktarim-dosya.md](aktarim-dosya.md), pano [aktarim-pano.md](aktarim-pano.md). Tasarım: `docs/superpowers/specs/2026-11-05-vlad-aktarim-design.md`.

## Kurulum

1. İki makinede de `vlad agent` çalışır ve çift anahtar kuruludur (`docs/machines-setup.md`). Aktarım yeni Agent op'ları ekler: **Agent'ı iki makinede de yeniden başlat**; eski Agent `karşı Agent güncel değil (xfer yok)` hatası verir.
2. `vlad install` çalıştır (iki makinede de). `machines` tanımlıysa, bu makinenin kimliği (`VLAD_MACHINE` ya da `vlad.local.json` `self`) bilinirse ve karşı makine tekse sağ tık menüsünü kurar; aksi halde nedenini söyleyip atlar. `--dry-run` hiçbir şeye dokunmaz.
3. Güvenlik duvarı: Agent portu (7437) yalnız ev ağında erişilebilir olmalı; internete açma. Windows'ta ilk dinlemede Defender güvenlik duvarı sorusuna "Özel ağ" izni ver.
4. Geri alma: `vlad install --remove-menu` yalnız sağ tık menüsünü kaldırır (SessionEnd hook'una ve skill'lere dokunmaz). Kurulum idempotenttir: ikinci çalıştırma "güncel" der, içerik değişmez.

## Sağ tık menüsü

| | Mac | Windows |
|---|---|---|
| Nerede | Finder → sağ tık → Hızlı Eylemler → "windows makinesine gönder" | Gezgin → sağ tık → "mac makinesine gönder" |
| Ne kurulur | `~/Library/Services/<ad>.workflow` (`VLAD_SERVICES_DIR` ile değişir): `Info.plist` + `document.wflow`; `pbs -update` Servis listesini tazeler | HKCU `Software\Classes\*\shell\VladSend` ve `Directory\shell\VladSend` + `<VLAD_HOME>\.vlad-agent\send-<peer>.vbs` (UTF-16LE+BOM) |
| Yönetici | gerekmez | gerekmez (HKLM'ye yazılmaz) |
| Arkada | `vlad send --to <peer> --notify -- <yollar>` (tam yol, VLAD_HOME ayarlı) | `wscript.exe` gizli başlatıcı → aynı komut, konsol penceresi açılmaz |

- Etiket `<karşı makine adı> makinesine gönder`; ad config'teki `machines` adından gelir (`[A-Za-z0-9._-]` dışı ad reddedilir).
- Sonuç bildirimi gönderen makinede de çıkar (`--notify`): başarı, hata, "teslim belirsiz". Yapılandırma/kimlik/hedef çözme hataları da bildirilir (genel başlık "Gönderilemedi").
- Gönderen, alıcının ad kurallarını önceden denetler (`:` `\`, Windows ayrılmış adları, sondaki nokta/boşluk, harf duyarsız çakışma); sorunlu yol hatada (`details: path: …`) ve bildirimde görünür, ağa çıkılmaz.
- **Windows 11:** klasik menü "Diğer seçenekleri göster" (Shift+F10) altındadır.
- **Çoklu seçim (Windows):** Gezgin seçili her öğe için ayrı süreç başlatır; 3 dosya = 3 ayrı aktarım ve 3 bildirim. Mac Hızlı Eylemi tüm seçimi tek `vlad send` ile yollar.
- **Bilinen sınırlar:** (a) Windows'ta adında `%DEĞİŞKEN%` geçen dosya, `WshShell.Run` ortam değişkenlerini açabileceği için yanlış yola dönüşebilir (Windows'ta doğrulanmadı; elle denemede `100%USERPROFILE%.txt` ile bak). (b) Config'te karşı makine adı değişirse eski menü (Mac'te eski `.workflow`, Windows'ta eski `.vbs`) kendiliğinden silinmez; eski adla `vlad install --remove-menu` çalıştırıp yeniden kur.
- **Mac gizlilik (TCC):** ilk kullanımda Masaüstü/Belgeler/İndirilenler erişimi için izin istenebilir; reddedilirse hata bildirimi gelir.

## Gelen dosya bildirimi

Alıcı makinede aktarım bitince sistem bildirimi: Mac Bildirim Merkezi (`osascript`), Windows toast (PowerShell). Gelen dosya İndirilenler'e düşer ve **hiçbir zaman otomatik açılmaz/çalıştırılmaz**. Odak/Rahatsız Etme modunda bildirim bastırılabilir; dosya yine de İndirilenler'dedir.

## İnternet'ten geldi işareti (MotW)

Karar DP-005: gelen dosyalara köken işareti eklenir: Mac `com.apple.quarantine` xattr, Windows `Zone.Identifier` ADS (`ZoneId=3`, `HostUrl=vlad://<gönderen>`). Yazılamazsa teslim bozulmaz, stderr'e uyarı gider. Pano resmi (`clip-image`) işaretlenmez.

## Güvenlik ve varsayımlar

- **Ev ağı varsayımı:** kanal şifresizdir (düz TCP, çift anahtar HMAC imzası); içerik ağda düz akar. Agent portu internete açılmamalı; güvenlik duvarı/yönlendirme kuralı kullanıcı sorumluluğundadır.
- **Pano enjeksiyonu riski (kabul edildi):** ele geçirilmiş bir makine karşı panoya içerik yazabilir; kullanıcı terminale yapıştırırsa komut çalışır. Pano içeriği asla otomatik çalıştırılmaz.
- Menü komutu, yolları kabuk dizesine gömmez: Windows'ta VBS argüman olarak alır (`%1`), Mac'te `"$@"`; yol ayarları tek tırnaklı (Mac) ya da çift tırnaklı VBS dizesidir (Windows). Tırnak ve denetim karakteri taşıyan ayar yolları reddedilir.

## Elle deneme (Windows)

Mac'te üretilen dosyalar `plutil -lint` ve golden testlerle doğrulanır; Windows kayıt/VBS/toast yolu Mac'te çalıştırılamaz. Windows'ta sırayla:

1. Agent'ı yeniden başlat; `vlad install --dry-run` çıktısında "sağ tık menüsü kurulacak" satırını gör, sonra `vlad install`.
2. `reg query "HKCU\Software\Classes\*\shell\VladSend\command"`: değer `wscript.exe "…\.vlad-agent\send-<peer>.vbs" "%1"` olmalı. `…\Directory\shell\VladSend` için de.
3. Gezgin'de bir dosyaya sağ tık → (Win 11: Diğer seçenekleri göster) → "<peer> makinesine gönder". Konsol penceresi çıkmamalı; Mac'te İndirilenler'e düşmeli, iki tarafta bildirim gelmeli.
4. Aynısı bir klasör ve boşluk/Türkçe/emoji adlı dosya için; `%TEMP%x.txt` adlı dosyayla da dene; aynı dosyayı iki kez → `ad (1).ext`; `D:\` gibi kök sürücüye sağ tık gönder → anlaşılır hata.
5. Karşı makineyi kapat → gönder → "gönderilemedi" bildirimi gelmeli (çıkış 75).
6. Pano: Win+Shift+S ile ekran görüntüsü → Mac'te Cmd+V; Mac'te metin kopyala → Windows'ta Ctrl+V; `vlad clip off` kalıcılığı.
7. Geri alma: `vlad install --remove-menu`; `reg query` artık anahtar bulamamalı, menü kaybolmalı (Gezgin'i yeniden başlatmak gerekebilir).
