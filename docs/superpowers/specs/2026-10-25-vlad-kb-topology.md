# S13a: kb topolojisi tasarım notu (ayrı `vlad-kb` reposu)

> Commit edilecek yer: `docs/superpowers/specs/2026-10-25-vlad-kb-topology.md` (S13b commit eder). Görev dosyasını bölmemek için başlıklar `###` düzeyinde. Dosyaya yazılırken en üst başlık `#` yapılabilir.
> Kaynaklar: plan `docs/plan/vlad-mobile-plan.md` (satır 21, 85, 87, 125, 135, 137, 164, 181, 255-259, 358-361), spec `docs/superpowers/specs/2026-10-24-vlad-mobile-design.md` §4, §11 ve §13 (satır 224-227, 251-264), `CLAUDE.md` "Temel ilke", `kb/decisions.md`, T20261025-53 kapanış raporu. Kod `/tmp/claude-0/vwt88` üzerinde doğrulandı (entegrasyon dalı, `bef1154`). "Varsayım" yazan her şey doğrulanmadı.

#### 0. Kapsam ve tek cümlelik sonuç

Plan, kb'nin vlad reposunun içinde olduğu döneme göre yazılmıştı. kb artık ayrı private repo `iamhankaya/vlad-kb`. Bu not plandaki "kb-server / master topolojisi" ile "kb çok-kullanıcı yazma modeli" kararlarını yeni yapıya çeviriyor.

**Sonuç:** Sunucu `vlad-kb` reposunun `kb-server` dalına push eder. `promoteKb` (`vladapi`, `vlad-gate` App'i) bu dalı doğrular ve `vlad-kb`'nin `main` dalına `--no-ff` merge commit'i olarak geçirir. Windows ve bulut VLAD doğrudan `main`'e yazar ve `main`'i çeker. `vault/docs`, `vlad-kb` kökündeki `docs/` altına taşınır (öneri). Promote'un ilk amacı ("kod master'a geçmesin") ortadan kalktı. Yeni amacı, sunucu ajanının yazdıklarının Windows checkout'una girmeden önce yapısal ve yol kapısından geçmesi. Bu kapının **zorlayıcı** olması `vlad-kb main` üzerinde ruleset olmasına bağlı (Açık nokta 1).

#### 1. Plan terimlerinin yeni topolojideki karşılığı

| Plan (2026-10-24) | Yeni (2026-10-25) | Dayanak |
|---|---|---|
| `master` (vlad reposu) | `main` (`iamhankaya/vlad-kb`) | `git -C /home/user/vlad-kb branch -a`: `origin/HEAD -> origin/main` (doğrulandı) |
| `kb/` öneki | kb repo kökü (önek yok: `tasks/…`, `projects/…`) | `src/kb/home.ts:17-41` (`resolveKbDir`), `src/kb/commit.ts:47-49` (ayrı repoda pathspec `.`) |
| `vault/docs/` (vlad reposu, artık public) | `docs/` (`vlad-kb` kökü), sanal yol yine `vault/docs/…` | Bugün `src/vault/search.ts:25` docs kökünü VLAD_HOME'a bağlıyor (K7) |
| `kb-server` dalı (vlad reposu) | `kb-server` dalı (`vlad-kb`) | K1 |
| `vlad-kbsync`: `vlad kb commit "sunucu: otomatik" --push` | `vlad-kbsync`: `vlad kb sync` | `kb commit` guard'ı `full` (`src/cli-groups/kb.ts:33`, `src/cli-util.ts:81`); etkin olmayan sunucuda çalışan yazmalarını reddederdi (K4) |
| "Her sunucu yazma öncesi `git pull --no-rebase origin master`" | Her `kb sync` döngüsü (60 sn) + takeover + `vlad kb pull` | K4 (sapma, Açık nokta 6) |
| `promoteKb`: `kb/` ve `vault/docs/` dışı fark master'a geçmez | Kök izin listesi + tür/mod/yol/boyut kuralları, geçmiş + net fark denetimi | K5 |

#### 2. Doğrulanan mevcut durum (`dosya:satır`)

- **`commitKb`** (`src/kb/commit.ts:44-85`): ayrı repoda git kb kökünde, pathspec `.` ile çalışır (`:47-49`). `--push` upstream'e ya da `origin <dal>`'a gider (`:62-82`). Kod dışı dosya koruması yalnız legacy düzende var (`:70-81`). `kbPushBranch` **kullanılmıyor**; push reddinde (non-ff) yeniden deneme ve merge yok (`:82` hata fırlatır).
- **`kbPushBranch`** tipte ve şemada zaten var: `src/kb/types.ts:178-181,189`, `schemas/config.schema.json:14,27`. Makine üst yazımı `machineOverlay` ile yapılır (`src/kb/config.ts:21-23,26-39`). Tip yorumu (`types.ts:178`) "upstream yoksa push dalı" diyor; bu not anlamı değiştiriyor (K2).
- **kb konumu:** `VLAD_KB_DIR` → `kbDir` → `<home>/kb` (`src/kb/home.ts:17-41`); `isSeparateKb` (`:44-46`); klasör yoksa açık hata (`:67-69`). `vlad.config.json` `"kbDir": "../vlad-kb"`.
- **`withKbLock`** (`src/kb/lock.ts:68-106`): yalnız **yerel** kilittir (O_EXCL dosya, `kb meşgul` `:86`). Makineler arası sıralamayı `main` sağlar (K8).
- **Etkin kayıt** (`src/active/store.ts`):
  - eşikler `:8-9` (30 dk nabız, 2 sa bayat);
  - `activeStatus`, saat yazanın saatidir; negatif yaş taze sayılır (`:25-26, 33-51`);
  - `claimActive` bayat kaydı uyarıyla devralır (`:60-78`, `:73`);
  - `activeGuard` bayatta yalnız uyarır ve yazma sürer (`:124-131`, `:128`);
  - çalışan muafiyeti (`:107-115`).
  - CLI tarafında `active claim|heartbeat|release` guard `off` (`src/cli-groups/active.ts:20-27`).
- **Makine adı:** `VLAD_MACHINE` ya da hostname (`src/kb/machine.ts:7-11`). Launcher modu win32'de `auto-terminal`, bulutta `cloud`, öteki Linux'ta `process` (`src/launcher/mode.ts:11-19`).
- **Kart:** `CARD_KINDS` içinde `kb_conflict` var (`src/kb/types.ts:111`). Şema `additionalProperties:false` (`schemas/card.schema.json:4`); tekilleştirme anahtarı alanı **yok**. Ajanın seçenek veremediği sabit seçenek kalıbı mevcut (`ACTION_OPTIONS`, `types.ts:116`).
- **Sunucu:**
  - `GithubWriter` yalnız iki yazma yöntemine sahip ve "branch/ref/contents ucu yok" diyor (`server/src/github/writer.ts:13-16, 24, 35`);
  - App token'ı tek repoya kapsamlı (`server/src/github/appToken.ts:116`), izinler `TOKEN_PERMISSIONS` (`:43`);
  - `POST /v1/active/takeover` openapi'de yalnız `200 Ok` ve `409 ActiveElsewhere` ile tanımlı (`contract/openapi.yaml:458-466`), rota tablosunda var (`server/src/http/routes.generated.ts:27`), işleyici yok;
  - `ActiveVlad` (`openapi.yaml:791-801`);
  - `server/src/kbsync/` **yok**; `deploy/` altında yalnız `claude/` var.
- **Bulut/Windows eşitlemesi:** skill'lerde yalnız bulutta `git -C <kbDir> pull --ff-only` var. "Yerelde bu adım atlanır" (`.claude/skills/status/SKILL.md:12-16`, digest ve delegate aynı). Yani Windows bugün kb'yi hiç çekmiyor.
- **Vault:** docs bölgesi `vault/docs` VLAD_HOME'a göre çözülür (`src/vault/search.ts:25, 121-126`). vlad reposunun `.gitignore`'unda `vault/` yok. vlad reposu public, dolayısıyla `vault/docs` oraya yazılırsa private proje belgeleri public olur.
- **`vlad-kb` `.gitignore`:** `inbox/ logs/ vlad-session.txt .vlad.lock` (= `KB_GITIGNORE`, `src/kb/commit.ts:7`). `cards/<id>.lock` (`src/cards/store.ts:34`) ignore'da yok.
- **Karar günlüğü:** "kb ayrı repo (2026-10-25)" kararı `decisions.md`'de kayıtlı değil. Yalnız 2026-10-24 niyet kaydı var (`decisions.md:347-349`); uygulaması T20261025-53'te (Açık nokta 12).

#### 3. Kararlar

**K1. Push hedefi: `iamhankaya/vlad-kb`, dal `kb-server`. `main`'e yalnız promote yazar.**
- Sunucu kb klonunun yerel dalı `kb-server`, upstream'i `origin/kb-server`. `vlad kb sync` `origin HEAD:refs/heads/kb-server` push eder.
- `main`'e sunucu tarafından yalnız `vladapi` içindeki `promoteKb` yazar (`vlad-gate` App token'ı, `contents:write`, yalnız `vlad-kb`).
- Windows ve bulut VLAD `main`'e doğrudan yazar.
- **Gerekçe:**
  - Sunucu ajanı internete açık sohbet ve otonom çalışanlarla en açık yazar.
  - Windows VLAD kb'yi okuyup ona göre iş başlatır: kartın `gate` komutu, `path`, görev tanımı.
  - Sunucu yazmalarının Windows checkout'una doğrulanmadan inmemesi gerekir.
