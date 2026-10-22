# VLAD yazılım departmanı (rol tabanlı pipeline) — tasarım

- **Tarih:** 2026-10-16
- **Durum:** Taslak. Kullanıcıyla konuşulan kararlar (karar günlüğü: "Yazılım departmanı: rol tabanlı pipeline, döngü boyutunu VLAD seçer") işlendi. T20261016-01 (ilk Tester denemesi) bitince §12 güncellenecek, sonra kullanıcı onayına sunulacak.
- **Önceki spec:** `2026-10-15-vlad-roles-design.md` (roller). Bu spec rolleri bir iş akışında sıraya koyar.

## 1. Amaç

Bir işi tek çalışana vermek yerine, işin boyutuna göre bir **yazılım departmanı** çalıştırmak: analist talimatı spec'e ve senaryolara çevirir, mimar uygulamayı planlar, developer uygular, tester bağımsız kabul testleri yazar ve sonucu doğrular; gerekirse finans/pazarlama danışılır.

**Başarı ölçütü:**
- `/delegate` işin boyutuna göre bir döngü seçer (emin değilse sorar) ve taslakta fazları, rolleri ve onay kapılarını gösterir.
- Fazlar `kb/` görev dosyaları olarak oluşur; her faz bir sonrakinin girdisi olan bir dosya üretir.
- Bağımlılığı biten faz otomatik başlatılmaya hazır görünür; kullanıcı kapıyı geçince VLAD başlatır.
- Paralel fazlar (tester ∥ developer) ayrı worktree'lerde çalışır ve çakışmaz.
- Tek görevlik bugünkü akış aynen çalışır.

## 2. İlkeler

1. **Ajan sohbeti hafıza değildir.** Fazlar birbiriyle konuşmaz; her faz görev dosyasına bir kapanış raporu (spec, plan, test matrisi…) yazar, sonraki faz yalnızca bağımlı olduğu görevlerin raporlarını okur.
2. **Kapılar kullanıcıda.** Bir fazın `awaiting_approval → done` geçişi kapıdır; bağımlı fazlar ancak bundan sonra başlar. Pipeline'ın sonunda ana branch'e merge ayrıca onaylanır.
3. **Döngü işin boyutuna göre.** Küçük işe tam departman çalıştırılmaz.
4. **Rol = ne ve sınır, skill = nasıl.** Yöntem rol dosyasına kopyalanmaz; rol mevcut skill'leri bağlar.

## 3. Döngüler (şablonlar)

| Döngü | Ne zaman | Fazlar (→ sıra, ∥ paralel) |
|---|---|---|
| `tam` | Sıfırdan proje/alt sistem; yeni arayüz/şema; gereksinim belirsiz | analyst:spec → architect:plan → (tester:kabul ∥ developer:uygulama) → tester:doğrulama |
| `özellik` | Mevcut projede net bir özellik; birkaç modül | analyst:spec → (tester:karakterizasyon+kabul ∥ developer:uygulama) → tester:doğrulama |
| `kısa` | Tek modülde değişiklik, net gereksinim, görünür davranış değişiyor | developer:uygulama → tester:doğrulama |
| `tek` | Küçük düzeltme, belge, bakım | tek görev (bugünkü akış, rol opsiyonel) |

**UI fazları (designer).** İş kullanıcıya görünen bir arayüz içeriyorsa döngüye designer fazları eklenir; arayüz yoksa eklenmez:
- `tam`: analyst:spec → **designer:tasarım** → architect:plan → (tester:kabul ∥ developer:uygulama) → (tester:doğrulama ∥ **designer:denetim**). Tasarım plandan önce gelir; architect bileşen yapısını tasarıma göre planlar.
- `özellik`: analyst:spec → **designer:tasarım** → (tester:karakterizasyon+kabul ∥ developer:uygulama) → (tester:doğrulama ∥ **designer:denetim**).
- `kısa`: developer:uygulama → (tester:doğrulama ∥ **designer:denetim**). Tasarım fazı yoktur.

