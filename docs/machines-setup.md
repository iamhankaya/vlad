# Çoklu makine kurulumu (taslak)

Tek beyin (Mac, kb'nin tek yazarı), bir ya da daha çok işçi (Windows). İşçiler yalnız kendi makinelerinde worktree + `claude` penceresi açar; kb'ye yazma beyindedir. Bu belge C2 (uzak işlemler) sonrası elle kurulum adımlarını verir; Agent protokolü ve güvenlik için `docs/machines-agent-security.md`.

## 1. Config (`vlad.config.json`, iki makinede de aynı)

```json
{
  "brain": "mac",
  "machines": [
    { "name": "mac", "os": "darwin", "agent": { "port": 7437 } },
    { "name": "windows", "os": "win32", "agent": { "host": "<işçi-IP>", "port": 7437 },
      "roots": ["C:\\dev"], "worktreeDir": "{repo}-wt", "kbDir": "C:\\dev\\vlad-kb" }
  ]
}
```

- `roots`: işçide repoların aranacağı kökler. Görev başlarken `<root>/<repoName>` (içinde `.git`) tek bulunmalı; yoksa `not_found: repo yok`, iki kökte varsa `conflict: belirsiz repo adı`. Yol beyinden gelmez, yalnız ad gelir.
- `kbDir`: işçideki kb klonu (beyin push eder, işçi `kb-sync` ile alır; aynı `vlad-kb` upstream'i).
- `worktreeDir` (makine düzeyi): `{repo}` tam repo yoludur; önüne yol yazılmaz (`C:\dev\{repo}-wt` reddedilir, `src/kb/config.ts:42-43`). Yerel `worktreeDir` (kök düzeyi) için de aynı kural geçerli; varsayılan `{repo}-wt`.
- İsteğe bağlı alanlar (şema `schemas/config.schema.json`): makine başına `maxParallel` (en fazla `running` dev çalışanı; yoksa sınırsız) ve `agent.bind` (Agent'ın dinleyeceği adres; yoksa `agent.host`, o da yoksa `127.0.0.1`). Kök düzeyde `consoles` (`[{ "name": "desktop" }]`; konsol kimlikleri, konsoldan `vlad remote` için gerekli) ve `workerSilentMinutes` (sayı > 0: sessizlik eşiği; yoksa varsayılan).

## 2. Anahtarlar (çift anahtar, D-vlad-057)

Her makinede `vlad.local.json` (git'e girmez): `{ "self": "<makine>", "keys": { "<karşı-taraf>": "<64 hex>" } }`. Anahtar **iki makine arasındadır** ve karşı tarafın adıyla tutulur; işçi yalnız beyinle paylaştığı anahtarı bilir (bir işçi ele geçse bile başka işçiye ya da beyin gibi davranan istek imzalayamaz).

1. Her makinede yerel çağrı anahtarı: `vlad agent keygen <kendi-adın>` (kopyalanmaz).
2. Her işçi için beyinde: `vlad agent keygen windows --show` → anahtarı üretir, `keys.windows` olarak yazar ve çıktıda `windows: <64 hex>` satırını basar (`--show` olmadan anahtar basılmaz; yeniden üretmek eskisini değiştirir). Anahtarın 64 hex kısmını **güvenli kanaldan elle** işçiye taşı; işçide `vlad agent setkey mac -` çalıştırıp anahtarı **stdin'den** ver (ör. PowerShell'de `'<anahtar>' | vlad agent setkey mac -`). Anahtar argv'ye yazılmaz: `setkey` argv'de anahtar alırsa reddeder (`src/cli/groups/agent.ts:36`). Konsol için de aynı, ancak konsol kimliği önce kök `consoles`'ta tanımlı olmalı (yoksa `keygen` "kimlik config'te tanımlı değil" der): beyinde `keygen desktop --show`, konsolda `vlad agent setkey mac -`.
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
- `vlad task resume <id>`: uzak görevde işçi kendi worktree/dalını denetler (kirli yolları listeler) ve `claude --resume <session>` ile yeniden başlatır; kayıtlı session yoksa worktree'deki tek transcript kullanılır, o da yoksa taze oturum (prompt log kuyruğunu taşır; F-vlad-097 gereği `--continue` yerel yolda üretilmez). Not: uzak launch yolu (`src/agent/ops/launch.ts:199`) session kimliği yokken hâlâ `--continue` üretir; bu bir ürün kararıdır ve henüz yerel yolla eşitlenmedi.
- Kesilen (`stalled`) bir çalışan `task report`/`task ask` çağıramaz (`stalled → running|cancelled`, `src/tasks/state.ts:8`). Önce `vlad task set <id> running` (yerelde); uzak görevde işçi `task set` çalıştıramaz (reddedilir: "bu makine beyin değil"); `/status` (beyinde) `task set <id> running` ile geri alır.
- `vlad task close-window <id>`: işçide pencere/süreç ağacını kapatır; durum ve worktree değişmez.
- `vlad task cleanup <id>`: yalnız done/cancelled; işçi worktree'yi kendi başlatma kaydından doğrulayıp siler, güven kaydını kaldırır (kaldıramazsa silmez). Ağ çağrısı kb kilidi dışında yapılır.
- Makine kapalı/ulaşılamazken komutlar çıkış kodu **75** (geçici hata) ile biter; sonra tekrar dene. Belirsiz bir launch (yanıt gelmedi) rezervasyonunu korur; bir sonraki `task launch` `op-status` ile işçiye sorar.

## 5. Bilinen sınırlar

- `--external` yalnız beyin makinesinde.
- Gerçek bir ikinci makinede uçtan uca deneme (pencere görünürlüğü, kb-sync, launch/resume/cleanup) elle yapılmalı; testler sahte taşıma ve geçici dizin kullanır.

## 6. Mac mini (beyin) kurulumu ve denetimi (F-vlad-115)

`scripts/mac/audit.sh [--json] [--strict]` salt okuma denetimidir (madde, durum, kanıt; Agent anahtar değerlerini asla basmaz). Eksikleri `scripts/mac/setup.sh` tamamlar (varsayılan `--dry-run`, `--apply` ile yazar; idempotent): ana oturum için `~/.vlad-agent/main-session.sh` + LaunchAgent `com.vlad.main` (açılışta tmux `vlad` oturumunu açar; `VLAD_MAIN_CMD` ile komut değişir) ve Agent LaunchAgent'ı yoksa `vlad agent install --apply`.

Betiğin yapmadığı, **kullanıcının elle yaptığı** adımlar:
1. Uyku kapalı, elektrik gelince açılış: `sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1`.
2. Remote Control: ana oturumda (`tmux attach -t vlad`) `/remote-control`.
3. Agent anahtarları: §2 (`keygen`/`setkey`; anahtar güvenli kanaldan).
4. `vlad install` (kullanıcı düzeyi: `~/.claude` skill'leri, sağ tık menüsü); `~/.claude` dosyalarına dokunduğu için betik çalıştırmaz.
5. Son kontrol: `scripts/mac/audit.sh --strict`.

CI runner için `docs/mac-ci-runner.md`.
