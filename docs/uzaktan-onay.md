# Uzaktan onay (`vlad approver`): korunan işlemler için telefondan onay

> **Önce okuyun: güvenlik sınırı.** Telefon onayı kimlik doğrulaması değildir. Aynı OS kullanıcısı (UID) altında çalışan kötü niyetli bir süreç mod anahtarını okuyup kendi token'ını üretebilir; bu tasarım buna karşı koruma sağlamaz (kapsam dışı; gerçek sınır ayrı OS kullanıcısı gerektirir). Sağladığı şey: VLAD oturumu `VLAD_MODE_TOKEN`'sız çalışırken korunan işlemi (`mode night|watch|off`, `install`, `setup`) yalnız kullanıcı telefondan tam komutu görüp onaylarsa yapabilir. ntfy.sh'ta kimlik doğrulama yoktur: onay yetkisi, gizli istek konusunu görebilmeye eşdeğerdir; konu sızarsa gözlemci sahte bildirim yayınlayabilir ya da onay verebilir. Konu adını paylaşmayın; şüphede `vlad approver rotate`.

Tasarım: `docs/superpowers/specs/2026-11-13-vlad-mode-token-design.md` (VMT2 notu). Yalnız macOS (launchd); Windows kapsam dışı.

## Nasıl çalışır

`vlad mode request <işlem>` isteği `approver/inbox/` altına yazar; launchd'deki `vlad approver run` servisi isteği doğrular (allowlist), telefona ntfy bildirimi gönderir (Reddet / Onayla düğmeleri). Onay gelince servis o tam komutu tek kullanımlık, işleme bağlı bir token (VMT2) ile çalıştırır. Gelen port yoktur (yalnız giden `https`). Süre: istek 5 dk, token 60 sn. Tek bekleyen istek, 30 sn soğuma, saatte 6, günde 20; 3 art arda ret/süre dolumu 1 saat kilitler (`vlad approver unlock`).

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

`--wait` değersizdir; süre için `--wait-seconds <n>`. İzinli biçimler: `night` (`--until`, `--until-task`, `--push`, `--except`, `--projects`, `--note`), `watch on|off`, `off`, `install` (`--remove-menu`), `setup --upgrade [--only] [--yes] [--confirm]` ve `setup --uninstall <hooks|global-skills|config>`. Uzaktan `setup --answers`/düz `setup` yoktur. `--note` üçüncü tarafa görünür (ilk 60 bayt); nota sır yazmayın.

## Konu döndürme ve kaldırma

- `vlad approver rotate`: yeni gizli konu, bekleyen istek reddedilir, yeni URL TTY'ye basılır; telefonda yeniden abone olun.
- `vlad approver uninstall`: servisi durdurur, plist ve `approver/` altını siler; `used/` (tek kullanımlık token kayıtları) ve mod anahtarına dokunmaz.
- `vlad mode token --reset|--disable`: anahtar değişir; bekleyen onay `key_changed`/`key_disabled` ile reddedilir.

## Sorun giderme

| Belirti | Bak |
|---|---|
| `approver yanıt vermiyor` | `vlad approver status`; servis kurulu/çalışıyor mu (`launchctl print gui/$UID/com.vlad.approver`) |
| `kilitli` | 3 ret/süre dolumu: `vlad approver unlock` (terminalde, mod yetkisiyle) |
| `meşgul` / `hız sınırı` | bekleyeni onaylayın/reddedin ya da süresini bekleyin |
| `mod belirteci etkin değil` | önce `vlad mode token` |
| Sonuç `interrupted` | servis çöktü; işlem çalışmış olabilir, terminalde `vlad mode status` ile doğrulayın (otomatik yeniden çalıştırma yoktur) |
| Günlük | gizli dizin altında `approver/approver.log` (gövde/sır içermez) |

Gizli dizinin üst dizini grup yazılabilirse (`$HOME` 0775) kurulum reddedilir (kasıtlı). Sonuç bildirimi güvenlik kanıtı değildir; kesin durum için `approver requests`/`mode status`.

## Bilinen sınırlar

Gerçek ntfy.sh yanıt örneği doğrulama fazında telefonla alınır; bildirim akışı belge türevli varsayımdır (düğme POST gövdesi akışta `message` olarak görünür varsayımı). Windows servisi, Telegram, self-host ntfy, ayrı OS kullanıcısı ve QR çıktısı kapsam dışıdır.