Danışmanlar (finans, pazarlama) herhangi bir fazdan **yan görev** olarak açılabilir (research, `depends_on` yok, `parent` aynı); sonucu ilgili fazın Bağlam'ına eklenir.

**Seçim (VLAD):** işaretler — sıfırdan mı; dokunulan dosya/modül sayısı; arayüz/şema değişikliği; gereksinimin netliği; kullanıcıya görünür davranış. İşaretler aynı döngüyü gösteriyorsa VLAD seçer ve taslakta tek cümlelik gerekçe yazar. Çelişiyorsa veya gereksinim belirsizse iki döngüyü artı/eksiyle gösterip **kullanıcıya sorar**.

## 4. Test sahipliği

| | Developer | Tester |
|---|---|---|
| Ne | Unit testler (TDD) | Kabul testleri (spec senaryolarından integration/E2E), mevcut kod için karakterizasyon testleri, doğrulama fazında tarayıcı/E2E ve keşif testi |
| Girdi | Kendi tasarımı + plan | Yalnızca spec, plan ve arayüzler (uygulamanın içine bakmaz) |
| Ne zaman | Uygulama boyunca | Kabul: spec/plan onayından sonra developer'la paralel (kırmızı başlar, developer'ın hedefidir). Doğrulama: uygulama birleştikten sonra |
| Dosyalar | Kodun yanındaki unit test dosyaları | Projenin kabul/E2E/integration/karakterizasyon dizinleri (proje kuralına göre; yoksa `tests/acceptance`, `tests/e2e`, `tests/characterization`) |

