# VLAD sunucu RUNBOOK (S14a)

Bu repo **public**. Buraya sır, IP, gerçek sunucu adı ya da hesap numarası yazılmaz; aşağıdaki `<...>` yer tutucuları kendi ortamında doldur.
Bu belge kurulumu anlatır; **gerçek sunucuda prova S14c'dedir** (`rehearse.sh`). Burada "prova edildi" denen bir şey yoktur.

Kısaltmalar: **vlad** = ajan kullanıcısı (çalışanlar, `vlad` CLI), **vladapi** = kapı kullanıcısı (API, GitHub App anahtarı, FCM, cihaz defteri), **vladchat** = sohbet ajanı kullanıcısı.

## Mimari özet

| Kimlik | Ne yapar | Sırları | Yazabildiği yerler |
|---|---|---|---|
| `vlad` | Çalışanlar (`systemd-run --user`), `vlad` CLI, `vlad-kbsync` | kendi `gh` girişi (PAT), kendi Claude girişi | kb (grup `vlad`), worktree'ler, `$VLAD_HOME/state` |
| `vladapi` | `vlad-api`, `vlad-kbpromote` | `vlad-gate` App anahtarı, FCM, cihaz defteri (`/var/lib/vladapi`, 0700) | `/var/lib/vladapi`, kb (grup yazma, yalnız `vlad` CLI ile) |
| `vladchat` | Sohbet turu (`claude -p`), systemd sandbox'ında | yalnız kendi Claude girişi (`/var/lib/vladchat`) | yalnız `/var/lib/vladchat`; **kb salt okunur** |

- Kod `VLAD_HOME` (`/opt/vlad`) altında **root:root**, grup/başkası yazamaz (F-vlad-037). Ajan `dist/`, `schemas/`, `roles/`, `server/` dosyalarını değiştiremez. Tek yazılabilir alt klasör `$VLAD_HOME/state` (kb çakışma yedekleri, `vlad` sahibi 0700).
- Dışarıya açık tek yüzey Tailscale Funnel → `127.0.0.1:8787`. Güvenlik grubunda/ güvenlik duvarında gelen port yok.
- Yapılandırma: `/etc/vlad/vlad.env` (root:vlad 0640, **sır yok**). Şablon: `deploy/env.example`.

---

## A. AWS (EC2 Graviton)

