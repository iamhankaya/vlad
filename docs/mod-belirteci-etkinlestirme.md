# İmzalı mod belirteci: etkinleştirme yönergesi (F-vlad-287)

Tasarım: `docs/superpowers/specs/2026-11-13-vlad-mode-token-design.md`. Bu yönerge **kullanıcının kendi terminalinde** uygulanır;
çalışan oturumları ve VLAD ajanı etkinleştirmeyi yapmaz (belirteç yalnız TTY'de üretilir).

Etkinleşmeden önce mekanizma kapalıdır: gizli dizin yoksa her şey bugünkü gibi çalışır. Anahtar üretilince korunan işlemler
(`vlad mode night|watch|off`, `vlad setup` (`--check`/`--dry-run` hariç), `vlad install`) geçerli belirteç ister.

## 1. İlk kurulum (anahtar + belirteç)

Terminalde, VLAD oturumunu **başlatmadan önce**:

```bash
vlad mode token          # ilk çalıştırma anahtarı üretir (gizli dizin 0700, dosya 0600) ve belirteci basar
vlad mode token --ttl 72 # isteğe bağlı: ömür saat (varsayılan 24, en çok 72)
```

Anahtar kb'ye, repoya ya da ortam değişkenine yazılmaz; yedeğini almayın, yeniden üretilebilir (aşağıda geri alma).

## 2. VLAD oturumunu belirteçle başlatma

Belirteç yalnız ana VLAD oturumunun ortamında bulunur:

```bash
export VLAD_MODE_TOKEN=$(vlad mode token)
claude        # ana VLAD oturumu (vlad dizininde)
```

- Çalışan başlatma betikleri belirteci temizler (`unset VLAD_MODE_TOKEN`), çalışan onu göremez.
- **tmux:** tmux sunucusunu belirteçli kabukta başlatmayın. Sunucu ilk kez başlarken global ortamı miras alır ve çalışanlar
  `tmux show-environment -g` ile belirteci okuyabilir. Sunucuyu belirteçsiz bir kabukta başlatın (`env -u VLAD_MODE_TOKEN tmux`
  ya da belirteci tmux başladıktan sonra, VLAD penceresinin içinde `export` edin). VLAD çalışan başlatırken global
  ortamdan `VLAD_MODE_TOKEN`'ı ayrıca siler (en iyi çaba).
- Süre dolunca korunan işlemler "VLAD_MODE_TOKEN süresi doldu" ile reddedilir; yeni belirteç üretip oturumda yeniden `export` edin.

## 3. Hook kurulumu (isteğe bağlı ek katman)

Çalışan oturumlarında mod/koruma yazmasını en iyi çabayla engelleyen PreToolUse hook'u `permissions` parçasıyla gelir:

```bash
vlad setup --only permissions --dry-run                         # ne yazılacağını gör
vlad setup --only permissions --confirm permissions-write       # ~/.claude/settings.json'a yazar (yedek alır)
vlad setup --check --only permissions                           # doğrula
```

`setup` korunan bir işlemdir: etkinleştirme **sonrası** çalıştırırken `VLAD_MODE_TOKEN` ortamda olmalıdır.

## 4. Geri alma

- Belirteç kayboldu/süresi doldu: terminalde `vlad mode token` ile yenisini alın.
- Anahtar bozuldu/okunamıyor (korunan işlemler "fail-closed" reddeder): `vlad mode token --reset` (geçerli belirteç ister; anahtar
  bozuksa elle `SIFIRLA` yazın). Eski belirteçler ve imzalı gece penceresi geçersiz olur; gerekirse `vlad mode night` ile yeniden açın.
- Mekanizmayı tamamen kapatma: gizli dizini (`vlad mode token` çıktısındaki anahtarın bulunduğu ev dizini altındaki `.vlad-secret`)
  kendi terminalinizde silin; korunan işlemler yeniden belirteçsiz çalışır. İmzalı bir gece penceresi varsa yetki saymaz
  (önce `vlad mode off` ile kapatın).
- Hook'u kaldırma: `vlad setup --uninstall permissions` (kaldırılmazsa `settings.json`'dan ilgili PreToolUse girdisini kendiniz silin).

## Geliştirici notu: test yalıtımı

Alt süreç testleri gerçek gizli dizini görmez: `vitest.config.ts` çocuk süreçlere `NODE_OPTIONS=--import=test/support/no-secret-shim.mjs`
verir, shim süreç içi test seam'ini geçici bir dizine çevirir. Üretim kodunda env ile açılan seam yoktur (spec §Test yalıtımı).