- **Reddedilen (A) sunucu da doğrudan `main`'e yazsın:** En basit yol, ama doğrulama kapısı yok. Symlink, mod ya da Windows'ta geçersiz dosya adı (`aux.md`, `a:b.md`) Windows klonunu bozar; ajan `.gitignore`'u değiştirip `logs/`'u commit'leyebilir. Ruleset gelirse sınır kurulamaz.
- **Reddedilen (C) ayrı "gelen kutusu" reposu `vlad-kb-server`:** Ruleset olmadan da zorlayıcıdır, çünkü ajan PAT'ı `vlad-kb`'ye yalnız okuma alır. Ama repolar arası merge GitHub API'siyle yapılamaz, her zaman yerel merge + push gerekir; bir repo ve bir kimlik ayarı daha eklenir. Ruleset mümkün değilse yedek olarak Açık nokta 1'de duruyor.

**K2. `kbPushBranch` anlamı ve sunucu makinesinin tanımı (güvenli varsayılan).**
- `kbPushBranch` tanımlıysa `--push` her zaman `origin HEAD:refs/heads/<kbPushBranch>` gider (upstream'e bakılmaz).
- Tanımlı değilse ve etkin launcher modu `process` ise (`resolveLaunchMode`, `mode.ts:11-19`) push reddedilir: `kb_push_branch_required`. Diğer modlarda (win32 `auto-terminal`/`wt`/`powershell`, `cloud`) bugünkü davranış sürer: upstream (`main`).
- `kbPushBranch` `main` dalına eşitse ya da `^[A-Za-z0-9._/-]{1,100}$` dışındaysa: `kb_push_branch_invalid`.
- Sunucuda legacy düzen (kb vlad reposunun içinde) reddedilir: `kb_separate_required`.
- Değer yalnız `machines.<sunucu>.kbPushBranch: "kb-server"` olarak yazılır, kökte değil.
- **Gerekçe:** Yeni şema anahtarı yok, bu yüzden eski Windows CLI'ı bozulmaz (`additionalProperties:false`, plan "Sürüm uyumu"). Unutulan ayar push etmez, yani fail-closed.
- **Reddedilen:** açık `role: "server"` anahtarı (unutulursa güvensiz varsayılan: doğrudan `main`, ve şema değişikliği gerektirir); hostname listesi (kırılgan).

**K3. Ana dal adı `main`, `origin/HEAD`'den türetilir.** `kbMainBranch(kbDir)` önce `git symbolic-ref --short refs/remotes/origin/HEAD` sonucunda `origin/` önekini atar; yoksa `"main"`. Promote tarafı ana dal adını config'ten alır (`VLAD_KB_MAIN`, varsayılan `main`). **Reddedilen:** config'e `kbMainBranch` anahtarı (şema değişikliği ve minCliVersion yükü); "master" sabiti (vlad-kb'de yanlış, doğrulandı).

**K4. Birleştirme stratejisi: merge (rebase değil). Sunucu senkronu `vlad kb sync` döngüsü.**
- Sunucu: `vlad-kbsync` (kullanıcı `vlad`, timer 60 sn + path birimi) `vlad kb sync` çalıştırır. Hepsi tek `withKbLock` içinde, sırasıyla:
  1. kirli değişiklikleri `kb: sunucu: otomatik` olarak commit'le;
  2. kayıt bu makinedeyse `heartbeatActive`;
  3. `git fetch origin`;
  4. `git merge --no-edit origin/main` (ff serbest);
  5. `git push origin HEAD:refs/heads/kb-server`.