Designer yalnızca `docs/design/` altına yazar (DESIGN.md, mockup'lar, token tablosu, denetim ekran görüntüleri). Stil/tema/token dosyaları dahil üretim kodu developer'ındır; token'ları koda developer taşır.

Dosya sahipliği rol dosyalarına yazılır; iki rol aynı dosyaya yazmaz.

## 5. Görev modeli

Görev şemasına eklenenler:
- `kind`: `pipeline` değeri eklenir (çatı görev; kod çalıştırmaz, worktree'si entegrasyon branch'idir).
- `parent: string | null` — çatı görevin ID'si.
- `depends_on: string[]` — aynı `parent` altındaki görev ID'leri.
- `phase: string | null` — insan okunur faz adı (`spec`, `tasarım`, `plan`, `kabul`, `uygulama`, `doğrulama`, `denetim`, `prova`, `danışma`).

Kurallar (CLI doğrular):
- `parent` var olan bir `pipeline` görevi olmalı; `depends_on`'daki her görev var olmalı ve aynı `parent`'a ait olmalı. Görevler sırayla oluşturulduğu ve yalnızca var olanlara bağlanılabildiği için döngü (cycle) oluşamaz.
- `pipeline` görevi `launch` edilmez; durumu VLAD tarafından yönetilir: `queued` → `running` (ilk faz başlayınca) → `awaiting_approval` (tüm fazlar `done`; ana branch'e merge kapısı) → `done`.

## 6. Branch ve worktree

- Çatı görev için **entegrasyon branch'i** `vlad/<parent-id>`, ilk faz başlatılırken ana branch'in HEAD'inden açılır; worktree'si `<worktreeDir>/<parent-id>`.
- Çocuk dev görevleri worktree'lerini `vlad/<parent-id>`'den açar (`addWorktree(repo, dir, branch, base)`), branch'leri `vlad/<child-id>`.
- Kapı (`/status` "Merge et") pipeline çocuğu için hedefi ana branch değil entegrasyon branch'idir: `git -C <parent-worktree> merge --no-ff vlad/<child-id>`.
- Paralel tester ∥ developer ayrı branch'lerde çalışır; dosya sahipliği (§4) çakışmayı önler. İkisi de entegrasyon branch'ine alındıktan sonra doğrulama fazı oradan açılır ve ikisinin birleşimini görür.
- Tester'ın kırmızı kabul testleri yalnızca entegrasyon branch'ini etkiler; ana branch'e merge, doğrulama fazı yeşil bitmeden önerilmez.
- Son kapı: kullanıcı onayıyla `vlad/<parent-id>` ana branch'e merge (veya push + PR); sonra çatı görev `done`, tüm worktree'ler `cleanup`.

## 7. Faz çıktıları

Her faz kapanış raporuna kendi rolünün `## Çıktı` başlıklarını yazar. Sonraki faz `depends_on` görevlerinin `## Kapanış raporu`'nu okur.

| Faz | Rol | Tür | Çıktı |
|---|---|---|---|
| spec | analyst | research | Amaç, kapsam, senaryolar (her biri Verilen/Olduğunda/O zaman), sistem etkisi, fazlar, kabul kriterleri, açık sorular |
| tasarım | designer | dev | `docs/design/` (DESIGN.md, mockup'lar) + rapor: ekranlar/durumlar, bileşen envanteri, token tablosu, erişilebilirlik kararları |
| plan | architect | research | Bileşenler, sistem tasarımı (`exposure`'a göre ölçekli), arayüzler, dosya yapısı, görev listesi (developer için), test stratejisi (tester için), riskler |
| kabul / karakterizasyon | tester | dev | Testler (branch'te) + test matrisi (senaryo → test → beklenen) |
| uygulama | developer | dev | Kod + unit testler; kabul testlerini yeşile çevirme hedefi |
| doğrulama | tester | dev | Tüm suite sonucu, tarayıcı/E2E bulguları, kanıtlı hata listesi |
| prova | devops | dev | `### Prova matrisi` (senaryo \| ortam \| sonuç), `### Bulunan hatalar`, `### Prova edilemeyenler`; dağıtım/CI/altyapı dosyaları düzeltilebilir, gerçek sunucuya dağıtım yok |
| denetim | designer | dev | Tasarıma uyum, erişilebilirlik, responsive bulguları (önem + kanıt), developer için önerilen düzeltmeler; kod değişmez |

**Sistem tasarımı (2026-10-20).** `tam` döngüsünde sistem tasarımı architect'in plan çıktısındaki `### Sistem tasarımı` bölümüdür; `özellik` döngüsünde architect fazı olmadığından analyst'in spec'indeki kısa `### Sistem etkisi` onun yerini tutar. Derinliği proje kartının `exposure` alanı (`local | network | internet`) belirler; alan boşsa rol tahmin etmez, "açık nokta / exposure belirsiz" yazar ve VLAD kullanıcıya sorar. `exposure`, `local_only`'den farklıdır: `local_only` bulutta derlenip çalışabilirliği, `exposure` sisteme kimin eriştiğini anlatır. Ayrıntı: roller spec'i §4. Bağlar: `/delegate` `exposure`'ı döngü seçiminde işaret olarak kullanır (`internet`/`network` + auth, veri, altyapı, dışa açık yüzey veya ölçeği etkileyen iş → en az `özellik`; daha küçük döngüde gerekçe taslakta yazılır) ve taslakta gösterir; tester kabul fazında hata senaryolarını test adayı olarak okur; developer kapanış raporunda sistem tasarımına uyumu bildirir.

`tasarım` fazı dev türündedir (dosyaları branch'e yazar, entegrasyon branch'ine merge edilir); research olan `plan` fazı tasarımı kapanış raporundan ve entegrasyon branch'indeki `docs/design/`'dan okur. `denetim`'de kritik/yüksek bulgu varsa kapı kuralı doğrulamadaki kırmızı test kuralıyla aynıdır: yeni `uygulama` fazı ve ona bağlı yeni `doğrulama` + `denetim` fazları.

**Plan fazında birlikte çalışma:** "Birlikte oturma" sırayla yaz–eleştir olarak yürür, tek bir research görevi içinde: VLAD architect agent'ına taslak yazdırır → developer ve tester rol dosyalarıyla iki eleştiri agent'ı çalıştırır → architect eleştirileri işleyip son planı yazar. Ara ürünler `vlad task log` ile kaydedilir; rapora yalnızca son plan + "eleştiriler ve nasıl ele alındı" bölümü girer.

## 8. Roller ve skill'ler

- Yeni rol: `roles/architect.md` (`kind: advisory`) — mimari, arayüzler, plan; kod yazmaz.
- Rol şemasına opsiyonel `skills: string[]`. Launcher prompt'u ve research agent prompt'u: "İşe başlamadan şu skill'leri yükle: …".
- Başlangıç bağlamaları: analyst → `superpowers:brainstorming`, `superpowers:writing-plans`; architect → `superpowers:writing-plans`, `superpowers:brainstorming`; developer → `superpowers:test-driven-development`, `superpowers:requesting-code-review`, `superpowers:verification-before-completion` (büyük planda `superpowers:subagent-driven-development`); tester → `superpowers:test-driven-development`, `superpowers:systematic-debugging`, doğrulama fazında bir tarayıcı skill'i (Playwright); finans/pazarlama → `anthropic-skills:deep-research`; designer (`executor`, 2026-10-18) → `ui-ux-pro-max`, `impeccable` (denetimde yalnızca `audit`/`critique`), `design-taste-frontend` (taste-skill; yalnızca halka açık web sayfaları).
- Rol şemasına opsiyonel `model` (2026-10-18, T20261018-07): dev fazının çalışanı `claude --model <model>` ile, research/plan fazlarının arka plan agent'ları Agent aracının `model` parametresiyle başlar; boşsa varsayılan. Tüm roller `model: sonnet` taşır (kullanım limiti); VLAD session'ı Opus'ta kalır. Ayrıntı: roller spec'i §4–5.
- Skill adları kullanıcının kurulu skill listesine göre doğrulanmaz (Claude Code'un listesi CLI'dan görünmez); bulunamayan skill'i çalışan raporda "yüklenemedi" diye belirtir.
- Rol dosyalarındaki dosya sahipliği §4'e göre güncellenir.

## 9. CLI

- `vlad task new … --parent <id> --depends-on <id,id> --phase <ad>` ve `--kind pipeline`.
- `vlad task ready [--parent <id>] --json` → `queued` olup tüm `depends_on`'ları `done` olan görevler (çatı görevler hariç).
- `vlad task list --parent <id>`.
- `launch`: `parent` doluysa entegrasyon branch'ini/worktree'sini gerekirse açar ve çocuğu ondan açar; çatı görevi `queued` ise `running` yapar.
- `status --json`: aktif listede çatı görev de görünür; her görev `parent/depends_on/phase` taşır.
- `cleanup` çatı görev için entegrasyon worktree'sini de kaldırır (branch kalır).

## 10. Akışlar

**/delegate:** döngü seç (§3) → taslakta döngü + gerekçe, faz tablosu (faz, rol, tür, bağımlılık), kapılar → onay → çatı görev + faz görevleri sırayla `task new` → `task ready` → hazır olanları başlat (dev: `launch`, research: arka plan agent'ı).
**/status:** pipeline'ları ağaç olarak göster (çatı → fazlar, durum, bekleyen kapı). Kapı geçince (`done` + entegrasyon merge'ü) `vlad task ready --parent <id>` → yeni hazır fazları kullanıcıya söyleyip başlat. Kullanıcı ilk taslakta pipeline'ı onayladığı için fazların başlatılması ayrıca sorulmaz; merge kapıları sorulur.
**/digest:** pipeline'lar tek günlük maddesi altında fazlarıyla özetlenir.

## 11. Hata durumları

| Durum | Davranış |
|---|---|
| Bir faz `failed`/`cancelled` | Bağımlı fazlar `queued` kalır; /status kullanıcıya: fazı yeniden oluştur, pipeline'ı iptal et veya bağımlılığı kaldırarak devam et |
| Bağımlılık başka bir pipeline'da | CLI hata |
| Entegrasyon merge çakışması | Merge yapılmaz, hata gösterilir; developer'a "rebase/çöz" değişiklik isteği önerilir |
| Paralel fazlar aynı dosyaya yazdı | Entegrasyon merge'ünde çakışma (yukarıdaki satır); rol dosyalarındaki sahiplik ihlali raporda belirtilir |
| Kullanıcı döngüyü ortada küçültmek/büyütmek ister | Çatı altına faz eklenir/iptal edilir; mevcut fazlar korunur |

## 12. Tester denemesinden öğrenilenler (T20261016-01, 2026-10-16)

- **Rol dosyası yeterli oldu.** Rol özel skill gerekmedi: Tester önce kırmızı testle kanıtladı (`373dee3`), sonra düzeltti; üretim koduna ve canlı ortama dokunmadı; projenin mevcut test kalıbını (`node --test`) seçti, yeni çerçeve eklemedi. §8'deki "önce mevcut skill'ler" kararı geçerli.
- **Çıktı başlıkları tutuldu.** Rapor rolün tüm başlıklarını (Kapsam tablosu, Bulunan hatalar, Kırmızı bırakılan testler, Önerilen düzeltmeler, Açık noktalar) ve vlad-worker'ın zorunlu başlıklarını taşıdı; /status bunlardan "kırmızı test yok → merge güvenli" kararını doğrudan okuyabildi. Faz çıktısının girdi olarak kullanılması (§7) için bu yapı yeterli.
- **`cleanup` pencereyi otomatik kapattı:** öncesinde 1 çalışan süreci, sonrasında 0; worktree hatasız silindi.
- **Süre:** görev oluşturmadan rapora ~6 dakika (19:18 → 19:24). Küçük bir test görevi için tek faz bu sürede bitiyor; `kısa` döngü (developer → tester) birkaç küçük iş için makul, `tam` döngü yalnızca §3'teki işaretlerde.
- **Açık nokta (pipeline'a girdi):** Tester'ın "CI'a ekle" gibi kapsam dışı önerileri raporda kalıyor. Pipeline'da bunlar çatı görevin açık noktalarına toplanmalı ve son kapıda kullanıcıya gösterilmeli (§10 /status).

## 14. Proje kapısı (`gate`) ve test hijyeni (T20261022-56)

Retro bulgusu: kapıdaki yanlış kırmızılar ortamdan geldi (bayat vitest önbelleği, eski şablon DB, yük altında kararsız testler, FakeClock zaman bombası).

- **Kart alanı:** opsiyonel `gate` (string, boş olamaz) — projenin tek kapı komutu. `vlad project set <slug> gate "<komut>"` (boş değer siler); `vlad project list --json` çıktısında `gate` görünür.
- **`/status`:** entegrasyon doğrulaması (faz merge'ü, son kapı) kartta `gate` varsa onunla yapılır. Yoksa VLAD ad hoc koşuyu yapar ve "gate tanımlı değil" uyarısı + kart için öneri gösterir.
- **`vlad-worker`:** rapordan önce kartta `gate` varsa çalıştırılır, sonucu `### Test sonuçları`'na yazılır.
- **`/scan`:** kart oluştururken `gate` sorar; repoda `scripts/gate.sh` ya da `gate` npm script'i varsa önerir.
- **Test hijyeni (`roles/tester.md`, `roles/developer.md`):** süre eşiğine bağlı iddia yok (zorunluysa geniş pay + gerekçe); FakeClock/tarihler "şimdi"ye göre göreli; koşudan önce test önbelleği ve şablon DB temizliği (gate yapmıyorsa); kararsız test "flake" diye geçilmez, kök neden ya da açık nokta.

## 15. Bulgu kaydı ve retro (T20261022-57)

Retro bulgusu: ertelenen bulgular kayboluyordu (manga B-*/T-*, DiskPilot 17 bulgu) ve dersler kalıcı değildi.

- **Bulgu kaydı:** `kb/findings/<id>.md` (`F-<proje>-NNN`), `vlad finding add|list|set`; şema ve alanlar core spec §5.6. Çalışanlar `### Açık noktalar` maddelerini `- [önem] başlık — ayrıntı` biçiminde yazar; `/digest` bunları `finding add` ile kaydeder, kartın `## Açık konular` bölümüne açık bulguların özetini yansıtır. Son kapıda `/status` açık bulguları açık noktalar listesine ekler. `vlad status --summary` açık kritik/yüksek bulgu sayısını gösterir.
- **Retro:** son kapıdan sonra (çatı `done`) `/status` kısa retro yapar: ne iyi gitti, ne sürtündü, ders. Proje dersleri `vlad project note` ile kartın `## Çalışma notları` bölümüne yazılır; rol düzeyindeki dersler `roles/` değişikliği önerisi olarak kullanıcıya sunulur (VLAD rol dosyasını kendisi düzenlemez).
- **Okuma:** `vlad-worker` ve tüm rollerin `## Kaynaklar` bölümü kartın `## Çalışma notları`'nı işe başlamadan okumayı söyler; bulut çalışanda kb okunamadığı için notlar prompt'a `## Proje çalışma notları` olarak satır içi girer (`src/tasks/cloud.ts`).

## 16. Sınırlı paralellik ve kaldığı yerden devam (T20261022-58)

Retro bulgusu: oturum limiti kesintileri (T20261018-04: bir ajan yanlış worktree'de devam etti; T20261020-84 03:10–05:20; T20261016-03 429).

- **`maxParallel`** (`vlad.config.json`, opsiyonel pozitif tamsayı; yoksa sınırsız = önceki davranış). `vlad task ready [--parent <id>] --json` → `{ tasks, held_by_limit, running, maxParallel }`: `running` = şu an `running` olan dev görevleri (tüm projeler; research/pipeline sayılmaz); boş yuva = `maxParallel − running`. Hazır fazlar ID sırasıyla `tasks`'a (yuva kadar), kalanı `held_by_limit`'e girer. `tasks`'ın anlamı değişmedi: başlatılacaklar. `/delegate` ve `/status` yalnızca `tasks`'ı başlatır.
- **`vlad task resume <id> [--json]`** (yalnızca `running`/`stalled`; diğer durum, bilinmeyen görev → standart hata). Kayıtlı `worktree` varsa yerel: klasör yoksa hata, branch `vlad/<id>` değilse hata, kaydedilmemiş değişiklik hata değil `dirty` listesidir. Çıktı `{mode:"local", worktree, branch, dirty, log_tail, prompt}`; prompt worktree yolunu açıkça verir, "ana dizinde çalışma" uyarısı ve son 5 `task log` satırını içerir. `worktree` yok, `session_id` varsa bulut: `{mode:"cloud", action:"send_message", session_id, message, args}`; ikisi de yoksa hata. Komut durum değiştirmez; `stalled` → `running` geçişini `/status` yapar.
- **`vlad-worker`:** her anlamlı adımda WIP commit + `task log` "kaldığım yer"; devam mesajında önce `git status`/branch doğrulaması.

## 17. Dağıtım provası ve `devops` rolü (T20261022-59)

Retro bulgusu: dağıtım hataları canlıda çıktı (T20261021-86/-87/-88, T20261022-51) ve bulutta `check-deploy` koşmadı (T20261022-53).

- **`prova` fazı:** iş dağıtım betiğine, CI'a veya altyapıya dokunuyorsa `/delegate` `prova` fazını (devops, dev, bağımlılık: `uygulama`) önerir; `doğrulama` ile paralel çalışır ya da canlıya alma kapısından önce koşar.
- **Senaryolar:** kısıtlayıcı umask (077); `bash -s < script` (stdin tüketimi); `pipefail` tuzakları (`grep -q` + SIGPIPE); boş volume ile ilk kurulum; yedek alma + geri yükleme; idempotent ikinci koşu; yetkisiz kullanıcı.
- **Çıktı:** `### Prova matrisi` (senaryo | ortam | sonuç), `### Bulunan hatalar`, `### Prova edilemeyenler` (ör. bulutta Docker yok) + standart bölümler.
- **Kapı:** `/status` son kapıda `prova` fazı varsa gösterir; kırmızıysa canlıya alma önerilmez. Devops dışa etkili eylem yapmaz (gerçek sunucuya dağıtım yok).

## 13. Kapsam dışı

Fazlar arası otomatik merge (kapılar her zaman kullanıcıda), birden çok repoya yayılan pipeline, ajanların birbirine doğrudan mesaj atması, maliyet bütçesi/limitler.
