# Çoklu makine kurulumu (taslak)

Tek beyin (Mac, kb'nin tek yazarı), bir ya da daha çok işçi (Windows). İşçiler yalnız kendi makinelerinde worktree + `claude` penceresi açar; kb'ye yazma beyindedir. Bu belge C2 (uzak işlemler) sonrası elle kurulum adımlarını verir; Agent protokolü ve güvenlik için `docs/machines-agent-security.md`.

## 1. Config (`vlad.config.json`, iki makinede de aynı)

```json
{
  "brain": "mac",
  "machines": [
    { "name": "mac", "os": "darwin", "agent": { "port": 7437 } },
    { "name": "windows", "os": "win32", "agent": { "host": "<işçi-IP>", "port": 7437 },
      "roots": ["C:\\dev"], "worktreeDir": "C:\\dev\\{repo}-wt", "kbDir": "C:\\dev\\vlad-kb" }
  ]
}
```

- `roots`: işçide repoların aranacağı kökler. Görev başlarken `<root>/<repoName>` (içinde `.git`) tek bulunmalı; yoksa `not_found: repo yok`, iki kökte varsa `conflict: belirsiz repo adı`. Yol beyinden gelmez, yalnız ad gelir.
- `kbDir`: işçideki kb klonu (beyin push eder, işçi `kb-sync` ile alır; aynı `vlad-kb` upstream'i).

## 2. Anahtarlar (çift anahtar, D-vlad-057)

Her makinede `vlad.local.json` (git'e girmez): `{ "self": "<makine>", "keys": { "<karşı-taraf>": "<64 hex>" } }`. Anahtar **iki makine arasındadır** ve karşı tarafın adıyla tutulur; işçi yalnız beyinle paylaştığı anahtarı bilir (bir işçi ele geçse bile başka işçiye ya da beyin gibi davranan istek imzalayamaz).

1. Her makinede yerel çağrı anahtarı: `vlad agent keygen <kendi-adın>` (kopyalanmaz).
2. Her işçi için beyinde: `vlad agent keygen windows` → anahtarı üretir, `keys.windows` olarak yazar ve işçide çalıştırılacak komutu basar: `vlad agent setkey mac <anahtar>` (anahtarı **güvenli kanaldan elle** taşı). Konsol için de aynı: `keygen desktop` → konsolda `setkey mac <anahtar>`.
3. Agent'ları (yeniden) başlat: `vlad agent start`; durum: `vlad agent status`.
4. Oturum açılışında otomatik başlatma: `vlad agent install` kaydı basar, `--apply` ile kurar (Windows görev zamanlayıcı, Mac launchd). Kayıt kalıcılık oluşturur; kullanıcı kendisi çalıştırır.

## 3. Bağlantı denemesi

```
vlad machine list
vlad machine ping windows
vlad machine probe-window windows
```

`probe-window`, işçide "VLAD probe-window" başlıklı bir PowerShell penceresini ~45 sn açar (Win32_Process.Create ile, Claude Code'un job nesnesinin dışında). **İşçinin ekranında pencere görünmüyorsa** uzak launch'ın penceresi de görünmez: işçide `vlad agent start`'ı etkileşimli (oturum açık) bir konsoldan çalıştır; zamanlanmış görev/hizmet olarak çalışan Agent masaüstü oturumuna pencere açamayabilir (Session 0 yalıtımı). Bu koşul gerçek makinede elle doğrulanmalıdır.

## 4. Kullanım

- `vlad task launch <id> [--machine windows]`: kartın `machines` sırası, kapasite ve ulaşılabilirliğe göre yerleştirir; uzak makinedeyse önce beyin kb'yi commit+push eder, işçi `kb-sync` (fetch + ff-only + sha atalık denetimi) yapar, sonra `launch`.
- `vlad task resume <id>`: uzak görevde işçi kendi worktree/dalını denetler (kirli yolları listeler) ve `claude --resume <session>` (yoksa `--continue`) ile yeniden başlatır.
- `vlad task close-window <id>`: işçide pencere/süreç ağacını kapatır; durum ve worktree değişmez.
- `vlad task cleanup <id>`: yalnız done/cancelled; işçi worktree'yi kendi başlatma kaydından doğrulayıp siler, güven kaydını kaldırır (kaldıramazsa silmez). Ağ çağrısı kb kilidi dışında yapılır.
- Makine kapalı/ulaşılamazken komutlar çıkış kodu **75** (geçici hata) ile biter; sonra tekrar dene. Belirsiz bir launch (yanıt gelmedi) rezervasyonunu korur; bir sonraki `task launch` `op-status` ile işçiye sorar.

## 5. Bilinen sınırlar

- `--external` yalnız beyin makinesinde.
- Gerçek bir ikinci makinede uçtan uca deneme (pencere görünürlüğü, kb-sync, launch/resume/cleanup) elle yapılmalı; testler sahte taşıma ve geçici dizin kullanır.