- Komutun guard'ı `off`. Etkin olmayan sunucuda bile koşan çalışanların yazmaları (`worker` muafiyeti) commit'lenip push edilmeli, yoksa Windows bu raporları göremez. Güvenlik notu: guard'ın koruduğu şey yazma komutlarıdır, onlar zaten guard'dan geçti. `sync` yeni içerik üretmez, yalnız mevcut dosyaları commit'ler.
- Windows ve bulut: `vlad kb pull` (bekleyen değişikliği commit'le, `fetch`, `merge --no-edit origin/main`). `vlad kb commit --push` push'tan önce aynı fetch+merge'ü yapar. Non-ff reddinde bir kez daha fetch+merge+push denenir, sonra `kb_push_rejected`.
- Ortak çakışma kuralı:
  - Çakışan dosya kümesi **yalnız `active.md`** ise `main` kazanır (`git checkout --theirs -- active.md`, merge commit'i). Kural `main` tarafını alır; merge yönü sunucuda ve Windows'ta aynıdır, ikisinde de `origin/main` "theirs" olur.
  - Başka bir dosya çakışırsa `git merge --abort`, çalışma ağacı temiz kalır, yerel commit'ler korunur, hata `kb_conflict`. Sunucuda buna ek olarak `kb_conflict` kartı açılır (K6).
- **Merge'ün gerekçesi:**
  - (a) Yayınlanmış geçmiş yeniden yazılmaz. `kb-server` her döngüde yeniden SHA almaz, force-push gerekmez. Promote'un tekilleştirme anahtarları ve aralık denetimi (`main..kb-server`) kararlı kalır.
  - (b) Çakışma bir kez çözülür. Rebase her sunucu commit'ini yeniden oynatır ve aynı çakışmayı tekrar tekrar üretir.
  - (c) Hangi yazarın neyi yazdığı merge ebeveynlerinde kalır (denetim). Bir promote `git revert -m 1` ile tek adımda geri alınabilir.
- **Reddedilen:**
  - rebase (yukarıdaki nedenler; 60 sn'de bir force-push);
  - squash promote (sunucu geçmişi `main`'in atası olmaz; sonraki döngülerde aynı satırlarda tekrar çakışma çıkar: taban eski, iki taraf farklı);
  - yalnız ff (iki yazar her zaman ayrışır);
  - her CLI yazmasından önce `pull` (planın lafzı). Her `vladapi` çağrısı ağa bağımlı olur ve kilit ağ süresince tutulur. Sunucu tek etkin yazar olduğunda 60 sn gecikme zararsız. Takeover anında senkron ayrıca zorlanır (K8). Bu bir sapma: Açık nokta 6.

**K5. Promote izin listesi ve reddetme kuralları. GÜVENLİK: ana dala yazma kapısıdır.**
- Promote `kb-server`'ı `main`'e iki denetimden geçirerek alır. İkisi de `vladapi`'nin **kendi** bare klonunda, GitHub'dan çekilmiş nesneler üzerinde yapılır:
  - **R1 net fark:** `T = merge-tree(main, H)`; `git diff-tree -r -z --raw --no-renames main T`. Bu, `main` checkout'una inecek tam değişikliktir.
  - **R2 geçmiş:** `git rev-list main..H` aralığındaki her commit C için (en çok 2 ebeveyn, aksi `too_many_parents`):
    - tek ebeveynliyse `diff-tree -r --no-renames --raw P C` girdilerinin hepsi kurallardan geçer;
    - merge commit'iyse `diff-tree P1 C` girdileri, P2'deki aynı yolun (mod, oid) girdisiyle birebir aynı değilse kurallardan geçer. Bu "evil merge" ve çakışma çözümü içeriğini yakalar; `main` tarafından gelen içeriği yeniden denetlemez.
  - Böylece eklenip sonra silinen symlink ya da büyük dosya da `main` geçmişine giremez.
- Kurallar her girdi için geçerli. İlk eşleşen kural id'si raporlanır:

| Kural id | Reddedilen | Not |
|---|---|---|
| `path_not_allowed` | İlk segment izin listesinde değil. İzinli dizinler: `projects/ tasks/ findings/ cards/ grants/ audit/ journal/ docs/`. İzinli kök dosyalar: `decisions.md`, `active.md`. Örnek redler: `README.md`, `inbox/`, `logs/`, `vlad-session.txt`, `.vlad.lock`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.github/` | Plandaki "yalnız `kb/` ve `vault/docs/`" kuralının yeni kökteki karşılığı |
| `dot_entry` | Herhangi bir segment `.` ile başlıyorsa | `.git*` dosyaları ve gizli dizinler |
| `bad_segment` | Segment `^[A-Za-z0-9][A-Za-z0-9._-]*$` dışında, `.`/`..`, sonda `.` ya da boşluk, `\`, `:`, NUL ya da kontrol karakteri içeriyor | `../` buradan reddedilir (git fsck'e ek savunma) |
| `windows_reserved` | `CON PRN AUX NUL COM0-9 LPT0-9` (büyük/küçük harf duyarsız, uzantılı hali de) | Windows `main`'i checkout eder |
| `case_collision` | Aday ağaçta büyük/küçük harf duyarsız eşit iki yol | Windows ve macOS checkout'u |
| `path_too_long` | Yol > 180 karakter ya da derinlik > 4 | |
| `bad_extension` | `.md` dışı. İstisna: `audit/*.jsonl` | `docs/` için de yalnız `.md` (Açık nokta 9) |
| `symlink` | Yeni mod `120000` | |
| `submodule` | Yeni mod `160000` (gitlink) | `.gitmodules` zaten `dot_entry` |
| `mode` | Yeni mod `100644` dışında ya da mod değişikliği (`T` durumu, `100644→100755`) | |
| `rename` | `R` ya da `C` durumu | `--no-renames` ile normalde oluşmaz; savunma. Rename D+A olarak görünür ve D kuralına takılır |
| `delete_not_allowed` | `D` durumu, `active.md` dışında | CLI'da kb dosyası silen tek yol `releaseActive` (`src/active/store.ts:97`) |
| `too_large` | Blob > 1 MiB (vault sınırıyla aynı, `src/vault/search.ts:13`), değişiklik > 2000 girdi, aralık > 500 commit | Boyut `git cat-file -s` ile |
| `sensitive_field` | `projects/*.md` frontmatter'ında `gate`, `repo`, `default_branch`, `path`, `local_only` ya da `paths.<sunucu dışı makine>` değişikliği | **Öneri, kullanıcı kararı** (Açık nokta 5). Sunucu ajanının Windows'ta komut çalıştırtmasını (`gate`) ya da başka klona yönlendirmesini keser. `paths.<sunucu>` serbest (`vlad project path --machine`) |

- Ek değişmezler:
  - Promote **asla** sunucu ajanının kb klonunda git çalıştırmaz (K9).
  - Yazılan commit'in ebeveynleri tam olarak `[M, H]`.
  - Push zorlamasızdır (non-force). `main` arada ilerlemişse push reddedilir (`main_moved`) ve yazma olmaz.
  - Doğrulanan ağaç = inen ağaç.
- **Gerekçe:** R1 checkout güvenliğini sağlar, R2 geçmiş hijyenini (sır/boyut bombası ve symlink geçmişe girmez).
- **Reddedilen:**
  - Yalnız net fark: geçmişte geri alınmış kötü blob'lar `main`'e girer.
  - Yalnız commit bazlı denetim: çakışma çözümünü ve merge içeriğini kaçırır.
  - GitHub `POST /merges` API'si: doğrulanan ile inen ağaç farklı olabilir, CAS yok.
  - Git Data API ile ağaç oluşturma: gereksiz karmaşa.

**K6. Çakışma akışı: `kb_conflict` kartı; aynı fark için yeniden açılmaz.**
- İki üretici var, roller ayrı:
  - **`kbsync`** (sunucu, `vlad`): `merge origin/main` çakışması → `reason: merge_conflict`, `source: kbsync`.
  - **`promote`** (`vladapi`): kural ihlali → `reason: rejected`, `source: promote`.
  - Promote'ta `merge-tree` çakışması kart açmaz, yalnız `reason: merge_conflict` döner. Aynı çakışmayı bir sonraki `kbsync` döngüsü görür ve kartı o açar. Böylece kart tek kaynaktan gelir.
- **Anahtar:** `key = sha256hex("vlad-kbconflict/v1\n" + reason + "\n" + sort(lines).join("\n"))`.
  - `rejected` satırları: `<kural>\t<durum>\t<yeniMod>\t<yeniOid>\t<yol>`.
  - `merge_conflict` satırları: `<yol>\t<bizimOid>\t<onlarınOid>`.
  - Aynı ihlal ya da aynı çakışma aynı anahtarı üretir. Araya ilgisiz commit girmesi anahtarı değiştirmez.
- **Yeniden açılmama:** Aynı `key` ile kart **herhangi bir durumda** varsa (`open|resolved|dismissed`) yeni kart açılmaz. `vlad card new` mevcut id'yi `created:false` ile döndürür.
  - Promote tarafında yetkili kopya `/var/lib/vladapi/kbpromote/state.json` `seen[key] = card_id`. Ajan kart dosyasını silse bile kart yeniden açılmaz ve spam olmaz.
- **Otomatik kapanış:** Temiz bir `kbsync` döngüsü kendi `source: kbsync` açık kartlarını `resolved` yapar; başarılı promote `source: promote` kartlarını.
- **Engelin görünürlüğü:** Kart kapatılsa (`dismissed`) bile promote engelliyken `GET /home` `active_vlad.kb_sync.state = "blocked"` gösterir. Sessiz takılma olmaz.
- **Seçenekler sabit,** ajan veremez (kalıp `ACTION_OPTIONS`, `types.ts:116`):
  - `merge_conflict`:
    - `take_main`: çakışan dosyalarda `main` sürümü alınır, sunucu sürümü `logs/kb-conflicts/<key8>/` altına yedeklenir (gitignored, yerel).
    - `manual`: kullanıcı SSH ile `vlad kb resolve`.
  - `rejected`:
    - `discard`: ihlalli girdiler `main` sürümüne döndürülür (eklenenler silinir) ve sunucu dalı `origin/main` üstüne tek temizleme commit'i olarak yeniden kurulur. Ardından `push --force-with-lease=refs/heads/kb-server:<eski>`; R2 geçmişi temizlenmiş olur. Atılan girdiler `logs/kb-conflicts/<key8>/`'e yedeklenir.
    - `manual`.
- **Cevabı kim uygular:** `kbsync`, sonraki döngüde cevaplanmış açık kartları okur ve uygular. Kart `kb/` içinde olduğu için cevap sahtelenebilir (kb güven sınırı değil, plan satır 85). Sahte cevabın etkisi yalnız kb içeriğiyle sınırlı ve sonuç yine promote kurallarından geçer. Kabul edilir.
- **Kullanıcının çözüm adımları:**
  1. Kart telefonda görünür.
  2. Basit durumda `take_main` ya da `discard` seçilir.
  3. Karmaşık durumda: sunucuya SSH (`vlad` kullanıcısı) → `vlad kb resolve --take main|local [--path P…]` ya da elle düzenleme ve ardından `vlad kb commit` (elle düzenleme yalnız çakışma çözümü istisnasıdır).
  4. Windows'ta `vlad kb pull` çakışırsa terminalde `kb_conflict` + yol listesi gelir. VLAD kullanıcıya gösterir, `vlad kb resolve` önerir.
- **Reddedilen:**
  - Her döngüde kart açmak (bildirim spam'i).
  - Anahtara head SHA'yı koymak (her yeni commit'te kart açılır).
  - Tekilleştirmeyi yalnız kb'de tutmak (ajan silebilir).

**K7. `vault/docs` yeri: `vlad-kb` kökünde `docs/` (öneri, kullanıcı kararı).**
- Kökler: ayrı kb düzeninde `docs` bölgesinin kökü `<kbDir>/docs`, legacy düzende `<home>/vault/docs`.
- API ve mobil sanal yolu değişmez (`vault/docs/…`).
- `kb` bölgesi `docs/`'u listelemez (çift sonuç olmasın). vlad reposunun `.gitignore`'una `vault/` eklenir.
- `docs/` elle ya da Obsidian'la düzenlenebilir (spec §11, satır 226). Commit'i `vlad kb commit` ile yapılır (pathspec `.` zaten kapsar).
- **Gerekçe:** vlad reposu public; taşınan planlar private projelere ait (karar `decisions.md:347-349`). Tek repo, tek senkron, tek promote kuralı.
- **Reddedilen:** `vault/docs` vlad reposunda kalsın (gizlilik); üçüncü bir "docs" reposu (fazladan senkron).

**K8. Sıralama: takeover → promote ve çift VLAD yarışları.**
- **Doğrusallaştırma noktası `origin/main`.** Bir claim ancak `main`'e indiğinde geçerlidir. `withKbLock` yerel kalır (aynı makinedeki eşzamanlı claim'i tekler, S4b testi).
- **`POST /v1/active/takeover`** (session, `vladapi`, tek uçuş; ikinci istek `409 takeover_in_progress`):
  1. `requestSync()`: `logs/kbsync.request`'e `{seq, at, reason:"takeover"}` yazılır. `vlad-kbsync.path` hemen tetiklenir.
  2. `waitSync(seq, 20 s)`: `logs/kbsync.status.json` `seq` ≥ istek ve `ok:true` olana kadar beklenir. `ok:false` ve `error:"kb_conflict"` ise `409 kb_conflict` döner, claim yapılmaz. Süre dolarsa `503 kb_sync_unavailable`, claim yapılmaz.
  3. `runVlad(["active","claim","--takeover","--json"])`: git yok, yalnız `active.md` yazılır.
  4. `requestSync()` + `waitSync()`: claim commit'lenir ve `kb-server`'a push edilir.
  5. `promoteKb({trigger:"takeover"})`: promote kilidi için en çok 15 sn beklenir.
  6. Doğrulama: `vladapi` kendi klonunda `git show origin/main:active.md` okur. `machine == sunucu` ise `200 {ok:true, state:"active"}`. Değilse `202 {ok:true, state:"pending", reason}` ve `active_vlad.takeover = {state:"pending", reason, at}`.
- **Bekleme durumu:** Timer'lı promote'lar devam eder; ilk başarılı inişte `state:"active"` olur. `kbsync` merge'ünde `active.md` çakışırsa `main` kazanır (K4), kayıt başka makineyi gösterir ve `takeover.state = "lost"`. Plandaki "bekliyor kartı" (plan satır 87) burada S13d'nin **etkin VLAD UI kartı**dır, kb kartı değil (yorum, Açık nokta 13). Neden çakışmaysa ayrıca `kb_conflict` kartı açılır.
- **Eşzamanlı claim (Windows ve sunucu, aynı tabandan):** `main`'e ilk inen kazanır.
  - Windows önce inerse sunucunun promote'u `active.md`'de çakışır (`merge_conflict`, kart yok). Sonraki `kbsync` `main` kazanır kuralıyla sunucuyu etkin olmayan yapar → `lost`.
  - Sunucu önce inerse Windows'un push'u non-ff reddedilir. `kb commit --push` fetch+merge yapar, `active.md` çakışmasında `main` kazanır, push edilir ve uyarı verilir: "`active_elsewhere`: etkin VLAD artık <sunucu>; bu makine salt okunur".
  - **Kayıp yazma yok:** kaybedenin diğer commit'leri merge ile korunur ve `main`'e ulaşır (sunucuda promote'la).
- **Takeover sonrası salt okunur:**
  - Windows bir sonraki `vlad kb pull`'da yeni `active.md`'yi alır. Yazma komutları `active_elsewhere` ile durur (`activeGuard`, `store.ts:124-131`), okumalar serbest.
  - Bunun için Windows akışlarının başına `vlad kb pull` girer (skill'lerdeki "yerelde atlanır" kaldırılır, `SKILL.md:12-16`) ve CLAUDE.md açılışına eklenir.
  - Pull'dan önce Windows'ta yapılmış yazmalar push sırasında merge'lenir; kaybolmaz (eski etkin makinenin son yazmaları kabul edilir).
  - Sunucu etkin değilken API yazma uçları CLI'dan `active_elsewhere` alır, bu `409`'a çevrilir (`server/src/vlad/cli.ts:9`). Çalışan yazmaları muafiyetle sürer ve `kbsync` ile akar.
- **Saat kayması:**
  - Yaş yazan makinenin saatine göre ölçülür (`store.ts:33-36`). Yazanın saati ilerideyse yaş negatif çıkar ve kayıt taze sayılır (güvenli taraf).
  - Yazanın saati geride ise kayıt s kadar erken bayatlar. 2 saatlik eşikte dakikalık kayma önemsiz. Saatlerce kayma, sessizce "bayat → yazma sürer" yoluna düşürür (`store.ts:128`).
  - Önlem 1: `activeStatus`, kaydın `heartbeat`'i yerel saatten 5 dk'dan fazla ilerideyse `clock_skew` uyarısı ekler (yeni sabit `ACTIVE_SKEW_WARN_MS = 5*60_000`).
  - Önlem 2: `vlad-server doctor`'a `ntp_synced` kontrolü (S14b, `timedatectl show -p NTPSynchronized`; varsayım: Ubuntu 24.04'te mevcut).
  - Kayıt zamanı için GitHub sunucu saati kullanılmaz (Windows'ta yok).
- **Reddedilen:**
  - Claim'i yerel yazma anında geçerli saymak (iki makine aynı anda "etkin" olur).
  - Uzaktan kilit servisi (yeni bağımlılık; `main` yeterli).
  - Takeover'ı promote beklemeden "active" döndürmek (Windows hâlâ yazıyor olabilir).

**K9. `vladapi` git güvenliği. GÜVENLİK.**
- `vladapi` **hiçbir zaman** ajan tarafından yazılabilen kb klonunda git çalıştırmaz. O reponun `.git/config` dosyasını ajan kontrol eder (`core.fsmonitor`, `core.hooksPath` vb.), bu da `vladapi` olarak kod çalıştırma demektir.
- Promote yalnız `/var/lib/vladapi/kbpromote/repo.git`'te (bare, 0700) çalışır ve GitHub'dan HTTPS ile çeker.
- Sertleştirilmiş ortam:
  - `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=<stateDir>`, `GIT_TERMINAL_PROMPT=0`;
  - `-c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always -c transfer.fsckObjects=true -c fetch.fsckObjects=true -c submodule.recurse=false -c credential.helper=`;
  - token argv'de ya da URL'de değil, `GIT_ASKPASS` betiği ve env üzerinden;
  - `--no-tags`, yalnız iki refspec.
- CLI tarafı: git çalıştıran `kb` komutları (`commit|pull|sync|resolve`) kb `.git` sahibi `process.getuid()` değilse `git_owner_mismatch` ile reddeder (POSIX; Windows'ta atlanır). Böylece `runVlad` yanlışlıkla bu komutları `vladapi` olarak çağıramaz.
- Ek savunma: `install.sh` `vladapi` için `safe.directory` eklemez (git ≥2.35.2 sahiplik kontrolü; sunucuda git 2.43 varsayım, bu ortamda 2.43.0 doğrulandı).
- `logs/kbsync.status.json` ajanın yazabildiği bir dosyadır ve güvenilmez. `vladapi` onu yalnız bekleme ipucu olarak kullanır; "active" kararı kendi klonundaki `main`'den verilir.

**K10. Tek yazma çıkışı genişler: `GithubWriter.pushKbMain`. GÜVENLİK.**
- Promote'un tek yazması `GithubWriter.pushKbMain(commit, expectedMain)` olur:
  - repo ve ref config'ten sabittir (`VLAD_KB_REPO`, `refs/heads/<VLAD_KB_MAIN>`), parametre olarak alınmaz;
  - push zorlamasızdır;
  - token `{repositories:["vlad-kb"], permissions:{contents:"write"}}` ile alınır, önbellek anahtarı repo+izin kümesi.
- Başlangıç denetimi: `VLAD_KB_REPO` herhangi bir proje kartının `repo`'suna eşitse (ör. `iamhankaya/vlad`) sunucu açılmaz (`kb_repo_is_code_repo`). Aksi halde bu yöntem kod reposunun ana dalına onay yolunu atlayarak yazardı.
- `writer.ts:13-16` yorumu ve S9b statik taraması bu yönteme göre güncellenir.
- **Reddedilen:** promote'u `GithubWriter` dışında ayrı `git push` ile yapmak (tek çıkış değişmezi kırılır, sayaç kaçar).

#### Bileşenler

1. **`src/kb/commit.ts` + yeni `src/kb/sync.ts`** (CLI, S13b).
   - Yapar: `commitKb` push hedefi (K2), push öncesi fetch+merge ve non-ff yeniden deneme (K4); `pullKb`, `syncKb`, `resolveKb`, `kbMainBranch`, `assertGitOwner`.
   - Yapmaz: promote, `main`'e sunucudan yazma, içerik doğrulama.
   - Bağımlılıklar: `withKbLock`, `activeStatus`/`heartbeatActive`, `addCard`.
2. **`vlad-kbsync`** (systemd `service` + `timer` 60 sn + `path`, kullanıcı `vlad`, umask 002; S13b betik ve birimler, S14a kurar). Tek iş: `vlad kb sync --json`.
3. **`server/src/kbsync/rules.ts`** (saf, S13c): ham diff ayrıştırma, yol/tür kuralları, hassas alan kontrolü, çakışma anahtarı. Git ve G/Ç yok.
4. **`server/src/kbsync/promote.ts`** (S13c, GÜVENLİK): kendi bare klonu, fetch, R1/R2, `merge-tree`, `commit-tree`, `pushKbMain`, kart açma/kapatma (`runVlad card …`), durum dosyası, dosya kilidi.
5. **`server/src/kbsync/takeover.ts` + `routes-active.ts`** (S13c): K8 sırası; `requestSync`/`waitSync`; `GET /home` `active_vlad.takeover|kb_sync` alanları.
6. **`GithubWriter.pushKbMain`** (S13c, GÜVENLİK, K10).
7. **`vlad-server kb-promote`** alt komutu + `vlad-kbpromote.{service,timer}` (kullanıcı `vladapi`, 60 sn, kbsync'ten 30 sn kaydırılmış).
8. **Kart şeması `kb_conflict` alanı** (S13b): `card new` bayrakları, tekilleştirme.
9. **Vault docs kökü** (K7; slice kullanıcı kararı, Açık nokta 4).

#### Sistem tasarımı

`exposure: internet` (kart `projects/vlad.md`; karar 2026-10-25). Bu not dışa açık tek uç olarak `POST /v1/active/takeover`'ı ekliyor. Geri kalan her şey sunucu içi ve GitHub.

**Veri akışı**

```
Windows VLAD ──push──▶ vlad-kb:main ◀──pushKbMain (vlad-gate, ff, CAS)── vladapi promote
      ▲  pull                │  fetch (HTTPS, kendi bare klonu)              ▲
      └──────────────────────┘                                              │ fetch
Bulut VLAD ──push/pull──▶ main                                              │
sunucu kb klonu (vlad) ──vlad kb sync: commit → merge origin/main → push──▶ vlad-kb:kb-server
      ▲ CLI yazmaları (withKbLock): vlad ajan/çalışan, vladapi (grup yazma, git YOK)
```

Gecikme: sunucu yazması ≤60 sn içinde `kb-server`'a, sonraki promote'la ≤~90 sn içinde `main`'e ulaşır. Windows bunu bir sonraki `kb pull`'da görür. Telefon sunucu klonunu okur, gecikme yok.

**Yetki ve kimlik (GÜVENLİK)**

| Kimlik | `vlad-kb` yetkisi | Not |
|---|---|---|
| Ajan PAT (`vlad`) | contents:write (`kb-server` için; GitHub dal bazında daraltamaz) | Yeni izin (Açık nokta 2). Ruleset yoksa `main`'e de yazabilir (Açık nokta 1) |
| `vlad-gate` App (`vladapi`) | contents:write, yalnız `vlad-kb`, istek başına token | App'in `vlad-kb`'ye kurulması gerekir (Açık nokta 3) |
| Kullanıcı (Windows) | admin | Ruleset varsa bypass |

Önerilen ruleset (`vlad-kb`):
- `main` güncellemesi yalnız `vlad-gate` + admin bypass;
- force-push ve silme engelli.
- `kb-server` üzerinde kısıt yok (`discard` force-with-lease gerektirir).

**Hata senaryoları**

| Durum | Davranış |
|---|---|
| GitHub erişilemez | `kb sync` push hatası → `status.ok=false, error:"kb_fetch_failed"`; promote `github_unavailable`; sonraki döngüde tekrar denenir. Yerel yazma sürer |
| `main` arada ilerledi | `main_moved`, yazma yok, sonraki döngü |
| `kbsync` çökük ya da timer durmuş | `GET /home` `kb_sync.state:"stale"` (son başarılı döngü > 5 dk); takeover `503 kb_sync_unavailable` |
| Promote engelli (`rejected`) | Kart + `kb_sync.state:"blocked"`; sunucu yazmaları `main`'e gitmez, kaybolmaz |
| `vladapi` yeniden başlatıldı | Durum dosyası atomik (`tmp`+`rename`); promote idempotent (`up_to_date`) |

**Kurtarma:**
- Kötü bir promote `git revert -m 1 <promote>` ile geri alınır (Windows'tan, kullanıcı).
- Sunucu klonu bozulursa: klon silinir, `git clone` + `git switch -c kb-server origin/kb-server` yapılır.

**Maliyet:** ek servis yok, GitHub API çağrıları dakikada birkaç tane.

#### Arayüzler

**CLI (`vlad`, S13b).** Hata biçimi mevcut kurala uyar: stderr `{"error":"<kod>: <metin>","details":[…]}`, çıkış 1 (`src/cli-util.ts:12-17`). Testler `error`'ın önekine bakar (kalıp: `store.ts:17` `active_elsewhere:`).

```
vlad kb commit <mesaj> [--push] [--json]
  → {committed, sha?, pushed?, branch?, merged?, warning?}
  Hatalar: kb_push_branch_required | kb_push_branch_invalid | kb_separate_required |
           kb_conflict (details: yollar) | kb_push_rejected | kb_fetch_failed | git_owner_mismatch
vlad kb pull [--json]                     guard: off; bekleyeni commit'ler, fetch, merge origin/<main>
  → {committed, merged:boolean, fastForward:boolean, activeMachine:string|null, warnings[]}
vlad kb sync [--json]                     guard: off; yalnız kbPushBranch tanımlı makinede (aksi kb_push_branch_required)
  → {committed, heartbeat:boolean, merged, pushed, head, main, card?:string, applied?:string[]}
  Yan etki: logs/kbsync.status.json = {v:1, seq, at, ok, phase:"commit"|"fetch"|"merge"|"push"|"done", error?, head?, main?}
vlad kb resolve --take main|local [--path <yol>]... [--card <id>] [--json]
  → merge origin/<main> yeniden yapılır; belirtilen (yoksa tüm) çakışan yollar seçilen taraftan alınır;
    diğer taraf logs/kb-conflicts/<key8>/ altına yedeklenir. Hata: kb_conflict (seçim dışı kalan çakışma)
vlad card new --kind kb_conflict --project vlad --title <t>
     --conflict-key <64hex> --conflict-reason merge_conflict|rejected --conflict-source kbsync|promote
     --conflict-head <40hex> --conflict-base <40hex> [--conflict-path <yol>]... [--conflict-rule <id>]... [--json]
  → {id, created:boolean}   (aynı key herhangi bir durumda varsa created:false, aynı id)
  kb_conflict için --option reddedilir: "kb_conflict seçenekleri sabittir"
```

**Config.** Yeni anahtar yok. `machines.<sunucu>.kbPushBranch: "kb-server"` (mevcut şema, `schemas/config.schema.json:27`). `types.ts:178` yorumu K2'ye göre düzeltilir.

**Kayıt alanları.** `CardData.kb_conflict` (yalnız `kind: kb_conflict` için zorunlu, öteki türlerde yasak; kod kontrolü + şema):

```json
"kb_conflict": { "type": "object", "additionalProperties": false,
  "required": ["key","reason","source","head","base","paths"],
  "properties": {
    "key":    { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "reason": { "enum": ["merge_conflict","rejected"] },
    "source": { "enum": ["kbsync","promote"] },
    "head":   { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "base":   { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "paths":  { "type": "array", "maxItems": 50, "items": { "type": "string", "maxLength": 200 } },
    "rules":  { "type": "array", "items": { "enum": ["path_not_allowed","dot_entry","bad_segment","windows_reserved","case_collision","path_too_long","bad_extension","symlink","submodule","mode","rename","delete_not_allowed","too_large","too_many_parents","sensitive_field"] } } } }
```

Sabit seçenekler: `KB_CONFLICT_OPTIONS = { merge_conflict: [{id:"take_main",label:"main sürümünü al"},{id:"manual",label:"Elle çözeceğim"}], rejected: [{id:"discard",label:"Reddedilenleri at"},{id:"manual",label:"Elle çözeceğim"}] }`.

`active.md`: değişmez. `activeStatus().warnings`'e `clock_skew: …` eklenebilir.

**Sunucu (S13c).**

```ts
// server/src/kbsync/rules.ts (saf)
export const KB_ALLOWED_DIRS = ["projects","tasks","findings","cards","grants","audit","journal","docs"] as const;
export const KB_ALLOWED_FILES = ["decisions.md","active.md"] as const;
export const KB_DELETABLE = ["active.md"] as const;
export const PROMOTE_LIMITS = { blobBytes: 1_048_576, changes: 2000, commits: 500, pathChars: 180, depth: 4 } as const;
export type RuleId = "path_not_allowed"|"dot_entry"|"bad_segment"|"windows_reserved"|"case_collision"|"path_too_long"
  |"bad_extension"|"symlink"|"submodule"|"mode"|"rename"|"delete_not_allowed"|"too_large"|"too_many_parents"|"sensitive_field";
export interface RawChange { status: "A"|"M"|"D"|"T"|"R"|"C"|"U"|"X"; oldMode: string; newMode: string; oldOid: string; newOid: string; path: string }
export interface Violation { rule: RuleId; path: string; detail?: string }
export function parseRawZ(out: string): RawChange[];                       // `diff-tree -r -z --raw --no-renames`
export function checkPath(path: string): RuleId | null;
export function checkChanges(ch: RawChange[], ctx: { sizeOf(oid: string): number; candidatePaths: string[] }): Violation[];
export function checkSensitiveFields(path: string, oldText: string | null, newText: string | null, serverMachine: string): Violation[];
export function conflictKey(reason: "merge_conflict"|"rejected", lines: string[]): string;

// server/src/kbsync/promote.ts
export type PromoteReason = "up_to_date"|"no_server_branch"|"merge_conflict"|"rejected"|"main_moved"|"github_unavailable"|"busy"|"not_configured";
export interface PromoteResult { promoted: boolean; reason?: PromoteReason; main?: string; head?: string; merge?: string; card?: string; violations?: Violation[] }
export interface KbSyncConfig { repo: string; main: string; serverBranch: string; serverMachine: string; stateDir: string; remoteUrl?: string /* yalnız test */ }
export interface PromoteDeps {
  config: KbSyncConfig;
  git: (args: string[], o?: { input?: string }) => Promise<{ code: number; stdout: string }>; // sertleştirilmiş, cwd=<stateDir>/repo.git
  tokens: { token(repo: string, perms: { contents: "write" }): Promise<string> };
  writer: Pick<GithubWriter, "pushKbMain">;
  cards: { open(i: KbConflictInput): Promise<{ id: string; created: boolean }>; resolveOpen(source: "promote"): Promise<number> };
  now(): number;
}
export function promoteKb(d: PromoteDeps, o?: { trigger?: "timer"|"takeover"; waitLockMs?: number }): Promise<PromoteResult>;
// plan imzası (plan satır 164) korunur: { promoted, reason? } alt kümedir.

// server/src/github/writer.ts (ek)
async pushKbMain(commit: string, expectedMain: string): Promise<{ kind: "pushed" } | { kind: "main_moved" }>;
// commit'in ilk ebeveyni expectedMain değilse fırlatır; repo/ref config'ten; non-force.

// server/src/kbsync/takeover.ts
export type TakeoverState = "active"|"pending"|"lost";
export function takeover(d: TakeoverDeps): Promise<{ state: "active" } | { state: "pending"; reason: PromoteReason }>;
export function requestSync(kbDir: string, reason: string): number;               // seq
export function waitSync(kbDir: string, seq: number, timeoutMs?: number): Promise<KbSyncStatus>; // varsayılan 20 000
```

**API (`contract/openapi.yaml`).**
- `POST /active/takeover` (session):
  - `200 {ok:true, state:"active"}`
  - `202 {ok:true, state:"pending", reason}`
  - `409 kb_conflict | takeover_in_progress`
  - `503 kb_sync_unavailable`
  - `401`
- `ActiveVlad` ek alanlar: `takeover?: {state:"active"|"pending"|"lost", reason?, at}`, `kb_sync: {state:"ok"|"conflict"|"blocked"|"stale", last_ok: Timestamp|null, card?: CardId}`.
- `Card.kb_conflict` (yukarıdaki şema).
- Hata kodu enum'una (`openapi.yaml:659`) eklenir: `kb_conflict`, `takeover_in_progress`, `kb_sync_unavailable`.
- Sunucu env: `VLAD_KB_REPO=iamhankaya/vlad-kb`, `VLAD_KB_MAIN=main`, `VLAD_KB_SERVER_BRANCH=kb-server`, `VLAD_KB_DIR`.

#### Dosya yapısı

- **S13b:**
  - `src/kb/commit.ts` (K2, K4 push yolu);
  - yeni `src/kb/sync.ts`;
  - `src/cli-groups/kb.ts` (`kb pull|sync|resolve`);
  - `src/cli-groups/card.ts` (`--conflict-*` bayrakları);
  - `src/cards/store.ts` (`findCardByConflictKey`, idempotent `addCard`);
  - `src/kb/types.ts` (`CardData.kb_conflict`, `KB_CONFLICT_OPTIONS`, `kbPushBranch` yorumu);
  - `schemas/card.schema.json`;
  - `src/active/store.ts` (`clock_skew` uyarısı; S4b'nin tamamlanmış dosyası, tek ekleme);
  - `src/kb/commit.ts` `KB_GITIGNORE` + `cards/*.lock` (vlad-kb `.gitignore`'u VLAD ayrıca commit'ler);
  - `deploy/systemd/vlad-kbsync.{service,timer,path}`;
  - `.claude/skills/{status,digest,delegate}/SKILL.md` (yerelde de `vlad kb pull`);
  - `CLAUDE.md` (açılışa `vlad kb pull`, komut listesi satırına `kb pull|sync|resolve`);
  - `test/records/s13b.test.ts`.
- **S13c:**
  - `server/src/kbsync/{rules,promote,takeover,gitexec,state}.ts`;
  - `server/src/github/writer.ts` (`pushKbMain`);
  - `server/src/github/appToken.ts` (izin kümesi parametresi);
  - `server/src/http/routes-active.ts` + `app.ts` tek satır (mevcut `xHandlers` kalıbı, `app.ts:15-20`);
  - `server/src/read/*` (`active_vlad` eşlemesi);
  - `server/src/bin/vlad-server.ts` (`kb-promote` alt komutu);
  - `contract/openapi.yaml` (kendi bölümü);
  - `deploy/systemd/vlad-kbpromote.{service,timer}`;
  - `server/test/unit/kbsync/*.test.ts`, `server/test/integration/kbsync-*.test.ts`.
- **T13:** `test/acceptance/mobile-t13-*.test.ts`, `server/test/acceptance/kb-topology-*.test.ts`.
- **K7 (slice kararına göre):** `src/vault/search.ts`, `.gitignore` (`vault/`).
- **S13b'nin commit edeceği not:** `docs/superpowers/specs/2026-10-25-vlad-kb-topology.md`.

#### Paylaşılan dosyalar ve ad alanları

| Dosya | Dokunan | Sahip | Kural |
|---|---|---|---|
| `src/kb/commit.ts` | S13b | S13b | Tek sahip (plan tablosu) |
| `src/kb/types.ts`, `schemas/card.schema.json` | S13b | S1a iskeleti, alan S13b | Yalnız `kb_conflict` alanı ve sabitleri eklenir |
| `src/active/store.ts` | S13b | S4b (bitti) | Yalnız `clock_skew` uyarısı; mevcut satır değişmez |
| `contract/openapi.yaml` | S13c | S6a | Yalnız takeover yanıtları, `ActiveVlad` alanları, `Card.kb_conflict`, 3 hata kodu |
| `server/src/http/app.ts` | S13c | S6b | Tek `activeHandlers` satırı |
| `server/src/github/writer.ts` | S13c | S9b | Tek yöntem `pushKbMain`; S9b statik taramasına bu yöntem eklenir; T9'un `single-exit.matrix.ts` dosyasına dokunulmaz |
| `deploy/systemd/*` | S13b, S13c, S14a | S14a (kurulum) | S13b kbsync, S13c kbpromote birim dosyalarını getirir; S14a yalnız kurar |
| `CLAUDE.md`, `.claude/skills/*/SKILL.md` | S13b | S13b | Komut listesi tek satır çakışma noktası (kart çalışma notu 2026-10-24); S13b'den önce/sonra paralel CLI dilimi varsa sıralı merge |

Test önekleri: S13b `describe("records: kb sync …")`, S13c `describe("server: promote …")` / `describe("server: takeover …")`, T13 `describe("acceptance: kb topology …")` ve dosya öneki `mobile-t13-` / `kb-topology-`. Ortak git test yardımcısı (geçici bare remote + iki klon) T13'ün `server/test/helpers/kbRepos.ts` dosyasıdır; S13b kendi yerel yardımcısını kullanır.

#### Görev listesi

- **S13b** (developer, sıralı; S1c ve S13a'ya bağlı):
  1. `kbMainBranch`, `assertGitOwner`, `mergeMain` (`active.md` → `main` kazanır; diğer çakışmalarda abort + `kb_conflict`) ile `src/kb/sync.ts`.
  2. `commitKb`: K2 hedef kuralı, push öncesi fetch+merge, tek non-ff yeniden deneme, `branch`/`merged` alanları; legacy davranış aynen.
  3. `kb pull`, `kb sync` (guard `off`, durum dosyası, istek seq'i), `kb resolve` (yedekleme).
  4. Kart `kb_conflict` alanı, sabit seçenekler, `--conflict-*` bayrakları, anahtarla idempotent `card new`; `kb sync` içinde kart açma, cevap uygulama (`take_main`, `discard` + force-with-lease) ve otomatik kapatma.
  5. `clock_skew` uyarısı.
  6. systemd birimleri (`service` `ExecStart=vlad kb sync --json`, `User=vlad`, `UMask=0002`; timer 60 sn; path `PathModified=<kbDir>/logs/kbsync.request`).
  7. Skill/CLAUDE.md güncellemesi; tasarım notunun commit'i.
- **S13c** (developer, GÜVENLİK; S13b, S9b, S4b'ye bağlı):
  1. `rules.ts` (saf) + birim testleri.
  2. `gitexec.ts` sertleştirilmiş çalıştırıcı + bare klon hazırlığı.
  3. `writer.pushKbMain` + token izin kümesi + başlangıç denetimi (`kb_repo_is_code_repo`).
  4. `promote.ts` (kilit, R1/R2, `merge-tree`/`commit-tree`, kart, durum).
  5. `takeover.ts` + `routes-active.ts` + openapi + `GET /home` alanları.
  6. `vlad-server kb-promote` + birimler.
  - 1 ve 2 paralel; 3, 1'den bağımsız; 4, 1-3'ü; 5, 4'ü tüketir.
- **T13** (tester, S13a'ya bağlı; S13b/S13c ile paralel yazılır, kapıda birleşir): kabul testleri (aşağıda).

#### Test stratejisi

Seviye: S13b birim/entegrasyon testleri gerçek git ile, geçici bare remote (`file://`) kullanarak (`test/kb/commit.test.ts` kalıbı). S13c'de `rules` birim (saf), `promote` entegrasyon (gerçek git, sahte token, `remoteUrl` ile yerel bare; `protocol.file.allow` yalnız test bağımlılığıyla açılır, env'den değil). T13 kabul (iki klon = iki makine, `VLAD_MACHINE`).

**S13b** (`test/records/s13b.test.ts`)
- `records: commitKb --push without kbPushBranch rejected on server machine` (plandan; mod `process` → `kb_push_branch_required`, yerel commit kalır, remote değişmez)
- `records: push goes to HEAD:refs/heads/kb-server` (plandan; ayrı repo; remote `main` değişmez)
- `records: kbPushBranch equal to main or invalid name rejected` (`kb_push_branch_invalid`)
- `records: server machine requires separate kb layout` (`kb_separate_required`)
- `records: non-kb files in unpushed commits still block push (legacy layout)` (plandan, legacy'ye uyarlandı)
- `records: windows and cloud modes without kbPushBranch push upstream main unchanged`
- `records: push rejected non-fast-forward -> fetch, merge (two parents, no rebase), push once`
- `records: second non-fast-forward -> kb_push_rejected, local commits kept`
- `records: active.md-only conflict resolved main wins`
- `records: other conflict -> kb_conflict with paths, merge aborted, worktree clean`
- `records: kb pull commits pending changes then merges origin/main`
- `records: kb sync runs on non-active server and pushes running worker writes`
- `records: kb sync heartbeats only when this machine is active`
- `records: kb sync conflict opens one kb_conflict card per key, not reopened after resolve or dismiss`
- `records: kb sync clean cycle resolves its open kb_conflict cards`
- `records: kb sync status file carries handled request seq`
- `records: card new kb_conflict rejects --option and requires conflict fields`
- `records: kb resolve --take main backs up local side under logs/kb-conflicts`
- `records: discard answer rebuilds kb-server on origin/main with force-with-lease`
- `records: git-running kb commands refuse foreign .git owner (git_owner_mismatch)` (win32'de skip)
- `records: kbMainBranch from origin/HEAD, fallback main`
- `records: future heartbeat beyond 5 min adds clock_skew warning`

**S13c** (`server/test/unit/kbsync/rules.test.ts`, `server/test/integration/kbsync-promote.test.ts`, `kbsync-takeover.test.ts`)
- `server: promote only allowlisted kb root paths` (plandaki "only kb/ and vault/docs paths" testinin uyarlaması; izin listesi tablosu)
- `server: promote rejects ../, symlink, rename (--no-renames), mode change, submodule` (plandan; tablo: her kural ayrı satır)
- `server: promote rejects dot entries (.gitignore, .gitattributes, .gitmodules, .github/)`
- `server: promote rejects inbox/, logs/, vlad-session.txt, README.md`
- `server: promote rejects windows reserved names, trailing dot or space, case collisions`
- `server: promote rejects deletion except active.md`
- `server: promote rejects blob over 1 MiB, over 2000 changes, over 500 commits`
- `server: promote history check rejects symlink added then removed within range`
- `server: promote checks merge-commit content not taken from main side`
- `server: promote writes --no-ff commit with parents [main, kb-server] and vlad-gate author`
- `server: promote pushes exactly the validated commit, non-force`
- `server: main moved -> main_moved, no write`
- `server: up to date -> no write`
- `server: diverged -> kb_conflict card, not reopened` (plandan; anahtar sabit kalır: açık, kapalı, reddedilmiş, kart dosyası silinmiş)
- `server: new violation set -> new card`
- `server: merge-tree conflict -> reason merge_conflict, no card from promote`
- `server: promote success resolves open promote cards`
- `server: promote never runs git in the agent kb clone`
- `server: promote git env hardened and token absent from argv`
- `server: pushKbMain fixed to VLAD_KB_REPO and refs/heads/main`
- `server: startup refuses VLAD_KB_REPO equal to a project repo`
- `server: github write methods only via GithubWriter` (S9b testi, `pushKbMain` dahil güncellenir)
- `server: kb token scoped to kb repo with contents:write only`
- `server: concurrent promote (timer + takeover) -> one runs, other busy`
- `server: takeover triggers promote, failure shows pending card` (plandan; `202 pending` + `active_vlad.takeover.state=pending`)
- `server: takeover order sync -> claim --takeover -> sync -> promote -> active`
- `server: takeover pre-sync conflict -> 409 kb_conflict, claim not run`
- `server: takeover kbsync silent 20 s -> 503 kb_sync_unavailable, claim not run`
- `server: concurrent takeover -> 409 takeover_in_progress`
- `server: pending takeover becomes active after a later promote`
- `server: pending takeover lost when main active.md names another machine`
- (K5 tablosunun son satırı kabul edilirse) `server: promote rejects server-side change to project gate, repo, default_branch, path, other machines' paths; allows own paths entry`

**T13** (`test/acceptance/mobile-t13-*.test.ts`, `server/test/acceptance/kb-topology-*.test.ts`)
- `acceptance: kb topology concurrent claim windows and server -> first on main wins, loser active_elsewhere` (plan: eşzamanlı claim)
- `acceptance: kb topology concurrent claim -> windows push rejected, merged, no lost writes on main` (plan: push reddi, kayıp yazma yok)
- `acceptance: kb topology same-machine concurrent claim one wins` (S4b regresyonu)
- `acceptance: kb topology clock skew writer ahead fresh, writer behind at threshold ±1 s` (plan: saat kayması)
- `acceptance: kb topology future heartbeat warns clock_skew`
- `acceptance: kb topology after takeover windows pulls -> writes active_elsewhere, reads ok, own worker log allowed` (plan: takeover sonrası salt okunur)
- `acceptance: kb topology server read-only after windows retakes -> API write 409, worker writes still reach main`
- `acceptance: kb topology windows writes before its pull reach main after takeover`
- `acceptance: kb topology promote allowlist matrix leaves main unchanged for every rule`
- `acceptance: kb topology non-kb file in kb-server never reaches main` (plan S13c kabulünün uyarlaması)

#### Riskler

| Risk | Olasılık / etki | Azaltma |
|---|---|---|
| `vlad-kb` private ve ruleset yok: ajan PAT'ı `main`'e doğrudan yazabilir, kapı tavsiye niteliğinde kalır | Yüksek / yüksek | Açık nokta 1 (plan, C seçeneği ya da kabul); `doctor` `kb_main_protected` kontrolü fail/skip raporlar |
| Aynı görev dosyasına iki taraf yazar (frontmatter `updated:`) ve sık çakışma çıkar | Orta / orta | Tek etkin yazar kuralı; çalışan yalnız kendi görevine yazar; kart + `take_main`. Sonraki iş: görev dosyası için semantik merge sürücüsü (kapsam dışı) |
| Merge commit gürültüsü (en çok ~2/dk) | Yüksek / düşük | Merge yalnız iki tarafta yeni commit varsa; ff serbest (sunucu tarafı) |
| `vladapi` saldırgan nesnelerini fetch eder (git CVE yüzeyi) | Düşük / yüksek | Bare klon, `fsckObjects`, checkout yok, git güncel tutulur (S14a `apt` adımı) |
| Promote uzun süre engelli kalır, Windows sunucu yazmalarını görmez | Orta / orta | `kb_sync.state:"blocked"` kalıcı gösterge; kart |
| Windows `kb pull`'u atlar ve takeover'ı geç görür | Orta / orta | Skill'ler ve açılış `kb pull`; push zaten merge eder, kayıp yok |
| Bulut VLAD üçüncü doğrudan yazar; makine adı oturum başına değişirse etkin kayıtla çakışır | Orta / orta | Açık nokta 10 (`VLAD_MACHINE=cloud` önerisi) |

#### Eleştiriler ve nasıl ele alındı

Bu fazda developer/tester eleştiri turu yapılmadı (tek architect fazı). S13b/S13c/T13 bu nota itiraz ederse `vlad task ask` ile "Test itirazı / Tasarım itirazı" sorar; karar `/status`'ta verilir.

#### Açık noktalar

Kullanıcı kararı gerekenler. Her birinde bir öneri var:

1. **`vlad-kb` ana dalı korunabilir mi?** Private repoda ruleset için GitHub planının bunu desteklemesi gerekir. Varsayım: Free planda private repo ruleset'i yok. GitHub dokümanı: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets. Hesabın planı doğrulanmadı. Ruleset yoksa hangisini seçersin?
   - (a) Kapıyı kod düzeyinde bırakıp riski kabul etmek;
   - (b) planı yükseltmek;
   - (c) ayrı "gelen kutusu" reposu (`vlad-kb-server`), ajan `vlad-kb`'ye yalnız okur.
   - Öneri: mümkünse (b), değilse (a) bilerek. `doctor` uyarısı açık kalır.
2. **Ajan PAT'ına `vlad-kb` contents:write verilsin mi?** `kb-server` push'u için gerekli; 2026-10-25 kararı PAT'ı "yalnız `vlad/*` push + PR" ile sınırlıyordu. Öneri: evet, yalnız `vlad-kb` ve proje repoları.
3. **`vlad-gate` App `vlad-kb`'ye kurulsun mu (contents:write)?** Promote'un tek yazma kimliği. Öneri: evet.
4. **`vault/docs` `vlad-kb` kökündeki `docs/` altına mı taşınsın, hangi dilimde yapılsın?** Öneri: evet; küçük ayrı dilim (S5x, developer). `vlad` `.gitignore`'una `vault/` eklensin.
5. **Promote, sunucu kaynaklı proje kartı yürütme alanı değişikliklerini reddetsin mi?** Kapsanan alanlar: `gate`, `repo`, `default_branch`, `path`, `local_only` ve başka makinenin `paths` girdisi. Öneri: evet, kart reddedilir ve Windows'tan elle uygulanır.
6. **Sapma kabul mü?** Plan "her sunucu yazmasından önce pull" diyordu; bu not pull'u 60 sn'lik `kb sync` döngüsüne, takeover'a ve `kb pull`'a taşıyor. Öneri: kabul.
7. **Windows'ta da her oturum açılışında ve kb yazan akışın başında `vlad kb pull` çalışsın mı?** Bugün yerelde atlanıyor. Öneri: evet.
8. **`kb_conflict` seçenekleri yeterli mi?** Önerilenler: `take_main`/`manual` ve `discard`/`manual`. Telefondan "sunucu sürümünü al" (`take_local`) seçeneği de istenir mi? Öneri: hayır; o seçenek yalnız SSH'de `vlad kb resolve --take local`.
9. **`docs/` altında yalnız `.md` mi kabul edilsin, blob sınırı 1 MiB uygun mu?** Görseller dışarıda kalır. Öneri: evet.
10. **Bulut VLAD etkin kayıt düzenine nasıl girsin?** Bu oturum `main`'e doğrudan yazıyor. Öneri: bulutta `VLAD_MACHINE=cloud` sabitlensin; Windows gibi doğrudan `main` yazarı olsun.
11. **`decisions.md` ve `journal/` için `.gitattributes` `merge=union` eklensin mi?** Çakışmayı azaltır, ama satır sırası bozulabilir. Öneri: şimdilik hayır; gerekirse Windows'tan eklenir (promote sunucunun `.gitattributes`'ını zaten reddeder).
12. **Karar günlüğü eksik:** "kb ayrı private repo `vlad-kb` (2026-10-25)" ve bu notun kararları (K1-K10) `vlad decision add` ile kaydedilmeli. VLAD yazar; kullanıcı onayı gerekir.
13. **Yorum:** plandaki "takeover bekliyor kartı", S13d'nin etkin VLAD UI kartındaki `pending` durumu olarak yorumlandı, ayrı bir kb kartı değil. Doğru mu?

Varsayımlar: sunucuda git ≥2.38 (`merge-tree --write-tree`; Ubuntu 24.04 git 2.43, bu ortamda 2.43.0 doğrulandı, sunucuda doğrulanmadı); `timedatectl` NTP alanı; Free plan ruleset kısıtı; `vladapi`'nin kb klonunu grup okuma ile okuyabildiği (plan satır 85).

Kapsam dışı: görev dosyası semantik merge sürücüsü; `vlad status --summary`'de salt okunur göstergesi; GitHub `refs/pull/*` geçmiş temizliği.

#### Kısa özet

- **Topoloji:** Sunucu `iamhankaya/vlad-kb`'nin `kb-server` dalına push eder. `vladapi` `promoteKb` ile bunu kendi bare klonunda iki denetimden geçirir (net fark ve geçmiş) ve `main`'e `--no-ff`, zorlamasız tek yazma çıkışıyla (`GithubWriter.pushKbMain`) alır. Windows ve bulut `main`'e doğrudan yazar, `main`'i `vlad kb pull` ile çeker. Merge stratejisi seçildi, rebase değil.
- **Çift VLAD:** Doğrusallaştırma noktası `main`; `active.md` çakışmasında `main` kazanır, kayıp yazma yok. Takeover sırası: senkron → claim → senkron → promote → doğrulama; sonuç `active`, `pending` ya da `lost`.
- **`kb_conflict`:** İçerik anahtarlı, `vladapi` durumunda tekilleştirilir, sabit seçenekli, aynı fark için yeniden açılmaz.
- **`vault/docs`:** `vlad-kb/docs/` önerildi.
- **Güvenlik (en önemli üç nokta):**
  - `vladapi` ajan klonunda asla git çalıştırmaz;
  - `pushKbMain` yalnız kb reposuna sabittir;
  - promote kapısının zorlayıcı olması `vlad-kb main` ruleset'ine bağlı (Açık nokta 1).
- **Önemli bulgu:** Plandaki "`kbsync` = `vlad kb commit --push`" yolu, `kb commit` guard'ı `full` olduğu için etkin olmayan sunucuda çalışan yazmalarını reddederdi. Bunun için guard'ı `off` olan `vlad kb sync` önerildi.
- Kod değişikliği yok. Not ve test adları S13b, S13c ve T13 için hazır.

---

**Kullanıcı kararları (2026-10-25), açık noktalar için:**
- Ruleset yok. Promote kapısı kod düzeyinde zorlanır; risk bilerek kabul edildi.
- Ajan PAT'ı vlad-kb üzerinde contents:write alır. vlad-gate App vlad-kb'ye kurulur.
- Kalan 11 açık nokta mimarın önerisiyle kabul edildi.
