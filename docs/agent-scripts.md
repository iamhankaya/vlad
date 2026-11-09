# Kayıtlı bakım betikleri (T20261109-03 / -07)

Beyin, işçi makinede **yalnız repoda kayıtlı** betikleri çalıştırabilir. Keyfi komut/betik yoktur: yol, yorumlayıcı ve argv istekten gelmez.

## Kullanım

```
vlad machine scripts <ad>                       # işçinin betikleri + bütünlük durumu (salt okuma)
vlad machine run <ad> <betik> --plan            # ne çalışacağını ve plan-id'yi gösterir; çalıştırmaz
vlad machine run <ad> <betik> --confirmed <plan-id> [--param k=v]... [--op-id <id>] [--json]
```

- `read` sınıfı betik `--plan` ya da onay olmadan çalışır. `write` sınıfı (ör. `repo-guncelle`) **kullanıcının açık onayından sonra** `--confirmed <plan-id>` ile çalışır; plan-id makine, ad, platform, betik karması ve parametrelerden türer (biri değişirse onay geçersiz).
- Zaman aşımında aynı `--op-id` ile tekrar çağır: Agent aynı işi ikinci kez çalıştırmaz (journal).
- Çıkış kodu: betik ≠ 0 → 1, geçici ağ hatası → 75.

## Kayıt (`agent-scripts/manifest.json`)

Her giriş: `name`, `title`, `platform` (win32|darwin|linux), `file` (`agent-scripts/<ad>.ps1|.sh`), `sha256`, `class` (read|write), `timeoutSec`, `outputMaxKb`, `selfUpdate`, `params`. Şema dışı alan, çift (ad, platform) ya da uzantı/platform uyumsuzluğu manifestin tamamını reddeder (`[bad_manifest]`). Parametre tipleri: `string` (varsayılan `[A-Za-z0-9._-]`, baştaki `-` ve `..` yasak), `enum`, `int`, `bool`, `root` (config `roots` üyesi).

Betik ya da manifest değişince karmayı güncelle: `node scripts/agent-scripts-sha.mjs --write` (`--check` modu çıkış 1 verir; `test/machines/script-registry.test.ts` aynı denetimi CI'da yapar). `.gitattributes` `agent-scripts/* -text` ile bayt kararlılığı sağlar; `.ps1` yalnız ASCII.

## Bütünlük ve yürütme

1. `VLAD_HOME` bir git deposunun kökü olmalı; `agent-scripts/` altında değişmiş/izlenmeyen dosya varsa red (`dirty`).
2. Doğruluk kaynağı **HEAD'deki blob**'dur (çalışma ağacı değil): düzenli dosya (100644/100755), karması manifestle eşleşmeli (`hash_mismatch`, `not_in_head`, `not_regular`).
3. Çalışan commit origin'in **varsayılan dalında** olmalı (dalın upstream'i `refs/remotes/origin/HEAD`, yoksa origin/main|master olmalı; `unpushed`, `no_upstream`): itilmemiş commit ve özellik dalına itilmiş kod çalışmaz. **Repo push yetkisi = işçide kod çalıştırma yetkisi**; varsayılan dalı korumalı tut (inceleme/branch protection).
   HEAD bir kez okunur (oid); manifest, betik ve atalık kontrolü aynı oid ile yapılır, sonuçtaki `head` çalışan betiğin commit'idir.
4. Blob baytları özel (0600; dizin 0700 / Windows ACL) geçici dosyaya yazılıp o çalıştırılır; Windows'ta ACL kurulamazsa betik çalışmaz (fail-closed); çalışırken `git pull` ya da autocrlf sonucu değiştirmez.
5. `shell:false`; parametreler argv'de değil `VLAD_PARAM_<AD>` ortam değişkenindedir. Ortam allowlist'tir (sırlar, `NODE_OPTIONS`, `VLAD_AGENT_*` geçmez) + `VLAD_HOME/REPO/MACHINE/OP_ID/SCRIPT/ROOTS`.
6. Tavanlar (UTF-8 **bayt**, karakter ortadan kesilmez): stdout `outputMaxKb` (≤32 KiB), stderr 16 KiB, sonuç JSON 16 KiB; zaman aşımında süreç ağacı öldürülür (çıkış 124). Aynı anda tek betik (meşgul kilidi).
7. Yapılandırılmış sonuç: stdout'un son 20 satırında `@@VLAD-RESULT@@ {json}`. Betikteki `restart` anahtarı atılır.

