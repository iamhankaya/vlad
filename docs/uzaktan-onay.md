# Uzaktan onay (`vlad approver`): korunan işlemler için telefondan onay

> **Önce okuyun: güvenlik sınırı.** Telefon onayı kimlik doğrulaması değildir. Aynı OS kullanıcısı (UID) altında çalışan kötü niyetli bir süreç mod anahtarını okuyup kendi token'ını üretebilir; bu tasarım buna karşı koruma sağlamaz (kapsam dışı; gerçek sınır ayrı OS kullanıcısı gerektirir). Sağladığı şey: VLAD oturumu `VLAD_MODE_TOKEN`'sız çalışırken korunan işlemi (`mode night|watch|off`, `install`, `setup`) yalnız kullanıcı telefondan tam komutu görüp onaylarsa yapabilir. ntfy.sh'ta kimlik doğrulama yoktur: onay yetkisi, gizli istek konusunu görebilmeye eşdeğerdir; konu sızarsa gözlemci sahte bildirim yayınlayabilir ya da onay verebilir. Konu adını paylaşmayın; şüphede `vlad approver rotate`.

Tasarım: `docs/superpowers/specs/2026-11-13-vlad-mode-token-design.md` (VMT2 notu). Yalnız macOS (launchd); Windows kapsam dışı.

## Nasıl çalışır

`vlad mode request <komut> [argümanlar]` isteği `approver/inbox/` altına yazar; launchd'deki `vlad approver run` servisi isteği doğrular (komut yolu manifestte olmalı; eski beş işlem ayrıca sıkı şemayla), telefona ntfy bildirimi gönderir (Reddet / Onayla düğmeleri). Onay gelince servis o tam komutu tek kullanımlık, işleme bağlı bir token (VMT2) ile çalıştırır. Gelen port yoktur (yalnız giden `https`). Süre: istek 5 dk, token 60 sn. Tek bekleyen istek, 30 sn soğuma, saatte 6, günde 20; 3 art arda ret/süre dolumu 1 saat kilitler; kilit 1 saat sonunda kendiliğinden açılır, istersen `vlad approver unlock` ile erken açarsın.

## Kurulum (terminalde, VLAD oturumunun dışında)

```bash
vlad mode token                 # mod anahtarı yoksa üretir (bkz. mod-belirteci-etkinlestirme.md)
export VLAD_MODE_TOKEN=$(vlad mode token)
vlad approver install           # TTY'ye gizli abonelik URL'sini basar
```

URL'yi ntfy uygulamasında abone olun (iOS/Android ayrı). `--server <url>` yalnız `https`. Çalışan oturumları kurulum yapamaz ve istek yazamaz.

## Deneme

```bash
vlad mode request night --until 23:00 --note "deneme"   # bildirim telefona gelir
vlad mode request --wait night --until 23:00             # sonuç gelene kadar bekler (varsayılan 310 sn)
vlad approver status
vlad approver requests --json --limit 5
```

`--wait` değersizdir; süre için `--wait-seconds <n>`. **Kapsam (karar 2026-11-20, seçenek A):** manifestteki (`src/commands/manifest.ts`) her vlad komut yolu istenebilir (ör. `monitor install`, `approver install`, `task set <id> cancelled --reason …`); yürütülen hâlâ yalnız `node <cli> <argv>` (kabuk/başka program yok). Reddedilenler: `mode request` (kendini isteyen döngü), `mode token` (kimlik bilgisi basar), `approver run|uninstall|rotate|unlock` (servisi yöneten) ve manifestte olmayan her yol. TTY isteyen komutlar (ör. `approver install`) serviste TTY olmadığından başarısız olur (`failed`). Bildirimde çalışacak argv birebir görünür (boşluklu/boş değer JSON tırnaklı); uzun istek kırpılmaz, `too_large` ile reddedilir. Her çalıştırma `approver.log`'a ve `results/<id>.json`'a (isteyen, argv, onay zamanı `approvedAt`, çıkış kodu) yazılır; `VLAD_TASK_ID` olan çalışan istek açamaz. Eski beş işlemin şemaları: `night` (`--until`, `--until-task`, `--push`, `--except`, `--projects`, `--note`), `watch on|off`, `off`, `install` (`--remove-menu`), `setup --upgrade [--yes] [--confirm]` (cli + global skill'ler + hooks uygulanır; `--only` uzaktan reddedilir) ve `setup --uninstall <hooks|global-skills|config>`. Uzaktan `setup --answers`/düz `setup` yoktur. `--note` üçüncü tarafa görünür; en çok 60 bayt, aşan istek `too_large` ile reddedilir (kesilmez; bildirimdeki metin yürütülen/kaydedilen metindir); nota sır yazmayın.

## Konu döndürme ve kaldırma

- `vlad approver rotate`: yeni gizli konu, bekleyen istek reddedilir, yeni URL TTY'ye basılır; telefonda yeniden abone olun.
- `vlad approver uninstall`: servisi durdurur, plist ve `approver/` altını siler; `used/` (tek kullanımlık token kayıtları) ve mod anahtarına dokunmaz.
- `vlad mode token --reset|--disable`: anahtar değişir; bekleyen onay `key_changed`/`key_disabled` ile reddedilir.

## Sorun giderme

| Belirti | Bak |
|---|---|
| `approver yanıt vermiyor` | `vlad approver status`; servis kurulu/çalışıyor mu (`launchctl print gui/$UID/com.vlad.approver`) |
| `kilitli` | 3 ret/süre dolumu: 1 saat sonra kendiliğinden açılır; erken açmak için `vlad approver unlock` (terminalde, mod yetkisiyle) |
| `meşgul` / `hız sınırı` | bekleyeni onaylayın/reddedin ya da süresini bekleyin |
| `mod belirteci etkin değil` | önce `vlad mode token` |
| Sonuç `interrupted` | servis çöktü; işlem çalışmış olabilir, terminalde `vlad mode status` ile doğrulayın (otomatik yeniden çalıştırma yoktur) |
| Günlük | gizli dizin altında `approver/approver.log` (gövde/sır içermez) |

Gizli dizinin üst dizini grup/dünya yazılabilirse (`$HOME` 0775; sticky hariç) `approver install` ve servis başlangıcı reddedilir (kasıtlı; macOS varsayılanı 0750/0755 geçer). İstek metinlerinde (`--note` dahil) kontrol/biçim/boşluk karakterleri (Unicode Cc, Cf, Zs, Zl, Zp; ASCII boşluk hariç) ve görünmez dolgu/varyasyon karakterleri reddedilir; bu yüzden emoji varyasyon seçicisi U+FE0F içeren emoji (ör. ❤️) `control_char` ile reddedilir (bilinçli). Çalışan oturumlarında hook, Read/Grep/Glob araçlarının gizli dizine (anahtar, approver spool) erişimini de reddeder (`vlad setup --upgrade` yeni matcher'ı yazar). Sonuç bildirimi güvenlik kanıtı değildir; kesin durum için `approver requests`/`mode status`.

## Bilinen sınırlar

Gerçek ntfy.sh yanıt örneği doğrulama fazında telefonla alınır; bildirim akışı belge türevli varsayımdır (düğme POST gövdesi akışta `message` olarak görünür varsayımı). Windows servisi, Telegram, self-host ntfy, ayrı OS kullanıcısı ve QR çıktısı kapsam dışıdır.