### A.1 Örnek
- Tür: `t4g.large` (arm64, 2 vCPU / 8 GiB). Aynı anda 2 çalışan + API için başlangıç; çalışan sayısı `maxParallel` ile sınırlıdır.
- AMI: Ubuntu Server 24.04 LTS **arm64**.
- Disk (EBS gp3): kök **60 GiB** (kb + worktree'ler + `node_modules`; Gradle/Android derlemesi sunucuda **yapılmaz**). Şifreleme açık.
- **Anlık görüntü:** EBS için günlük yaşam döngüsü ilkesi (Data Lifecycle Manager), 7 günlük saklama. Geri yükleme bölüm B'deki "kb + `/var/lib/vladapi`" mantığıyla aynıdır; `/var/lib/vladapi` anlık görüntüde şifreli diskle birlikte durur.
- Bütçe: **AWS Budgets** aylık bütçe alarmı (kredi ~120 gün gider; kredinin bitiş tarihini takvime yaz). Alarm eşikleri %50 / %80 / %100, e-posta alıcısı kullanıcı.

### A.2 Ağ
- **Güvenlik grubu: GELEN kural yok** (boş). Giden: hepsi (GitHub, Anthropic, Tailscale, Firebase).
- SSH yalnız anahtarla, tercihen yalnız Tailscale içinden. Başlangıç erişimi için geçici olarak 22/tcp'yi **yalnız kendi çıkış adresine** aç, Tailscale çalışınca kuralı sil. Elastic IP gerekmez.
- Örnek metadata: IMDSv2 zorunlu (`HttpTokens=required`), hop limit 1. **EC2 instance profile (IAM rolü) bağlanmaz**: sunucuda AWS kimliği olmamalı; sohbet ajanı ağ kısıtıyla (A.9) metadata hizmetine zaten ulaşamaz, bu ikinci katmandır.

### A.3 Kurulum betiğini çalıştır
```bash
git clone https://github.com/iamhankaya/vlad.git && cd vlad    # sunucuda, admin kullanıcısıyla
sudo CLAUDE_CODE_VERSION=<kesin sürüm> deploy/install.sh
```
- `VLAD_INSTALL_DRYRUN=1` ile önce ne yapacağını izle (root gerekmez).
- Betik: kullanıcılar/gruplar, `enable-linger vlad`, Node 22 (NodeSource, imzalı apt deposu; **parmak izi ekrana yazılır**, resmî değerle elle karşılaştır ya da `NODE_KEY_FPR`/`GH_KEY_FPR`/`TS_KEY_FPR` ile sabitle), `gh`, Tailscale, sabit sürümlü `claude` (`/opt/claude-code`, root), kodu `/opt/vlad`'a root olarak kopyalar, `npm ci` + `npm audit --omit=dev --audit-level=high` (yüksek/kritik bulgu varsa durur; bilinçli karar `AUDIT_ALLOW=1` ve karar rapora yazılır), birimleri `@KB_DIR@`/`@VLAD_HOME@` doldurarak `/etc/systemd/system`'e koyar.
- İsteğe bağlı: `HARDEN_SSH=1` (`/etc/ssh/sshd_config.d/01-vlad.conf`; `sshd -t` ve `sshd -T` ile etkin değerleri doğrular, tutmazsa dosyayı geri alır; `SSH_ALLOW_USERS="admin"` ile `AllowUsers` eklenir; **ikinci bir oturumu açık tut**).
- Üçüncü taraf apt anahtarlarının birincil parmak izleri betikte sabittir (`DEFAULT_*_KEY_FPR`) ve anahtarlıkta tek birincil anahtar aranır. **İlk gerçek koşudan önce bu değerleri üreticilerin yayımladığı parmak iziyle elle karşılaştır** (bu sürümde ağsız ortamda doğrulanamadı); tutmazsa kurulum durur, doğru değer `*_KEY_FPR` ile verilir.
- `npm ci` ve `claude` kurulumu `--ignore-scripts` ile, root olarak ama yaşam döngüsü betiği çalıştırmadan yapılır; `npm audit` kilit dosyasına karşı kurulumdan ÖNCE koşar. `claude` bu haliyle açılmazsa kurulum durur; paketin kendi kurulum betiğini okuyup `CLAUDE_RUN_POSTINSTALL=1` ile bilinçli çalıştır.
- Kilit dosyaları (`package-lock.json`, `server/package-lock.json`) commit'lidir; `npm ci` uyuşmazlıkta başarısız olur (kilit güncellemesi bilinçli bir PR işidir).

### A.4 Tailscale
```bash
sudo tailscale up --ssh=false          # kimlik doğrulama bağlantısını tarayıcıda aç
```
- Yönetim konsolunda: cihaza etiket ver (`tag:vlad-server`), **ACL**'de Funnel'a izin ver:
  ```jsonc
  "nodeAttrs": [ { "target": ["tag:vlad-server"], "attr": ["funnel"] } ]
  ```
- HTTPS sertifikaları açık olmalı (MagicDNS + HTTPS). Funnel:
  ```bash
  sudo tailscale funnel --bg 8787       # yalnız loopback API'si; adres: `tailscale funnel status` çıktısındaki https adresi
  ```
- Beklenmeyen: Funnel uzun SSE bağlantısını taşımayabilir (D0.3). Mobil istemci `/events?after=` yoklamasına düşer; FCM bağımsızdır.

### A.5 Kullanıcı girişleri (elle, sır repoya girmez)
1. **kb klonu (vlad):** `sudo -u vlad git clone https://github.com/<owner>/vlad-kb.git /var/lib/vlad/kb`, ardından `git -C /var/lib/vlad/kb switch -c kb-server` (yerel dal `kb-server`, upstream `origin/kb-server`, push yoksa ilk `vlad kb sync` oluşturur).
2. **PAT (vlad):** `sudo -u vlad gh auth login` (ince taneli PAT). Yetkiler, **kullanıcı kararı 2026-10-25**: proje repoları için `contents:write` + `pull_requests:write`; **`vlad-kb` için `contents:write`** (`kb-server` dalı push'u için; GitHub dal bazında daraltamaz). PAT ana dala yazamamalı: bölüm D'deki ruleset kod repoları için bunu zorlar, `vlad-kb` için ruleset yoktur (bilinçli risk kabulü; kapı kod düzeyinde: `promoteKb`).
3. **Claude girişi (iki ayrı hesap oturumu, iki ayrı uid):**
   - `sudo -u vlad -H claude` → `/login` (çalışanlar için).
   - Sohbet için (`vladchat`), **birimle aynı sandbox özellikleri içinde** (yalnız `claude /login` için; düz `sudo -u` ile değil):
     ```bash
     sudo systemctl stop vlad-chat.socket
     sudo systemd-run --pty --wait --collect -p User=vladchat -p Environment=HOME=/var/lib/vladchat \
       -p NoNewPrivileges=yes -p CapabilityBoundingSet= -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
       -p ReadWritePaths=/var/lib/vladchat -p NoExecPaths=/var/lib/vladchat -p ExecPaths="/usr /opt /usr/local" \
       -p InaccessiblePaths="/var/lib/vladapi /home /root -/run/tailscale -/run/dbus" \
       -p RestrictAddressFamilies="AF_INET AF_INET6" \
       -p IPAddressDeny="localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 169.254.0.0/16" -p IPAddressAllow=127.0.0.53 \
       /usr/local/bin/claude
     sudo deploy/install.sh   # yer tutucuları yeniden boş/root yapar (CLAUDE_CODE_VERSION gerekir)
     sudo systemctl start vlad-chat.socket
     ```
     `/login` yap, çık. Giriş belgesi `/var/lib/vladchat/.claude/.credentials.json` ve `~/.claude.json` içinde durur; ayar dosyalarında değil. Giriş sırasında yer tutucu dosya/dizinler salt okunur bağlı değildir; `install.sh` bunları root'a ait boş hale getirir (`ls -la /var/lib/vladchat /var/lib/vladchat/.claude`). İki kimlik **farklı dizinde** durur; sohbet ajanı çalışan kimliğini göremez.
   - Abonelik koşulları: otomatik/üretim kullanımı için geçerli olduğunu kullanıcı kontrol eder (D0.1 notu).
4. **App anahtarı (vladapi):** `vlad-gate` private key dosyası → `/var/lib/vladapi/github-app.pem`, `chown vladapi:vladapi`, `chmod 0600`. `VLAD_GITHUB_APP_ID`, `VLAD_GITHUB_APP_INSTALLATION_ID` `/etc/vlad/vlad.env` içine (sır değil). Anahtarı komut geçmişine/loga/repoya koyma; scp ile `0600` yaz, sonra kaynağı sil.

### A.6 Makine yapılandırması
`/opt/vlad/vlad.config.json` root'a aittir; düzenlemek `sudo` ile yapılır (ajan düzenleyemez). Sunucu makinesi için:
```jsonc
{
  "roots": ["/home/vlad/projects"],
  "launcher": "auto",
  "kbDir": "/var/lib/vlad/kb",
  "machines": {
    "<VLAD_MACHINE değeri>": { "launcher": "process", "maxParallel": 2, "kbPushBranch": "kb-server" }
  }
}
```
- `kbPushBranch: "kb-server"` **yalnız `machines.<sunucu>` altında** (kökte değil; K2). Yoksa `vlad kb commit --push` sunucuda reddedilir (güvenli varsayılan).
- `/etc/vlad/vlad.env`: `VLAD_MACHINE`, `VLAD_KB_REPO=<owner>/vlad-kb` doldur.
- Proje klonları: `sudo -u vlad vlad project clone <slug>` (`/home/vlad/projects` altına).

### A.7 Birimleri etkinleştir
```bash
sudo ENABLE_UNITS=1 CLAUDE_CODE_VERSION=<aynı sürüm> deploy/install.sh   # ya da elle:
sudo systemctl enable --now vlad-kbsync.timer vlad-kbsync.path vlad-kbpromote.timer vlad-chat.socket vlad-api.service
systemctl list-timers 'vlad-*' ; journalctl -u vlad-api -n 50 --no-pager
```
İlk açılışta `vlad-api` günlüğünde "sohbet kapalı (501)" görürsen nedenini söyler (A.9).

### A.8 Eşleştirme
`sudo -u vladapi env VLAD_SERVER_STATE_DIR=/var/lib/vladapi vlad-server pair` → QR/kod (10 dk, tek kullanım). İptal: `vlad-server device revoke <id>` (sunucu CLI'ında varsa).

### A.9 Sohbet ajanı (F-vlad-024, GÜVENLİK)
Tasarım: `main.ts` `VLAD_CHAT_CLIENT` doluysa ve **güvenlik denetimi** geçerse `ChatTurnRunner`'ı kurar; aksi halde sohbet uçları **501** döner (fail-closed). Denetim (`chatSandboxProblem`): client betiği mutlak yol, symlink değil, root'a ait, grup/başkası yazamaz, üst dizinlerin hepsi root'a ait ve yazılamaz; `/run/vlad-chat/turn.sock` bir soket.

Akış: `vlad-api` (vladapi) → `chat-client` (`/usr/local/libexec/vlad/chat-client`) → soket → systemd `vlad-chat@.service` (uid `vladchat`) → `chat-turn` → `claude -p`.
- `vladapi` **hiç `claude` çalıştırmaz**, `sudo`/setuid yok (API birimi `NoNewPrivileges=yes` kalır).
- Soket `vladapi`ya ait, 0600 (`chatSandboxProblem` sahibi ve izni kontrol eder); istemci yolu sabittir (`/usr/local/libexec/vlad/chat-client`); en çok 2 eşzamanlı bağlantı.
- Bayraklar `chat-turn` içinde sabittir; istemciden yalnız `--resume <id>` (regex doğrulamalı) gelir. İzinler `/etc/vlad-chat/chat-settings.json` (dizin root:root 0755, dosya 0444; `/etc/vlad` 0750 root:vlad olduğu ve `vladchat` grupta olmadığı için ayar orada durmaz) dosyasındadır; **install.sh bunu API'nin kullandığı `chatPermissions()` fonksiyonundan üretir** (tek kaynak). Deny listesi boşsa tur çalışmaz.
- **İzin modu:** `claude -p --permission-mode dontAsk`: yalnız izin listesi çalışır (`Read/Grep/Glob(kb)`, `Bash(vlad *)`); listede olmayan her araç sorulmadan reddedilir. Deny listesi ikinci katmandır. (`auto` kullanılmaz: `bash -c`, `python3 -`, `/dev/tcp` ile aşılırdı.) `chat-settings.json` `disableAllHooks: true` taşır; `chat-turn` bu alan yoksa çalışmaz.
- **Ağ:** `IPAddressDeny` ile loopback (API 8787), link-local (IMDS 169.254.169.254), özel bloklar, tailnet (100.64/10) kapalı; yalnız çözümleyici saplaması `127.0.0.53` açık; `RestrictAddressFamilies=AF_INET AF_INET6`; `/run/tailscale`, `/run/dbus` erişilemez. Geri kalan internet açıktır. **İsteğe bağlı sıkılaştırma:** yalnız `api.anthropic.com` için izin listeli bir egress proxy (örn. ayrı küçük bir proxy birimi) ve birimde `IPAddressDeny=any` + proxy adresine `IPAddressAllow`; bu sürümde kurulmadı.
- **Kalıcılık:** `~vladchat/CLAUDE.md`, `CLAUDE.local.md`, `.claude/{settings.json,settings.local.json,CLAUDE.md}` boş root dosyaları; `.claude/{agents,commands,skills,rules,plugins,hooks,output-styles}` boş root dizinleri (0555); hepsi birimde `ReadOnlyPaths` ile bağlı. `install.sh` bunları yazarken önce sohbet birimlerini durdurur, bağlantıları izlemeden siler (`find -delete`, `rm -f`) ve `install … /dev/null` ile yeniden yaratır; vladchat'in ev dizini ya da `.claude` sembolik bağ ise kurulum durur. Birim ayrıca kb içindeki `.claude`, `CLAUDE.md`, `CLAUDE.local.md` yollarını `InaccessiblePaths` ile maskeler ve `chat-turn` bunlar (ya da üst dizinlerinde `CLAUDE.md`/`.claude`) varsa turu **78 ile reddeder**. `~/.claude.json` giriş durumunu taşıdığı için salt okunur YAPILAMAZ (claude oturum bilgisini oraya yazar); onun yerine `chat-turn` her turdan önce `allowedTools`, `mcpServers`, `hooks` (kök ve `projects.*`) taşıyıp taşımadığına bakar ve taşıyorsa 78 ile reddeder. `/etc/claude-code/managed-settings.json` (root, `disableAllHooks`) makine genelinde tüm `claude`'lara, çalışanlar dahil, uygulanır. Sohbet deny listesinde `Bash(vlad install*)` vardır.
- **Yürütme ve ayar kaynağı:** `NoExecPaths=/var/lib/vladchat`, `ExecPaths=/usr /opt /usr/local` (ajanın yazdığı hiçbir şey çalıştırılamaz). `--setting-sources user` kalır: `claude`'un bu bayrakta boş liste kabul edip etmediği burada doğrulanamadı (S14c); giriş belgesi ayar dosyasında olmadığı için `user` kaynağı kapatılsa da giriş çalışır, ama bu denenmedi. Şimdilik güvence: dosyalar boş ve salt okunur, hook'lar kapalı.
- Sandbox (`vlad-chat@.service`): `NoNewPrivileges`, boş `CapabilityBoundingSet`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp/Devices`, `ReadOnlyPaths=kb + VLAD_HOME`, yazılabilir tek yer `/var/lib/vladchat`, `InaccessiblePaths=/var/lib/vladapi /home /root`, `SystemCallFilter=@system-service`, `RuntimeMaxSec=660`, `MemoryMax=1G`, `TasksMax=128`.
- **kb erişimi:** `vladchat` `vlad` grubunda DEĞİLDİR; kb için yalnız okuma ACL'i vardır (`u:vladchat:rX`, default dahil). `/home/vlad` 0700. `vladapi` `vlad` grubundadır (kart/cevap yazımı `vlad` CLI ile, plan kararı); bu DAC düzeyinde yazma yetkisidir, tek kapı CLI + `withKbLock`tur. **bwrap gerekmedi**: systemd sandbox'ı aynı kapsamı sağlar; ek bir kullanıcı alanı sandbox'ı (bwrap) ancak prova (S14c) bir eksik gösterirse eklenir.
- kb **salt okunur**: sohbet ajanı `vlad` ile okur; yazma gerektiren her şey (kart cevabı, görev) API'nin kendi yolundan (`vladapi` + `vlad` CLI) geçer. Bu yüzden prompt enjeksiyonu kb'ye yazamaz.
- Bilinen sınır: API süreci bir turu iptal ederken (zaman aşımı) soketi kapatır; turun kendisini `RuntimeMaxSec` ve `KillMode=control-group` sonlandırır. İstemci tarafı SIGKILL'i başka uid'e iletmeye çalışmaz.
- Kontrol (sunucuda):
  ```bash
  systemd-analyze security vlad-chat@.service      # pozlanma seviyesi; hedef < 2 (OK)
  systemd-run --pty -p User=vladchat -p InaccessiblePaths=/var/lib/vladapi cat /var/lib/vladapi/github-app.pem   # reddedilmeli
  ```
  Bu komutlar **prova işidir (S14c)**; burada koşulmadı.

### A.10 Sohbet `active` hatasında kapanır (F-vlad-029)
Kodda yapılmadı; **işletme maddesi**: sohbet ajanı bir `vlad` komutundan `active_elsewhere` (etkin VLAD başka makinede) ya da `kb_conflict` aldığında yeniden denemez, tahmin yürütmez; cevap "şu an etkin VLAD <makine>; yazma yapılamıyor" olur. Bu zaten kb'nin salt okunur olmasıyla (A.9) yazma yönünde kapalıdır. Okuma yönünde bayat veri riskine karşı: etkin VLAD başka makineye geçtiyse `GET /home` `active_vlad` bunu gösterir; sohbet cevabında "yerel kb eski olabilir" uyarısı sistem isteminin parçasıdır (S11 işi). Kodla zorlama ayrı bir faz olarak açık: bkz. rapordaki "Prova edilemeyenler/Açık".

### A.11 Dev çalışanı ana dala push edemez (F-vlad-030)
Çalışan `deploy/claude/worker-settings.json` ile koşar (`--setting-sources user`, yalnız bu `--settings` dosyası; worktree içindeki ayar dosyası etkisizdir). Dosya: yalnız `git push [-u] origin vlad/T*` **izinli**; ardına eklenen her şey yasak kalıplara takılır: refspec (`:`), her uzun seçenek (`--delete`, `--force`, `--mirror`, `--no-verify` …), `-f/-d/-o/-q/-n/-v`, `main`/`master`/`HEAD`/`refs/`/`+`/`@` içeren her şey, `;` `&` `|` `$(` zincirleri; ayrıca `git -C … push`, `gh pr merge`, `gh api`, `curl/wget` **yasak** (yasak, izinden önce gelir). Bu kural tablosu `test/deploy/s14a.test.ts` içinde komut komut doğrulanır. Kalan açıklar (kabul edilmiş, gizlenmedi): çalışan `node`/`npx` çalıştırabildiği için bir `child_process` ile `git push` komutunu bu kurallar görmeden çalıştırabilir; ve çalışanın ayar kopyası kendi uid'sine ait dizindedir (kaynak `/opt/vlad/deploy/claude/worker-settings.json` root'a aittir, kopya değildir), aynı uid ile değiştirilebilir. Bu yüzden **kapı: `doctor` yeşil + canary reddi kayıtlı olmadan sunucuda dev çalışan başlatılmaz** (S14b/S14c). Sunucuda `maxParallel: 0` ile kurup kapı geçince 2 yap. **Zorlayıcı olan bu dosya değil, GitHub ruleset'idir** (bölüm D, `github/rulesets.sh` S14b): PAT ana dala yazamaz. Kart cevabının `session` sınıfında kalması bu koşula bağlıdır: ruleset doğrulanmadan (`doctor` yeşil + canary reddi, S14c) bunu "kanıtlandı" diye işaretleme.

### A.12 İzleme
- `journalctl -u vlad-api -u vlad-kbsync -u vlad-kbpromote -u 'vlad-chat@*' --since -1h`
- `vlad status --summary` (vlad kullanıcısıyla), `GET /home` uyarıları (`kb_sync.state`, sohbet `session_down`).
- Zamanlayıcılar: `systemctl list-timers 'vlad-*'`. `vlad-kbsync` 60 sn, `vlad-kbpromote` 60 sn (30 sn kaydırılmış).

---

## B. Raspberry Pi 5'e taşıma (arm64)

Sağlayıcıya özgü servis yoktur; aynı `install.sh` çalışır (Ubuntu 24.04 arm64, `Raspberry Pi Imager` ile; SSD önerilir, SD kart değil).
1. Yeni cihazda bölüm A.3'ü çalıştır (aynı `CLAUDE_CODE_VERSION`).
2. Eski sunucuda birimleri durdur: `sudo systemctl disable --now vlad-api vlad-kbsync.timer vlad-kbsync.path vlad-kbpromote.timer vlad-chat.socket`.
3. **Taşınanlar** (rsync, kaynak sunucudan, kullanıcı/izinleri koruyarak):
   - `kb` klonu: önce `vlad kb commit … --push` ile kb'yi `kb-server`'a it; yeni cihazda **temiz klon** daha güvenlidir (`git clone` + `switch -c kb-server origin/kb-server`). Push edilmemiş yerel iş varsa kopyala.
   - `/var/lib/vladapi` (cihaz defteri, nonce, olay defteri, denetim kopyası, **App anahtarı**): `rsync -aHAX --numeric-ids`; sahip `vladapi:vladapi`, 0700 korunur. Aktarım şifreli kanaldan (SSH); ara kopya bırakma.
   - Worktree'ler (`/home/vlad/projects`): gerekirse; temizlenmiş, push edilmiş işler yeniden klonlanabilir. Çalışan görevler (`running`) önce `stalled` olur; taşımadan sonra `vlad task resume <id>`.
   - Claude girişleri taşınmaz: `vlad` ve `vladchat` için A.5'i yeniden yap. PAT'ı yeniden gir.
4. **Cihazlar yeniden eşleştirilir** (`vlad-server pair`): Funnel adresi ve sunucu parmak izi değişir; telefondaki kayıt silinip yeniden eşleşir. Eski sunucudaki cihazları iptal et.
5. `VLAD_MACHINE` adı: yeni makine adını kullan ve `machines.<ad>`'ı oluştur. Etkin VLAD'ı **devralma** ile al (`POST /v1/active/takeover`, `session + approval`); eski makine bayatlar.
6. Eski EC2'yi durdurmadan önce yeni cihazda `vlad status --summary`, `journalctl`, bir test eşleştirmesi ve bir `kb sync` döngüsü gör.
- Pi'de `t4g`'den küçük bellek: `maxParallel: 1`.

---

## C. Ortak bölümler

### C.1 Firebase (FCM) ve `google-services.json`
- Firebase projesi aç, Android uygulaması ekle (paket adı `mobile/app` ile aynı), **`google-services.json`** dosyasını indir.
- `google-services.json` **repoya girmez** (`.gitignore`'da olduğunu doğrula). Mobil derleme CI'ında gizli dosya olarak enjekte edilir; yerelde `mobile/app/` altına konur.
- FCM v1 için bir **servis hesabı anahtarı** üret → sunucuda `/var/lib/vladapi/fcm-service-account.json` (`vladapi`, 0600). Ajan kullanıcıları (`vlad`, `vladchat`) bu dosyayı okuyamaz.
- Doğrulama (D0.4, kullanıcı ortamı): 200, 404 `UNREGISTERED`, 401 yanıtlarını kaydet.

### C.2 Windows VLAD güncelleme sırası
Sunucu ve Windows aynı `kb`'yi paylaşır; sıra önemlidir:
1. Windows'ta `vlad kb pull` (etkin VLAD'ın nerede olduğunu gör); bekleyen iş varsa `vlad kb commit "<özet>" --push`.
2. Sunucu: `git pull` (kod), `sudo deploy/install.sh` (aynı `CLAUDE_CODE_VERSION` ya da bilinçli yeni sürüm), sonra `sudo systemctl restart vlad-api`.
3. Windows: kodu güncelle, `npm ci && npm run build`; `minCliVersion` yükseltildiyse eski CLI yazmayı reddeder (beklenen davranış).
4. `vlad kb pull` ve bir `vlad status --summary`.
- Şema/sözleşme değişikliği olan sürümde sırayla: **kb'yi çek → sunucuyu güncelle → Windows'u güncelle → telefon uygulaması**.

---

## D. GitHub: App, ruleset, doctor

> `rulesets.sh`, `APP.md` ve `vlad-server doctor` **S14b** diliminin işidir; burada yalnız kurulum sırası ve yetkiler tutulur.

1. **`vlad-gate` GitHub App'i:** izinler `checks:write`, `pull_requests:write`, `contents:write` (yalnız kurulu repolarda), `metadata:read`. Kurulacak repolar: **proje repoları ve `vlad-kb`** (kullanıcı kararı 2026-10-25: `vlad-gate` `vlad-kb`'ye kurulur; promote'un tek yazma kimliği). App token'ı istek başına, repo ve izin kümesiyle sınırlı alınır; `vlad-kb` için `contents:write` yalnız `pushKbMain` içindir.
2. **Ruleset (kod repoları):** ana dala yalnız `vlad-gate` App'i + yönetici bypass; force-push ve silme engelli; ajan PAT'ı yazamaz; `integration_id` ile sabit kontrol. `vlad-kb` için ruleset **yok** (kullanıcı kararı: kapı kod düzeyinde; risk bilerek kabul).
3. **`vlad-server doctor`** (S14b): exit 0 hepsi tamam / 1 başarısız / 2 koşamadı. Ruleset kontrolleri ve `ntp_synced`. Sonuç "kayıtlı çıktı" olarak saklanır.
4. **Canary** (S14c): `vlad-agent` PAT'ıyla ana dala boş commit push → **reddedilmeli**. "Dış zorlayıcı kanıtlandı" yalnız doctor yeşil + canary reddi kayıtlıyken denir.

---

## E. Sorun giderme

| Belirti | Bak |
|---|---|
| Sohbet 501 | `journalctl -u vlad-api`: "sohbet kapalı" satırı nedeni yazar (`VLAD_CHAT_CLIENT` boş, soket yok, dosya sahipliği) |
| `kb meşgul` | `.vlad.lock` bayatsa 60 sn sonra otomatik temizlenir; kalıcıysa çalışan süreçleri kontrol et |
| `kb_conflict` kartı | Telefondan seçenek ya da SSH ile `vlad kb resolve --take main|local` |
| Çalışan başlamıyor | `loginctl show-user vlad -p Linger` = `yes`, `systemctl --user -M vlad@ status` |
| Birim doğrulama | `systemd-analyze verify /etc/systemd/system/vlad-*` |