Hata iletisi biçimi: `<kod>: [<neden>] <ayrıntı>`; nedenler: bad_name, bad_param, unregistered, no_variant, dirty, hash_mismatch, not_regular, not_in_head, unpushed, no_upstream, approval, bad_manifest, no_repo.

## Onay ve uzlaştırma notları

- **plan-id kriptografik değil, işlemsel bir kontroldür:** gizli değildir, herkes hesaplayabilir; `--confirmed`'ın kullanıcı onayından sonra verilmesi prosedürel kuraldır (CLAUDE.md). Amacı, onaylanan plan ile çalışan betik/parametre/makine arasındaki kaymayı yakalamaktır. `class`/`timeoutSec`/`file` plan-id'de yoktur (değişimleri `sha256` ve manifest satırıyla incelemede görünür).
- Agent çökmesinde yarım kalan `script-run` kaydı: sınıf (read/write) başlangıçta kayda yazılır; `read` → `aborted` (aynı opId yeniden koşabilir), `write` ya da sınıfı yazılmamış → `done + uncertain` (otomatik yeniden koşma yok; mevcut HEAD'deki manifeste güvenilmez). Belirsiz kayıtta aynı `--op-id` betiği koşmaz, CLI "belirsiz, makinede doğrula" der.
- Terminale yazılan uzak çıktıdan kontrol karakterleri (ESC dizileri) ayıklanır; `--json` çıktısı ham (kaçışlı) kalır.
- Desenli `string` parametrede baştaki `-` yine reddedilir (bayrak enjeksiyonu); manifestte `allowLeadingDash: true` ile açıkça izin verilebilir.

## repo-guncelle

Kök klasörlerdeki (`--param root=<ad>` ya da config `roots`) git depolarında `fetch --prune` + `pull --ff-only`. Agent'ın kendi klonu, symlink/junction alt dizinler, detached HEAD, upstream'siz, kirli ve ayrışmış depolar **atlanır**; fetch/pull hatası `error` sayılır. En çok 80 depo ayrıntısı döner (`omitted`).

## Kendini güncelleme: `vlad-guncelle` (selfUpdate)

Agent'ın kendi vlad klonunu günceller (`win32` `.ps1`, `darwin` `.sh`; manifestte `class: write`, `selfUpdate: true`, parametresiz). Önce `--plan`, kullanıcı onayından sonra `--confirmed` (diğer write betikleri gibi).

Adımlar: kirli izlenen dosya yok mu (`dirty`) → HEAD dalda ve upstream'li mi (`detached`, `no_upstream`) → dal varsayılan dal (`origin/HEAD`; yoksa main/master) ve upstream'i `origin/<aynı dal>` mı (`branch`; başka dal ya da uzak deposu uzaktan kod çalıştıramaz) → `fetch --prune` + `pull --ff-only` (`fetch`, `pull`) → `node_modules` → `node_modules-old` yedeği (işaret dosyası `.vlad-npm-ci-running`) + `npm ci` (`install`; başarısızsa eski `node_modules` geri gelir) → `tsc --outDir dist-next` (`build`) → **dist değişimi** (`dist` → `dist-old`, `dist-next` → `dist`; `swap`) → `dist-old` ve `node_modules-old` **silinmez** (`npm ci` sonrası `tsc`/swap hatasında da eski `node_modules` geri yüklenir; önceki güncellemenin `node_modules-old` yedeği varsa üstüne yazılmaz, `step:install` ile durur): yeni süreç dinlemeye başlayınca Agent siler (Mac: ayrık sağlık bekçisi `src/agent/watchdog.ts`; Windows: yeniden başlatma yardımcısı betiği). Yeni süreç 60 sn içinde dinlemezse aynı bekçi/yardımcı `dist` ve `node_modules`'ı yedekten geri yükler ve Agent'ı yeniden tetikler (Mac `launchctl kickstart -k`, Windows `agent-start.cmd`). Betik zaman aşımıyla ya da çökmeyle öldürülürse (`.vlad-npm-ci-running` işareti kalır) Agent kendisi geri yükler (`recoverSelfUpdate`: `node_modules-old` → `node_modules`, `dist` yoksa `dist-old` → `dist`) ve ancak sonra bakım bayrağını kaldırır; işaret yoksa yedeklere dokunmaz. Mac bekçisi eski Agent'ın çıkışını pid ile izler (`WD_PID`): launchd yenisini hızla açsa da port kapanışı görülmesi gerekmez, eski pid ölünce dinleyen süreç yenidir. Yarıda kesilmiş `npm ci`: bir sonraki koşunun başında işaret dosyası görülür ve eski `node_modules` geri yüklenir. Her başarısızlık `ok:false` + `step` ile döner ve **eski `dist` aynen kalır**; yarım `dist-next` silinir. `dist/.build-head` derlendiği HEAD'i tutar: HEAD ilerlemiş ama derleme önceki koşuda başarısız olduysa güncel görünse de yeniden derlenir; her şey güncelse `changed:false` ile hiçbir şey yapılmaz. `dist-next/`, `dist-old/`, `node_modules-old/` ve `.vlad-npm-ci-running` `.gitignore`'dadır. Kapanış (`stop`) takılan clip/aktarım yüzünden 10 sn'den uzun sürerse süreç yine çıkar; bakım bayrağı sonsuza açık kalmaz. Çalışan sürecin açılışta okuduğu `.build-head` diskteki ile farklıysa (önceki yardımcı başarısız) `changed:false` olsa da yeniden başlatma tekrar zamanlanır. Windows'ta rename AV/kilit nedeniyle başarısız olabilir: `swap` hatası olarak döner, eski `dist` korunur.

`repo-guncelle` Agent'ın kendi klonunu `agent_repo` diye atlar; onu yalnız bu betik günceller.

### Bakım bayrağı (`maintenance`)

`selfUpdate` betiği başlarken: uçuşta başka op (ping/op-status/script-list dışı) varsa `busy [maintenance]` döner ve betik koşmaz; yoksa bayrak açılır. Bayrak açıkken `ping`, `op-status`, `script-list` dışındaki **tüm** op'lar `busy [maintenance]` alır (geçici; CLI çıkış kodu 75): `npm ci` `node_modules`'ı siler, yarım `dist`'te çocuk süreç op'ları (`launch`, `gate`, `merge`, `exec`) çökerdi. Betik başarısız bitince bayrak kalkar; yeniden başlatma bekleniyorsa yeniden başlayana kadar açık kalır.

### Yeniden başlatma

`restart: "scheduled"` yalnız **`selfUpdate` ∧ `exit == 0` ∧ `data.ok === true`** ∧ Agent'ın yeniden başlatma yolu varken döner (betiğin JSON'undaki `restart` atılır). Sonuç günlüğe `done` olarak işlendikten ve yanıt gittikten sonra (2 sn bekleme + uçuşta op kalmaması; takılırsa en çok 5 dk) Agent yeniden başlar:

- **Mac:** Agent temiz kapanıp `exit 0` ile çıkar; launchd `KeepAlive` (`vlad agent install --apply` plist'i) geri getirir. Agent launchd dışında elle başlatıldıysa yalnız çıkar, **elle yeniden başlat**.
- **Windows:** `schtasks onlogon` yeniden başlatmaz. Agent, WMI (`Win32_Process.Create`; Claude Code/Görev Zamanlayıcı iş nesnesinin dışında) ile bir PowerShell yardımcısı açar; yardımcı `agent.pid` dosyası kaybolana (en çok 60 sn) kadar bekler, 2 sn sonra `.vlad-agent\agent-start.cmd`'yi başlatır (`portTaken` çift başlatmayı önler). `agent-start.cmd` yoksa ya da yardımcı başlamazsa Agent **çıkmaz** (eski süreçle sürer, hata `agent.log`'a yazılır, bakım bayrağı kalkar); `vlad agent install --apply` ve elle yeniden başlatma gerekir.

Doğrulama: `vlad machine ping <makine>` yeni `build`'i göstermelidir.

### Kurtarma (Agent ayağa kalkmazsa)

1. Makinede `agent.log`'a bak (`<VLAD_HOME>/.vlad-agent/agent.log`).
2. `node_modules` bozuksa (`npm ci` yarıda kaldı): vlad klonunda `npm ci && npx tsc` (ya da `npm run build`).
3. `dist` eksik/bozuksa: `dist-old` varsa `dist`'in yerine adlandır; yoksa `npx tsc`.
4. Agent'ı başlat: Mac `launchctl kickstart -k gui/$(id -u)/com.vlad.agent`; Windows `<VLAD_HOME>\.vlad-agent\agent-start.cmd` (ya da oturumu kapatıp aç).
5. `vlad machine ping <makine>`.

Sınırlar: `npm ci` ortasında güç kesilirse `node_modules` yarım kalır; bir sonraki `vlad-guncelle` koşusu yedekten geri yükler (elle: `node_modules-old`'u `node_modules` yap, adım 2). Yeni dist açılışta çöküyorsa kod kendini kurtaramaz: bekçi/yardımcı betik bunu dışarıdan yapar (self-contained JS/PowerShell). Windows yolu birim düzeyinde test edildi; gerçek makinede doğrulama ayrı fazdadır.
