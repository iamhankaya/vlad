---
name: status
description: Aktif görevlerin durumunu gösterir; onay bekleyen görevler için kapanış raporu ve diff özetini sunup push/PR/merge/değişiklik kararını alır, takılan ve soru soran görevleri yönetir. Kullanıcı "durum ne", "görevler ne alemde", "onay bekleyen var mı" dediğinde veya açılış özeti onay/takılma gösterdiğinde kullan.
---

# /status — görev takibi ve onay

**Onay kapısı:** `git push`, `gh pr create` ve merge yalnızca kullanıcının o görev ve o eylem için verdiği **açık onaydan** sonra yapılır. Seçenekleri sun, cevabı bekle; varsayılan eylem yoktur.

## 0. Bulutta kb senkronu (`CLAUDE_CODE_REMOTE=true`)

kb ayrı private repoda (`iamhankaya/vlad-kb`; konum: `VLAD_KB_DIR` ya da `vlad.config.json`'daki `kbDir`). Bulutta bu akış kb'ye yazmadan **önce** (ilk yazma komutundan önce, bir kez) kb reposunu eşitle:
```
git -C <kbDir> pull --ff-only
```
Çakışma/ff yapılamazsa **dur**, yazma; kullanıcıya durumu bildir ve nasıl ilerleyeceğini sor. kbDir bulutta yoksa (`vlad` komutları "kb deposu bulunamadı" der) kullanıcıya `add_repo iamhankaya/vlad-kb` + `git clone https://github.com/iamhankaya/vlad-kb <kbDir>` gerektiğini söyle ve dur. Yerelde (`CLAUDE_CODE_REMOTE` yok) bu adım atlanır.

## 1. Durumu oku

```
vlad status --json
```
Çıktı: `counts` (duruma göre sayılar), `active` (aktif görevler), `newlyStalled` (bu çağrıda `stalled` yapılanlar), `failed` (hatalı görevler: `failed` durumundakiler ve `error` alanı dolu `queued` olanlar), `inbox` (işlenmemiş rapor sayısı).

Kullanıcıya önce kısa bir tablo göster: ID, proje, başlık, rol (`role` doluysa `vlad role list --json`'daki `title`, boşsa "—"), durum, son güncelleme. `newlyStalled` varsa ayrıca belirt. `inbox > 0` ise sonda `/digest` öner.

**Pipeline'lar ağaç olarak:** `kind: pipeline` görevleri (çatı) ve `parent`'ı dolu görevler (fazlar) tabloya düz girmez. Her çatı için `vlad task list --parent <çatı-id> --json` ile tüm fazları al (biten fazlar `active`'te yoktur) ve göster:
```
T20261016-03  watchparty  Oda sohbeti  [pipeline: running]
├─ T20261016-04  spec       Senior Analyst    done
├─ T20261016-05  kabul      Senior Tester     awaiting_approval  ← kapı  (bağımlı: -04)
├─ T20261016-06  uygulama   Senior Developer  running            (bağımlı: -04)
└─ T20261016-07  doğrulama  Senior Tester     queued             (bağımlı: -05, -06)
```
Satırlar: faz (`phase`), rol başlığı, durum, bağımlılık (`depends_on`); bekleyen kapıyı işaretle.

### 1b. Bulut görevleri (`CLAUDE_CODE_REMOTE=true`)

**Yabancı commit kontrolü:** bulut çalışanı kb'yi salt okuma klonlar ama platform push'unu engellemez (protokol: push yasak). Aktif bulut görevi varsa `/status` başında `vlad kb check --json --strict` çalıştır (`checked`, `foreign: [{sha,author,subject}]`, `suspicious: [{sha,author,subject,files}]`; `--strict` yabancı/şüpheli commit ya da yapılamayan kontrolde 1 ile çıkar, çıktıyı yine okursun). `checked: false` ise ("KONTROL YAPILAMADI": ağ yok, upstream yok) bunu kullanıcıya göster ve aktif bulut görevinin merge kapısını beklet: kontrol yapılamadan "yabancı commit yok" denemez. `foreign` ve `suspicious` boşsa sessiz geç. `suspicious` = önekten bağımsız kök `CLAUDE.md`, `.claude/`, `.github/` dosyalarına dokunan commit (oturuma yüklenen/CI'da çalışan dosyalar): `foreign` gibi göster ve kullanıcı görmeden kabul etme. Doluysa commit'leri kullanıcıya göster ve seçenek sun: (a) o commit'i yazan bulut görevini durdur (`vlad task set <id> failed` + `vlad task log`; hangi görev olduğu commit zamanı/içeriğinden çıkar, emin değilsen sor), (b) incele ve kabul et. Kullanıcı gördükten sonra `vlad kb check --ack <head>` ile işaretle (`head` = `check --json` çıktısındaki alan; arada gelen commit görülmeden işaretlenmez); yoksa aynı commit her seferinde yeniden listelenir. Yabancı commit'i kendin geri alma/force push yapma. Sınır: yalnız kb'nin upstream dalı ve `kb:` öneki bakılır (iyi niyetli koruma; başka dala push ya da sahte önek görünmez). İlk kurulumda geçmişte öneksiz eski commit listelenirse onaylayıp `--ack <head>` ile başlangıç noktası koy.

Bulutta çalışan bildirimi yoktur; her `/status` çağrısında `session_id`'si dolu, `running`/`blocked` bulut görevleri için durumu **sen** çek (`vlad status --json`'dan önce, tablo güncel olsun):
1. `get_session(session_id)`: `status_bucket` `failed` → `vlad task log` + `vlad task set <id> failed`; kullanıcıya bildir.
2. Önce `list_events(session_id, kinds=["result"], limit=3)` dene (küçük sayfa; `result` olayı tur sonu metnini ve `total_cost_usd`/`num_turns`/`duration_ms` ölçümünü taşır). Çıktıyı geçici dosyaya yaz ve `vlad task ingest <id> --file <events.json> --json` çalıştır; `processed` ve `skipped` ikisi de boşsa (işaret bulunamadı) `list_events(session_id, kinds=["assistant", "result"], limit=100)` ile tekrar dene. Ingest log satırlarına olayın `created_at`'ini yazar ve tur ölçümünü `## İlerleme`'ye `[ölçüm …]` satırı olarak ekler. Olay çekme + dosyaya yazma işi bir `haiku` arka plan agent'ına verilebilir: agent yalnızca `list_events` ham çıktısını dosyaya yazar ve yolunu döndürür; `vlad task ingest` VLAD'da kalır. Birden çok sayfa gerekirse (`has_more: true`) sayfaların ham çıktılarını art arda aynı dosyaya yaz; CLI ardışık `{ccr:{data,has_more}}` sayfalarını birleştirir. `result` olayı, assistant olayı yoksa işaret kaynağıdır (ikisi birlikte gelirse çift işleme olmaz). Çalışan bitişte tüm işaretlerini son tur mesajında tekrar eder; işleme idempotenttir. `warnings` boş değilse göster (ör. `head=` remote uçla eşleşmiyor → rapor onaya sunulmadı; GitHub'dan `vlad/<id>` ucunu doğrulayıp gerekirse `--remote-head <sha>` ile tekrar dene).
3. İşaretsiz biten session (`review_ready`/`completed` ama görev `awaiting_approval`/`failed` değil) → kullanıcıya sor.
4. `blocked` görev: cevabı `vlad task answer` ile yazdıktan sonra `send_message(session_id, "[VLAD:ANSWER #n] <cevap>")` ile çalışana ilet (`n` = görev dosyasındaki `[cloud #n]`).
5. **Hızlı yol — çalışan bildirimi:** çalışan REPORT/ASK/FAIL yazınca VLAD session'ına tek seferlik zamanlanmış görev kurar; mesaj "VLAD görev <id>: <durum> — ingest et" biçimindedir. Gelince görev için `get_session`/`list_events` → `vlad task ingest` çalıştır ve **o görevin bekleyen hatırlatmasını iptal et** (`delete_trigger`).
6a. **`[VLAD:LOG] kb erişimi yok`** (ingest log satırı): çalışan kb'yi klonlayamadı. Aynı görevi `cloudKb: "inline"` ile yeniden başlat: delegate 5a-cloud'daki yol (`failed` → `queued`, config'te `cloudKb: "inline"`, yeniden launch); kullanıcıya bildir.
6. **Yedek — hatırlatma:** karar günlüğündeki "Bulut çalışanları için tek seferlik hatırlatmalar" gereği her bulut çalışanını başlattıktan sonra `send_later` ile ~15 dk sonrasına tek seferlik hatırlatma kurulur; çalışan bitmemişse yeniden kurulur (çalışan başına en fazla 4 deneme). Bildirim kurulamazsa ya da kaybolursa görev bu hatırlatmayla yakalanır. Sürekli yoklama yoktur.

### 2-cloud. Bulutta merge kapıları (GitHub PR)

Bulut VLAD yalnızca kendi session branch'ine push edebilir; kapılar yerel `git merge` yerine **GitHub PR** ile geçer (karar 2026-10-20). Diff özeti: `git fetch origin vlad/<id>` sonra `git log --oneline origin/<hedef>..origin/vlad/<id>` ve `git diff --stat origin/<hedef>...origin/vlad/<id>` (veya GitHub MCP `pull_request_read`). Aşağıdaki 2. adımdaki seçenekler aynıdır; yalnızca eylem farklıdır:
1. **Merge et:** PR aç (`create_pull_request`, head `vlad/<id>`, base: pipeline fazında `vlad/<çatı-id>`, değilse repo'nun ana branch'i). PR açmak dış etkilidir: önce açık onay iste; PR linkini ve base'i göster; kullanıcı **açık onay** verince `merge_pull_request`. Sonra `vlad task set <id> done`. Merge hatasında görevi `done` yapma, hatayı göster.
2. **Değişiklik iste:** `send_message(session_id, …)` ile çalışana ilet; `vlad task log` düş.
3. **Olduğu gibi kabul et:** aynı kurallar.
Son kapı (`vlad/<çatı-id>` → ana branch) ayrı bir PR ve ayrı açık onaydır. Bulut görevinde `vlad task cleanup` worktree olmadığı için zararsızdır. Bulut VLAD'ın `kb:` commit'leri session branch'ine gider (`vlad kb commit --push`); `master`'a alınması ayrıca onaylı merge/PR'dır.

### Kapı doğrulaması (`gate`)

Entegrasyon doğrulaması (faz merge'ünden önce/sonra, son kapı) projenin proje kartındaki **`gate`** komutuyla yapılır (`vlad project list --json` → `gate`; ör. `scripts/gate.sh`, `npm run gate`). Komutu ilgili worktree'de çalıştır ve sonucu (çıkış kodu, kırmızıysa özet) kullanıcıya göster; kırmızı gate'te merge önerme.

Kartta `gate` **yoksa**: VLAD mevcut ad hoc koşuyu (projenin bilinen test/build komutları) yapar ve kullanıcıya şunu gösterir: "⚠ gate tanımlı değil — kart için öneri: tek kapı komutu tanımla (`vlad project set <slug> gate "<komut>"`); test önbelleği/şablon DB temizliği ve build'i içersin." Gate'i kullanıcı onayı olmadan kendin yazma.

## 2. `awaiting_approval` görevler

`kind: pipeline` (çatı) ise adım 3'teki **son kapıya** git. Diğerleri için `kb/tasks/<id>.md`'yi oku ve göster:
- `## Kapanış raporu` (ne yapıldı, testler, açık noktalar) — özetle.
- Commit'ler ve diff özeti (worktree frontmatter'daki `worktree`; ana branch `main` değilse repo'nun ana branch'ini kullan; pipeline fazında `main` yerine entegrasyon branch'i `vlad/<çatı-id>`):
  ```
  git -C <worktree> log --oneline main..HEAD
  git -C <worktree> diff --stat main...HEAD
  ```
  Diff ya da test çıktısı uzunsa özeti bir `sonnet` agent'ına yaptırabilirsin (isteğe bağlı; agent yalnız okur, sonucu VLAD kontrol eder).
**`role: tester` ise:** Tester hatayı kanıtlamak için kasıtlı başarısız testler commit'leyebilir. Raporun `### Kırmızı bırakılan testler` bölümünü seçeneklerden önce göster. Liste boş değilse merge ana branch'in test suite'ini kırmızıya çevirir; varsayılan öneri merge değil, `### Önerilen düzeltmeler`'den bir Developer görevi açmaktır (`/delegate`, `--role developer`, kabul kriteri: o testlerin yeşile dönmesi). Merge yine seçenek olarak kalır ama bu riski açıkça söyle.
Pipeline'da kural entegrasyon branch'ine uyarlanır: `kabul`/`karakterizasyon` fazının kırmızı testleri beklenendir (developer'ın hedefi), entegrasyon branch'ine merge varsayılan öneridir. `doğrulama` fazında kırmızı test varsa varsayılan öneri, aynı çatı altında yeni bir `uygulama` fazı (developer, kabul kriteri: o testlerin yeşile dönmesi) ve ona bağlı yeni bir `doğrulama` fazı açmaktır (`/delegate` adım 4). Ana branch'e merge, doğrulama fazı yeşil bitmeden önerilmez.
**Güvenlik incelemesi:** faz auth, yetki, oturum veya veri silmeye dokunuyorsa (rapor/diff'ten ya da fazın Tanım'ındaki işaretten anla) ya da VLAD güvenlik etkili bir kararı otonom vermişse, merge'den önce kısa bir güvenlik incelemesi yürüt: arka plan agent'ı (yalnızca okur; auth/yetki/oturum/silme yolları, girdi doğrulama, sır sızıntısı) veya `security-review` skill'i. Bulguları (önem + `dosya:satır`) kapıda göster. **Kademeli güvenlik kuralı:** kritik/yüksek bulgu varsa merge yok, değişiklik isteği (düzeltme fazı); orta/düşük/bilgi bulgular için değişiklik turu açılmaz: `vlad finding add` ile kaydedilir (deferred ya da open) ve son kapı listesine girer, faz merge edilebilir; faz başına en çok 1 güvenlik değişiklik turu, ikinci turda kalan yüksek bulgu kullanıcıya sorulur. İstisna (bulguya bağlı): orta bulgu yalnız şu iki koşul birlikte sağlanırsa tur açar: kartın `exposure`'ı `internet` ve bulgu dışarıdan doğrudan istismar edilebilir (kimlik doğrulamasız erişim, sır/anahtar sızıntısı, imza/onay atlatma, yetki yükseltme). VLAD'ın otonom verdiği güvenlik etkili kararı kullanıcıya açıkça söyle ve onay iste; sessizce geçme.

**Entegrasyon öncesi kontrol:** dev fazı raporunun `### Test sonuçları`'nda entegrasyon branch'i merge + lint + gate sonucu yoksa veya kırmızıysa (çakışma, kırmızı) merge önerme; çalışana düzeltme iste (seçenek 3). Raporda yeşilse kapıdaki doğrulamayı yine de yap.

**Ara denetim (`denetim` fazı pipeline ortasındaysa):** kritik/yüksek bulgular sonraki `uygulama` fazının girdisidir; kalan fazların Tanım'ına ekle (`/delegate` adım 4), orta/düşük bulguları son kapı listesine ekle.

**`role: devops` ise:** `### Prova matrisi`ni ve `### Prova edilemeyenler`'i göster; kırmızı senaryo varsa merge/canlıya alma önerme. Devops gerçek sunucuya dağıtım yapmaz; canlıya alma ayrıca onaylanır.

**`role: designer` ise:** `tasarım` fazında `docs/design/` dosyalarını ve `### Token'lar` tablosunu göster; entegrasyon branch'ine merge varsayılan öneridir. `denetim` fazı kod değiştirmez; `### Bulgular` tablosunu göster. Kritik veya yüksek önemde bulgu varsa varsayılan öneri, doğrulamadaki kırmızı test kuralıyla aynıdır: yeni bir `uygulama` fazı (kabul kriteri: o bulguların giderilmesi) ve ona bağlı yeni `doğrulama` + `denetim` fazları. Yalnızca orta/düşük bulgular varsa bunları son kapıdaki açık noktalar listesine ekle.

Sonra seçenekleri sun:
1. **Merge et** (yerelde): önce `git -C <proje-yolu> branch --show-current` çalıştır, çıkan branch'i kullanıcıya göster ve merge'ün hedefinin bu branch olduğunu **açıkça onaylat**. Onaydan sonra (`git -C <proje-yolu> status` temiz olmalı)
   `git -C <proje-yolu> merge --no-ff vlad/<id>`
   **Pipeline fazında** hedef ana branch değil entegrasyon branch'idir: hedef olarak `vlad/<çatı-id>`'yi ve çatı görevin `worktree`'sini göster, onaylat; sonra (`git -C <çatı worktree> status` temiz olmalı)
   `git -C <çatı worktree> merge --no-ff vlad/<id>`
   **Projeler arası fazda** (faz projesi ≠ çatı projesi) çatı görevin `worktree` alanı faz projesinin entegrasyon worktree'si değildir; o yalnızca çatının kendi projesindekidir. Entegrasyon worktree'sini çatı görevin `integration_worktrees` alanından al (`vlad task list --json`, çatı satırında; her öğe `{project, repo, branch, worktree}`, faz projesinin reposuna göre türetilir) ve faz projesinin satırını seç ve `git -C <o projenin worktree'si> merge --no-ff vlad/<id>` çalıştır; hedef olarak o worktree'yi göster. Faz branch'i de faz projesinin reposundadır.
   Çakışma olursa `git -C <çatı worktree> merge --abort`, hatayı göster, görevi `done` yapma; seçenek 3 ile developer'a "`vlad/<çatı-id>` üzerine rebase et, çakışmayı çöz" iste. Research fazında merge yoktur; kabul = seçenek 4.
2. **Push + PR aç:** onaydan sonra
   `git -C <worktree> push -u origin vlad/<id>` ve `gh pr create --head vlad/<id> --fill` (worktree'de). PR linkini göster. (Pipeline fazında sunulmaz; PR son kapıda açılır.)
3. **Değişiklik iste:** istenen değişikliği al →
   `vlad task log <id> "Değişiklik isteği: <özet>"` ve `vlad task set <id> running --json`.
   Çalışanın session'ı açıksa (`ListAgents`) ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder; kapalıysa kullanıcıya worktree'de devam komutunu öner: `session_id` doluysa `claude --resume <session_id>`, boşsa `claude --continue`. Research fazında agent'ı değişiklik isteğiyle yeniden çalıştır (`/delegate` 5b).
4. **Olduğu gibi kabul et** (dışa eylem yok). Pipeline **dev** fazında sunma: merge'süz `done`, bağımlı fazların bu değişikliği görmeden başlaması demektir (spec §2, §6). Kullanıcı yine de isterse bu sonucu açıkça söyle ve bağımlı fazları başlatmadan önce ayrıca onay al.
5. **İptal et:** `vlad task set <id> cancelled --json`, ardından `vlad task cleanup <id> --json`.

Seçenek 1, 2 veya 4 tamamlandıktan sonra:
```
vlad task set <id> done --json
vlad task cleanup <id> --json
```
`cleanup` önce çalışanın penceresini (claude dahil) kapatır, sonra worktree'yi kaldırır; branch'i silmez. Bu yüzden `cleanup`'ı yalnızca görev `done`/`cancelled` olduktan sonra çalıştır; "değişiklik iste" akışında çalışma. Merge/push hatası olursa görevi `done` yapma; hatayı göster.
`cleanup` "worktree klasörü silinemedi, çalışan penceresi hâlâ açık olabilir" hatası verirse kullanıcıdan çalışanın penceresini kapatmasını iste, sonra aynı `cleanup` komutunu tekrar çalıştır. Klasörü elle silme.
Kapanan görevin kapanış raporu `/digest` ile günlüğe işlenir; açılış özetindeki "işlenmemiş rapor" sayısına dahildir.
Görevin `parent`'ı doluysa ardından adım 3.

## 3. Pipeline'ı ilerlet

Bir faz `done` olduktan (veya iptal edildikten) sonra:
```
vlad task ready --parent <çatı-id> --json
```
`{"tasks":[...],"held_by_limit":[...],"running":N,"maxParallel":M|null}` — `tasks` `maxParallel` sınırına uyan başlatılabilir fazlardır; `held_by_limit` sınır yüzünden bekleyenlerdir (başlatma; bir çalışan bitince `task ready`'yi tekrar çalıştır, kullanıcıya "N faz maxParallel nedeniyle bekliyor" de). `tasks` içindeki her fazı **sormadan** başlat — kullanıcı pipeline'ı taslakta onayladı: dev → `vlad task launch <id> --json` (**PowerShell aracıyla**, `/delegate` 5a), research → `/delegate` 5b, plan fazı → `/delegate` 6. Kullanıcıya hangi fazların başladığını söyle. Merge kapıları ise her zaman sorulur.

**Tüm fazlar `done`** (`vlad task list --parent <çatı-id> --json`; `cancelled` fazlar yerine yenisi açılmışsa onlar sayılmaz) → `vlad task set <çatı-id> awaiting_approval --json` ve son kapı:
- **`prova` fazı varsa** (devops; `### Prova matrisi`, `### Bulunan hatalar`, `### Prova edilemeyenler` bölümlerini göster): kırmızı senaryo veya çözülmemiş bulunan hata varsa canlıya alma/dağıtım önerme; önce düzeltme fazı öner. `Prova edilemeyenler` doluysa kalan riski kullanıcıya açıkça söyle.
- Doğrulama fazının sonucunu göster (tüm suite, kırmızı test var mı) ve **kapı doğrulamasını** yap (yukarıdaki "Kapı doğrulaması (`gate`)": kartta `gate` varsa onunla, yoksa ad hoc koşu + uyarı). Yeşil değilse ana branch'e merge önerme; adım 2'deki "yeni uygulama + doğrulama fazı" yolunu öner.
- **Codex review (3. göz):** ana branch'e merge/PR'dan önce çatının entegrasyon worktree'sinde (PowerShell aracıyla) `codex review -c model="gpt-6-astra" -c model_reasoning_effort="medium" -c 'windows.sandbox="unelevated"' --base <default_branch>` çalıştır (Windows'ta `-c` bayrağı şart, onsuz sandbox komutları "blocked by policy" ile reddeder; `default_branch` kartta; çok projeli çatıda her projenin worktree'sinde). Bulguları kapıda göster; kritik/yüksek bulgu varsa merge/PR önerme, düzeltme fazı öner (kademeli güvenlik kuralıyla aynı çizgi: en çok 1 değişiklik turu; orta/düşük/bilgi `vlad finding add` ile kaydedilip kapıda listelenir). Model yoksa/model nedeniyle başarısızsa model ve efor `-c`'leri olmadan (varsayılan modelle) bir kez daha dene ve bunu logla; Codex kurulu değilse, yine başarısız olursa ya da bulut modunda Codex oturumu yoksa atla ve kullanıcıya "Codex review yapılamadı: <neden>" de.
- Fazların `### Açık noktalar` bölümlerini (danışman rollerde eşdeğerleri) topla ve tek listede göster; ayrıca açık bulguları ekle (`vlad finding list --project <slug> --state open,deferred --json`; kritik/yüksek olanlar kapıda ayrıca vurgulanır); kapsam dışı öneriler (ör. "CI'a ekle") burada kullanıcıya sunulur, istenirse ayrı görev açılır.
- Çatı birden çok projede faz çalıştırdıysa (`integration_worktrees` birden fazla satır) kapı doğrulamasını, diff özetini ve merge/PR'ı **her projenin** entegrasyon worktree'sinde ayrı ayrı yap ve sun; son kapı onayı projeler arası ortak tek karardır.
- Diff özeti: `git -C <çatı worktree> log --oneline main..HEAD` ve `git -C <çatı worktree> diff --stat main...HEAD`.

Seçenekler (açık onay):
1. **Ana branch'e merge:** `git -C <proje-yolu> branch --show-current` ile hedefi göster, onaylat; `git -C <proje-yolu> status` temizse `git -C <proje-yolu> merge --no-ff vlad/<çatı-id>`.
2. **Push + PR aç:** `git -C <çatı worktree> push -u origin vlad/<çatı-id>` ve `gh pr create --head vlad/<çatı-id> --fill`.
3. **Değişiklik iste:** çatı altına yeni faz aç (`/delegate` adım 4); çatıyı `vlad task set <çatı-id> running --json` ile geri al.
4. **İptal et:** aşağıdaki "pipeline'ı iptal et".

1 veya 2 tamamlanınca: `vlad task set <çatı-id> done --json` ve `vlad task cleanup <çatı-id> --json` (çatının `integration_worktrees` listesindeki her projedeki entegrasyon worktree'si kaldırılır; diskte olmayan atlanır, branch'ler kalır).

### Retro (son kapıdan sonra)

Çatı `done` olunca kısa bir retro yap (2–5 dakikalık özet; uzun rapor yazma). Kaynak: çatı ve faz görev dosyaları (`## İlerleme`, `## Sorular`, `## Kapanış raporu`), `failed`/`cancelled` fazlar, geri alınan merge'ler, kırmızı gate koşuları.
1. Kullanıcıya üç başlıkta göster: **Ne iyi gitti**, **Ne sürtündü** (tekrar eden hata, ortam sorunu, çakışma, limit kesintisi, geç yakalanan bulgu), **Ders** (somut, bir cümle, eyleme dönük).
2. Proje düzeyindeki dersleri kullanıcı onayıyla karta yaz (her ders ayrı komut; kart gövdesi elle düzenlenmez):
   ```
   vlad project note <slug> "<ders>" --json
   ```
   Notlar kartın `## Çalışma notları` bölümüne tarihli madde olarak eklenir; çalışanlar ve roller işe başlarken bunu okur. Aynı ders zaten notlardaysa ekleme.
3. **Rol düzeyindeki** dersler (bir rolün sorumluluk/yetki/çıktı kuralı değişmeli) kartı değil `roles/<slug>.md`'yi ilgilendirir: bunları kullanıcıya **öneri** olarak sun (hangi rol, hangi satır, neden). Onaylanırsa `roles/` değişikliği ayrı bir görev olarak `/delegate` ile açılır; VLAD rol dosyasını kendisi düzenlemez.
4. Retroda ortaya çıkan, düzeltilmemiş sorunları bulgu olarak kaydet: `vlad finding add --project <slug> --severity <…> --source <çatı-id> --title "<…>" --json`.
5. Sonunda `vlad kb commit "retro <çatı-id>" --push --json`.

**Faz `failed`/`cancelled`:** bağımlı fazlar `queued` kalır. Ağaçta göster ve seçenekleri sun:
- **Fazı yeniden oluştur:** aynı faz/rol/bağımlılıkla yeni görev (`/delegate` adım 4). Eski faza bağlı fazlar yeni ID'yi beklemez; onları `cancelled` yapıp yeni faza bağlı olarak yeniden oluştur.
- **Bağımlılığı kaldırarak devam et:** bağımlı fazları `cancelled` yapıp o bağımlılık olmadan yeniden oluştur, sonra `vlad task ready --parent <çatı-id> --json`.
- **Pipeline'ı iptal et:** açık tüm fazlar için `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`, sonra çatı için aynısı.
Kullanıcı döngüyü ortada büyütmek/küçültmek isterse de böyle: çatı altına faz ekle veya fazı iptal et; mevcut fazlar korunur.

## 4. `blocked` görevler

`## Sorular`'daki son **Soru:** satırını göster. Kullanıcı cevaplarsa:
```
vlad task answer <id> "<cevap>" --json
```
Çalışanın session'ı açıksa ona `SendMessage` ile "görev dosyasına bak" bildirimi gönder.

**Test itirazı** (soru `Test itirazı:` ile başlıyorsa; developer bir kabul testini yanlış buluyor): soruyu, itiraz edilen testi ve tester'ın görevini (`T…`) kullanıcıya göster, özetle ve şu seçenekleri sun: (a) **tester'a yönlendir** — tester görevi hâlâ açıksa `vlad task log <tester-id> "Test itirazı: …"` düş ve çalışana ilet, kapanmışsa yeni bir kısa `kabul` düzeltme fazı aç (`/delegate` adım 4, rol `tester`); (b) **VLAD karar verir** — spec/sözleşmeye bakıp testin doğru/yanlış olduğunu gerekçesiyle söyle (kullanıcı onayıyla); testi sen düzenlemezsin. Cevabı `vlad task answer` ile developer'a yaz ("test düzeltilecek, şu görev/commit" veya "test doğru, gerekçe"). Karar kullanıcıda değilse bile kayda geçer: `vlad task log`.

## 5. `stalled` görevler

Son `## İlerleme` satırını ve `session_id`'yi göster. Seçenekler:
- **Devam:** önce `vlad task resume <id> --json` (yalnızca `running`/`stalled`). Hata verirse (worktree yok, yanlış branch, session yok) mesajı göster; **yanlış worktree'de devam ettirme**. Başarılıysa:
  - `mode: "local"`: `dirty` doluysa kullanıcıya söyle; `stalled` ise `vlad task set <id> running --json`; kullanıcıya `worktree` yolunda devam etmesini ve `prompt`'u çalışana vermesini öner (`claude --resume <session_id>` / `claude --continue` ile birlikte).
  - `mode: "cloud"`: `stalled` ise `vlad task set <id> running --json`; `args` ile `send_message` çağır (`session_id`, `message`). Bu bir dış eylem değil, mevcut çalışana devam mesajıdır.
  Kesilen çalışanları (oturum limiti, çökme) bu yolla sürdür; yeni görev açma.
- **İptal:** `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`.

## 6. Hatalı görevler (`failed` listesi)

`vlad status --json` çıktısındaki `failed` listesini kullan; her biri için `error` alanını göster.
- **`failed` durumundaki dev görevi** (birincil öneri): `vlad task set <id> cancelled --json` → `vlad task cleanup <id> --json` → kullanıcıya yeni bir görev oluşturmayı (`/delegate`) öner. Pipeline fazıysa adım 3'teki "faz `failed`/`cancelled`" seçeneklerini sun.
- **`queued` durumunda `error` dolu görev** (launch başarısız olmuş, worktree geri alınmıştır): yalnızca `vlad task launch <id> --json` ile yeniden dene.
- İstersen iptal de sunulur: `vlad task set <id> cancelled --json` + `vlad task cleanup <id> --json`. Worktree zaten varsa `launch` durur; üzerine yazma, kullanıcıya sor.

## 7. Hafızayı commit'le

Bu akışta görev durumu değiştiyse (done, cancelled, cevap, değişiklik isteği, faz başlatma) sonunda:
```
vlad kb commit "status: <id> <yeni durum>" --push --json
```

## Kullanıcıya göster

Önce tablo (pipeline'lar ağaç), sonra onay/aksiyon bekleyen her görev için ayrı kısa blok ve numaralı seçenekler. Tek seferde bir görev için karar iste.
