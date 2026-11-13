# İmzalı mod belirteci: CLI tarafı gerçek sınır (F-vlad-287)

Durum: uygulandı (T20261113-18). Karar: DP-035 (a).

## Sorun

T20261113-12'deki çalışan mod koruması bir PreToolUse hook'udur ve çalışanın yazdığı Bash komut metnini ayrıştırır
(`src/hooks/mode-guard.ts`). Codex 2. turda yine 3 P1 kaçış buldu: çift tırnakta `$(...)`, boşluklu yol, `cd` + göreli
`settings.json`. Metin ayrıştırma kapalı bir küme değildir: kabuk, yorumlayıcı ve dosya sistemi sonsuz biçimde aynı eylemi
ifade eder. Sınır, çalışanın **ne yazdığına** değil **neye sahip olduğuna** bağlanmalıdır.

## Tehdit modeli

- **Saldırgan:** VLAD'ın başlattığı bir çalışan oturumu (Claude; `Bash`, `Edit`, `Write` araçları). Kötü niyetli olması gerekmez:
  prompt enjeksiyonu ya da hatalı akıl yürütmeyle "gece modunu açıp push yetkisi vermek" gibi eylemlere kayabilir.
- **Çalışan aynı OS kullanıcısıdır.** Kullanıcının okuyabildiği her dosyayı okuyabilir, `~/.claude/settings.json`'u,
  `kb/mode.json`'u, `vlad.config.json`'u elle düzenleyebilir, `vlad` CLI'ını çalıştırabilir, ortam değişkenlerini silebilir
  (`env -u VLAD_TASK_ID`), worktree dışına `cd` edebilir.
- **Çalışanın TTY'si yoktur** (Claude'un Bash aracı boru üzerinden çalışır) ve kendi ortamını VLAD'ın yazdığı başlatma
  betiği belirler. VLAD oturumunun ortamına, kullanıcının terminalinde başlatıldığı için, çalışan sahip değildir.
- **Kapsam dışı:** çalışanın kullanıcı hesabını tamamen ele geçirmesi (aynı UID'de `ps -E` ile başka sürecin ortamını okumak,
  anahtar dosyasını `cat` ile okumak). Aynı UID'de bunu kriptografiyle engelleyemeyiz; yalnız zorlaştırır ve hook'la (en iyi
  çaba) kapatırız. Kalıcı çözüm ayrı OS kullanıcısı / Keychain onay istemi; açık nokta olarak izlenir.

## Tasarım

1. **Anahtar:** 32 bayt, 64 hex, `<gizli-dizin>/mode.key`. Gizli dizin `VLAD_SECRET_DIR` ya da `~/.vlad-secret`
   (0700, dosya 0600). **kb'de, repoda, worktree'de ve `VLAD_HOME`'da değildir:** kb git'e gider, worktree'ler çalışanın
   çalışma alanıdır. Anahtar hiçbir ortam değişkenine, loga ya da göreve yazılmaz.
2. **Oturum belirteci:** `VMT1.<bitiş-ms>.<hmac-sha256(anahtar, "VLAD-MODE1|<bitiş-ms>")>`. Varsayılan 24 saat, tavan 72 saat.
   `vlad mode token` onu üretir ve **yalnız TTY'de** çalışır (kullanıcının terminali); çalışanın boru tabanlı Bash'i reddedilir.
   Kullanıcı VLAD oturumunu `export VLAD_MODE_TOKEN=$(vlad mode token)` ile başlatır; belirteç yalnız o oturumun ortamındadır.
3. **Çalışan başlatma betikleri belirteci temizler** (`unset VLAD_MODE_TOKEN` / `Remove-Item Env:VLAD_MODE_TOKEN`; aynı
   `VLAD_DESKTOP_QUEUE` mantığı). Çalışan belirteci kendi ortamında bulamaz.
4. **Korunan CLI işlemleri belirteci CLI'da doğrular:** `vlad mode night|watch|off`, `vlad setup` (`--check` hariç) ve
   `vlad install`. Belirteç yoksa/geçersizse/süresi dolmuşsa işlem reddedilir; hook'tan bağımsızdır, yani hook atlatılsa da CLI
   reddeder. Eski `assertNotWorker` (env/dal/worktree) ek katman olarak kalır.
5. **`mode.json` içindeki gece penceresi imzalıdır:** `night.sig = hmac(anahtar, canonicalJson(night − sig))`; yalnız
   `setNight` imzalar. `modeStatus` imzası geçersiz/eksik pencereyi **yetki olarak saymaz** (`forged: true`). Böylece çalışan
   `mode.json`'u Edit/`echo >` ile doğrudan yazsa bile `task close` gece yetkisi (`src/machines/close.ts`) açılmaz: gerçek
   sınır yazmayı değil **yetkiyi tüketmeyi** doğrular. `watch` bayrağı yetki taşımaz, imzasızdır.
6. **Geriye uyum / kurulmamış makine:** gizli dizin hiç yoksa mekanizma etkin değildir; davranış bugünküyle aynıdır
   (mevcut testler, kurulmamış makineler). Dizin var ama anahtar yoksa ya da bozuksa **fail-closed**: korunan işlemler reddedilir.
   Etkinleştirme: kullanıcı terminalinde `vlad mode token` ilk çalışınca anahtarı üretir.
7. **Hook en iyi çaba katmanı olarak kalır** ve gizli dizin yolunu da korunan yollara ekler (çalışanın `cat`/`cp` ile anahtara
   uzanması ek bir engelle karşılaşır; mutlak sınır değildir, §Tehdit modeli).

## Neden metin ayrıştırmadan bağımsız

Doğrulama kararı, çalışanın komutunun biçimine değil iki olguya bağlıdır: (a) CLI sürecinin ortamında geçerli, süresi dolmamış,
anahtarla imzalı belirteç var mı; (b) `mode.json`'daki pencerenin imzası geçerli mi. `$(...)`, boşluklu yol, `cd` + göreli
yol, değişkenle kurulan komut adı: hepsi yine `vlad mode night`'ı çalıştırır ve belirteçsiz CLI reddeder; ya da `mode.json`'u
doğrudan yazar ve imzasız pencere yetki vermez.

## Windows

Mac'te tamamlandı. Windows'ta `mkdirSync` modu yok sayılır; eşdeğeri `icacls <dizin> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`
(yalnız geçerli kullanıcı, T20261103 `%TEMP%\vlad` ACL kalıbı gibi). Bu adım Windows işçisine bırakıldı (D-genel-014);
kod yolu `chmod` hatasını yutar ve dosya var olduğu sürece çalışır. Windows başlatma betiği (`terminal.ts`) belirteci temizler (testli).

## Açık noktalar (kapsam dışı)

- Aynı UID'de anahtar dosyasını okumak / `ps -E` ile VLAD ortamını okumak: ayrı OS kullanıcısı ya da Keychain.
- `settings.json` / hook / `vlad.config.json` / kb dosyalarına **doğrudan** (CLI dışı) yazma CLI'dan engellenemez; yalnız hook
  (en iyi çaba). Bütünlük tespiti (imza/özet kontrolü `vlad setup --check`) ayrı iş.
- `task close --yes` gibi çalışanın kendisi verebileceği onay bayrakları ayrı değerlendirilir.
