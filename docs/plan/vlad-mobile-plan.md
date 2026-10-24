## Kapanış raporu
Not: `writing-plans` skill'i yüklendi. Görev dosyası bölümlerini bölmemek için başlıklar `###` düzeyindedir (rol kuralı), bu yüzden skill'in `#` plan başlığı kullanılmadı. Dosya yazılmadı (bu plan hariç), commit yok. Spec: `docs/superpowers/specs/2026-10-24-vlad-mobile-design.md`. Çatı dalı `vlad/T20261024-94`.

**Kısa özet:** 42 uygulama dilimi + 5 tester kabul dilimi. Her dilim tek çalışan fazına sığacak boyuttadır (hedef: <= ~600 satır üretim kodu, tek ekran ya da tek servis). Her dilimin açık `bağımlılık`ı, rolü ve Otomatik/Prova/Cihaz ayrımlı kabulü "Görev listesi"ndedir.

Doğrulanmış kod tespitleri (taslaktan; plana etki eden): `src/cli.ts:60-70` `def()` her komuta `--json` ekler; `src/git/git.ts:66` `worktreePath` `\\` ile birleştirir; `src/launcher/mode.ts:10-20` Linux'ta bulut yoksa `auto` hata verir (`test/cloud/mode.test.ts` bunu bekler); `src/tasks/launch.ts:21` kartın tek `path`'ini okur, `launch.ts:166` `closeWorkerWindow` yalnız win32; `src/tasks/store.ts:179` `readyWithLimit` yalnız `maxParallel` bilir; `src/kb/commit.ts:57` push upstream'e ya da `origin <branch>`'e gider; `schemas/task|project.schema.json` `additionalProperties:false`. `expectedHeadSha` repoda yok (varsayım: GitHub merge `sha` parametresi aynı işi görür).

### Bileşenler

Barındırma (kullanıcı kararı): şimdilik AWS EC2 Graviton (arm64, Ubuntu 24.04), sonra Raspberry Pi (arm64); taşıma birebir, sağlayıcıya özgü servis kullanılmaz (taşınabilirlik ilkesi). Oracle'a özgü adım yok.

Güvenlik sınırı iki ayrı Unix kullanıcısıdır: `vlad` (ajan tarafı) ve `vladapi` (kapı tarafı). Ortak yer yalnız `kb/` (grup `vlad`, umask 002). `kb/` bir güven sınırı DEĞİLDİR: ajan oraya yazabilir; bu yüzden API `kb/` içeriğine (grant, audit, kart) güvenmez, doğrular (Sistem tasarımı).

1. **`src/` CLI genişlemeleri** (kök paket `vlad`). Tüm `kb/` yazmaları buradan geçer ve `withKbLock` ile serileştirilir.
   - Yeni kayıt türleri: `card`, `grant`, `active`, `audit`, `quota`; görev alanları `host`, `progress`, `pr`; kartta `paths`, config'te `machines`, `minCliVersion`.
   - Yeni komutlar: `vault search|read|ls`, `worker tap`, `task relaunch|progress|pr`, `project path|clone`.
   - `ProcessLauncher` (Linux). Yeni komut grupları `src/cli-groups/*.ts`; `cli.ts` şişmez.
2. **`server/`** (TypeScript/Node 22, Fastify, ayrı `package.json` + `package-lock.json`). `kb/`'ye yalnız `vlad ... --json` alt süreciyle erişir. Üç süreç:
   - `vlad-api` (kullanıcı `vladapi`): 127.0.0.1, dışarı Funnel; eşleştirme, imza, okuma, SSE, onay yolu, devir motoru, FCM, GitHub kapı istemcisi, promote. Cihaz defteri, nonce, bildirim defteri, `grant-uses.json`, olay defteri, **kendi denetim kopyası** `/var/lib/vladapi/` (0700) altındadır.
   - `vlad-chat` (kullanıcı `vlad`): sohbet turlarını çalıştırır (başlangıç tasarımı: her mesaj = kısa `claude -p --resume <id>` turu; kalıcı süreç yalnız S11x). Unix soketi `/run/vlad/chat.sock`. Kapı kimliği yok.
   - `vlad-kbsync` (kullanıcı `vlad`, systemd timer, 60 sn): `kb/` kirliyse `vlad kb commit "sunucu: otomatik" --push` (tek commit'leyici).
   - Sınırlar: API `claude` çalıştırmaz ve kb commit/push etmez; sohbet/çalışan ana branch'e dokunamaz.
3. **`contract/`**: `openapi.yaml`, `fixtures/*.json`, `fixtures/external/*` + `MANIFEST.json`, `signing-vectors.json`. Sunucu vitest'i ve Android `:core` testi aynı dosyaları tüketir. Tek kaynak.
4. **`mobile/`** (Android, Kotlin + Compose; DiskPilot düzeni): `:core` (saf JVM: modeller, kanonik dizi, API arayüzü, indirgeyiciler, SSE ayrıştırıcı) ve `:app` (Compose, Keystore, BiometricPrompt, FCM; yalnız CI'da derlenir). Ekran başına `ui/<ekran>/<Ekran>Route.kt` ve `NavGraphBuilder.<ekran>Route()`; `NavGraph.kt` yalnız S7b'nin sahip olduğu kayıt listesini tutar.
5. **`deploy/`**: `install.sh`, `RUNBOOK.md`, systemd birimleri, Funnel betiği, ruleset/App kılavuzu, `claude/worker-settings.json`, `rehearse.sh`, `vlad-server doctor`.
6. **GitHub** (dış zorlayıcı): ruleset'ler + iki kimlik: `vlad-agent` (ince ayarlı PAT; yalnız `vlad/*` push + PR) ve `vlad-gate` (GitHub App; merge, `vlad/approved` check-run, ana branch/etiket bypass).

### Sistem tasarımı

`exposure`: kart `local` diyor; sistem Funnel ile internete açılıyor. Plan `internet` ölçeğinde yazıldı, kart değeri kullanıcı kararıdır (Açık nokta 1). Tek kullanıcı olduğundan ölçek/maliyet kısa. **GÜVENLİK** işaretli bileşenler VLAD'ın kısa güvenlik incelemesine girer: S6b, S9a, S9b, S10a, S11b, S13c, S14b.

**Kimlik bilgisi sınırları**

| Kimlik / sır | Kimde | Yetki | Not |
|---|---|---|---|
| Claude abonelik girişi (`~/.claude`) | `vlad` | VLAD sohbet turları ve çalışanlar | Yalnız kota harcar |
| `vlad-agent` PAT | `vlad` (credential helper) | `vlad/*` push + PR; ruleset ana branch/etiketi engeller | Zarar yarıçapı ruleset'le sınırlı |
| `vlad-gate` App anahtarı | `vladapi` 0600 | check-run, merge, ana branch, etiket | Her çağrıda 1 saatlik token |
| FCM servis hesabı | `vladapi` | Bildirim | Ajan bildirim üretemez |
| Cihaz defteri, nonce, denetim kopyası | `vladapi` 0700 | İmza doğrulama | Ajan cihaz ekleyemez; denetimin yetkili kopyası burada, `kb/audit` yansıtmadır |
| Cihaz anahtarları | Telefon Keystore | `session`: okuma/sohbet; `approval`: kullanım başına biyometrik | Özel anahtar çıkmaz |

**Karar: çalışan izin modu.** Çalışanlar ve sohbet turları `--permission-mode acceptEdits` + `deploy/claude/worker-settings.json` allowlist ile koşar. `--dangerously-skip-permissions` bu planda hiçbir yerde kullanılmaz (kod/betik/test grep ile doğrular: S2a `launcher: no skip-permissions flag`). Allowlist izin verir: worktree içinde Read/Edit/Write; `git status|diff|log|add|commit|switch|checkout|merge|fetch`; `git push origin vlad/*`; `npm|npx|node|tsc|vitest`; `./gradlew -PskipAndroid=true*`; `vlad *`. Reddeder: `git push --force*`, master/main hedefli push, `gh pr merge*`, `gh api*`, `curl|wget`, `~/.config`, `~/.claude` sırları, `/var/lib/vladapi`, `.env*`. Allowlist savunma derinliğidir; zorlayıcı GitHub ruleset'idir. VLAD bunu kullanıcıya güvenlik etkili karar olarak sunar.

**Sıkı kapı uçtan uca (merge örneği)**
1. Çalışan kendi `vlad/<id>` branch'ini push eder, PR açar (taban: fazda `vlad/<çatı>`, son kapıda ana branch). `vlad task pr <id> --number N --repo o/r --base B`, sonra `vlad task report`.
2. API görev izleyicisi `awaiting_approval` görünce kapı kartını görevden türetir (depolanmaz).
3. Kullanıcı "Merge et": `POST /v1/actions/prepare`. Sunucu PR'ı `vlad-gate` ile canlı okur, challenge'ı saklar (60 sn).
4. Uygulama kartı yalnız challenge alanlarından çizer; BiometricPrompt `approval` anahtarıyla challenge baytlarını imzalar; `POST /v1/actions/{id}/approve`.
5. Sunucu sırayla doğrular, biri tutmazsa yazan çağrı yapılmaz: cihaz iptal değil; zarf imzası; challenge süresi/nonce; `approval` imzası SAKLANAN bayt dizisi üzerinde ve `approval` anahtarıyla (session anahtarı reddedilir); PR açık; `head.sha` == challenge `head_sha`; taban == challenge tabanı; CI yeşil (`ci_not_green` 422); `mergeable`.
6. `vlad-gate` `vlad/approved` check-run'ını head SHA'ya `success` yazar; mergeable_state `blocked` olmaktan çıkana dek en çok 10 sn bekler (aksi `409 not_mergeable`); `PUT .../merge` gövdede `sha: head_sha`; 409 → `head_moved`, yazan başka çağrı yok.
7. `audit` kaydı (tek, `action_id` anahtarlı), `vlad task set <id> done`, sıradaki fazların mekanik başlatılması (LLM turu yok), bildirim, SSE.

**Karar: `mergeable: null`.** GitHub ilk çağrıda `null` dönebilir: 2 sn arayla en çok 3 deneme; hâlâ `null` ise `409 not_mergeable` + `detail: mergeable_unknown`, kart "tekrar dene" gösterir. Yanıt biçimi D0A'da gerçek örnekle doğrulanır.

**Karar: idempotans.** Eylem durumları `prepared -> approved -> checked -> merged|failed` `/var/lib/vladapi/challenges/<id>.json` içinde atomik (`tmp`+`rename`) tutulur. Aynı challenge'a ikinci/eşzamanlı approve, kilitle (`action_id` başına mutex) tek merge üretir; check-run yazılıp merge çökerse tekrar approve kaldığı yerden devam eder (check-run zaten varsa yeniden yazılmaz, PR zaten merge'liyse yalnız denetim tamamlanır). Denetim `action_id` ile tekildir.

**Challenge bayt dizisi** (sabit sıra, `anahtar=değer`, `\n`; değer alfabesi `[A-Za-z0-9._/#:-]`; alan sırası/eksik/fazla alan/satır sonu enjeksiyonu reddedilir):
```
vlad-approve/v1
action_id=A-...
kind=merge_phase|merge_final|tag_release|...
repo=o/r
pr=42
base=vlad/T20261024-94
head_sha=<40 hane>
task=T...
nonce=<b64url 16B>
exp=<unix sn>
```
`exp` dahil: `now >= exp` reddedilir (tam 60. sn reddedilir, 59. sn kabul). Sunucu saati geri giderse challenge geçersiz sayılır (monotonik saat kontrolü).

**Çift yol, tek çıkış:** cihaz onayı ve yetki devri aynı `executeAction(action, approval)`'a düşer. GitHub'a yazan tüm çağrılar tek `GithubWriter` sınıfındandır (tek çıkış sayacı bunu sarar).

**Derinlemesine savunma (zorlayıcı olan GitHub):** Ruleset 1 ana branch güncelleme yalnız `vlad-gate`; Ruleset 2 `v*` etiket oluşturma yalnız `vlad-gate`; Ruleset 3 `vlad/approved` zorunlu check'i `integration_id` ile `vlad-gate`'e sabit. Ajan token'ı sızsa ana branch'e giremez. Ruleset yoksa kod katmanı tek başına zorlayıcı sayılmaz (Açık nokta 2).

**Eşleştirme ve imza (GÜVENLİK):** `vlad-server pair` (SSH, `vladapi`): 8 karakter Crockford base32 (40 bit), TTL 10 dk, tek kullanım; `vlad://pair?host=&code=&fp=` QR. Telefon iki EC P-256 anahtar üretir: `session` (her istek) ve `approval` (`setUserAuthenticationRequired(true)`, StrongBox varsa; yeni biyometrikte geçersiz). `POST /v1/pair` kod + iki SPKI alır; P-256 dışı/bozuk SPKI reddedilir. Kod 5 yanlışta yanar (sonrasında doğru kod da yanar), genel sayaç. Eşleşmemiş istek `401`, gövdesiz bilgi. İptal: `vlad-server device revoke <id>`: o cihazın açık SSE'leri kapanır, bekleyen challenge'ları geçersiz olur, o cihazın imzaladığı devirler **geçersiz sayılır** (listede "cihaz iptal"). Zarf imzası:
```
v1\n<METHOD>\n<yol + sıralı sorgu>\n<ts_ms>\n<nonce>\n<sha256hex(ham gövde)>
```
Başlıklar `X-Vlad-Device|Ts|Nonce|Sig` (b64url, ECDSA SHA-256 DER). Pencere ±120 sn (±120 dahil kabul, ±121 red). Nonce yalnız imza geçerliyse 5 dk saklanır (yeniden başlatmada diske yazılı). Gövde sınırı 1 MB. Hız sınırı eşleşmemiş ve eşleşmiş için ayrı kovalar.

**Yetki devri (GÜVENLİK):** yalnız telefondan, `approval` anahtarıyla imzalı (`POST /v1/grants`); API her kullanımda imzayı cihaz defterine karşı yeniden doğrular; `kb/grants/` sahte kaydı sonuçsuzdur. Devredilemez (şemada enum dışı + kodda reddedilir): `tag_release`, `publish`, `delete`, `security`, `scope_change`. Koşullar merge anında yeniden değerlendirilir (değerlendirme sonrası CI kırmızı/head değişirse merge yok). `max_uses` sayacı sunucu durumunda, kilitle atomik. `no_severe_findings` yalnız Claude bulgularını değerlendirir; `codex_clear` Codex yoksa SAĞLANMAZ sayılır (devir uygulanmaz, kart onay ister; spec'in "Codex yoksa kapı kilitlenmez" kuralıyla çelişmez çünkü kart yolu açıktır). Her kullanım tek denetim kaydı + tek bildirim.

**Karar: `kb/` çok-kullanıcı yazma modeli.** Tek yazma kapısı `vlad` CLI; her yazan komut `withKbLock` (kilit dosyası `kb/.vlad.lock`, O_EXCL + pid + 60 sn bayat algısı, 10 sn bekleme, aksi `kb meşgul`) içinde çalışır. `vladapi` grup yazma hakkıyla `vlad` CLI'ı kendi kimliğiyle çağırır (answer, grant add, audit add, card answer). Commit/push yalnız `vlad-kbsync`. `by_device` alanı CLI argümanından değil, API'nin doğrulanmış zarfından gelir (API ajan sahteciliğini kb'den değil `/var/lib/vladapi` kaydından çözer). Ajanın `kb/audit` ve `kb/grants` içine yazabilmesi kabul edilmiştir: denetimin yetkili kopyası ve devir imza doğrulaması sunucu tarafındadır.

**Karar: kb-server / master topolojisi.** Sunucu kb klonu `kb-server` dalına push eder (`machines.<ad>.kbPushBranch`; yoksa `commitKb --push` reddeder: güvenli varsayılan). Her sunucu yazma öncesi `git pull --no-rebase origin master` (merge) yapar. `promoteKb` (`vladapi`, `vlad-gate` ile, 60 sn): `kb-server`'ın `master`'a göre farkı yalnız `kb/` ve `vault/docs/` altında ise master'a merge commit'i (rename yok `--no-renames`, symlink/mod değişikliği/submodule reddedilir); aksi halde `kb_conflict` kartı (aynı fark için tekrar açılmaz). Windows VLAD doğrudan `master`'a yazar ve `master`'ı çeker (promote sonuçlarını böyle görür); `kb-server`'ı çekmez. Etkin VLAD devri: sunucu `claim --takeover` sonrası hemen promote tetikler (`POST /v1/active/takeover` -> `vlad active claim --takeover` -> `promoteKb()`); promote başarısızsa takeover "bekliyor" kartı gösterir. Ayrıntı çakışmaları S13a tasarım notunda kilitlenir.

**Karar: kalıcı oturum.** Başlangıç: `ChatTurnRunner` her sohbet mesajı için `claude -p --resume <chat_session_id> --output-format stream-json` koşar; mesajlar seri kuyruktur; oturum kimliği `kb/logs/chat-session.txt` (gitignored). Kalıcı süreç (`--input-format stream-json`) yalnız D0A.1 olumluysa S11x ile eklenir, aynı arayüzün arkasında. Sohbet kutusu ek oturum açmaz.

**Gerçek zamanlı:** izleyici `kb/tasks|cards|grants` için **saf anlık-görüntü-fark fonksiyonu** (`diffSnapshots`) + `fs.watch` yalnız tetikleyici. SSE olayı geçersiz kılma ipucudur (istemci `GET /v1/home` ile yeniler); `id: <seq>`, `Last-Event-ID`, `GET /v1/events?after=<seq>&limit` yoklaması, 20 sn kalp atışı. Funnel SSE taşımazsa istemci yoklamaya düşer (D0B.3). Bildirimler SSE'den bağımsız FCM.

**Bildirimler:** FCM HTTP v1 `notification` + `data`; kanal `decisions`; kilit ekranı metni genel (karar: ayrıntı yok; yükte `head_sha`, repo, kart başlığı bulunmaz); dokununca `vlad://card/<id>` (id tahmin edilemez değil ama `GET /cards/{id}` imzalıdır). Defter anahtarı `(tür, id, durum)`; **soğuk başlangıçta mevcut durum tohumlanır, bildirim gönderilmez**; open->resolved->open ikinci bildirim üretmez (kart "Bugün"de kalır). Gönderilenler yalnız: kapı kartı, soru/test itirazı, kırmızı CI/çakışma, VLAD sorusu, faz bitti, yetki devriyle otomatik işlem. `UNREGISTERED/NOT_FOUND` token'ı işaretler; 5xx/429 en çok 3 yeniden deneme, çift bildirim yok.

**Kota (Max 5x):** olaylar VLAD'ı uyandırmaz; kartlar kb'den türetilir; sıradaki faz mekanik başlar. LLM turu yalnız sohbet, `/digest` ve açık isteklerde. Kota işareti `worker tap`/sohbet akışındaki sınır olayından `kb/logs/quota.json`. Kota varken yeni faz başlamaz (`held_by_limit`, neden `quota`, `maxParallel`'den önceliklidir); koşan çalışan öldürülmez, biter. Bozuk/boş/geçmiş `quota.json` "sınır yok" sayılır (uyarı).

**Çalışanlar (Linux):** `systemd-run --user --collect --unit=vlad-worker-<id>`, `KillMode=control-group`, açık `--setenv` listesi (PATH, HOME, VLAD_HOME, VLAD_TASK_ID, VLAD_MACHINE); `install.sh` `loginctl enable-linger vlad` yapar. Çıktı `vlad worker tap <id>` ile süzülür. ASK akışı: çalışan `vlad task ask` -> süreç çıkar (`blocked`) -> `vlad task answer` -> `vlad task relaunch <id>` (`--resume`). `blocked` iken süreç yoktur (maxParallel'e saymak mevcut `store.ts` kuralı korunur; developer doğrulayacak, varsayım). Sunucu yeniden başlarsa `running` kalanlar `stalled`.

**Çift VLAD:** `kb/active.md`. Yazan her CLI komutu önce yerel kaydı kontrol eder; muafiyet yalnız `VLAD_TASK_ID` verilmişse ve `kb/tasks/<id>.md` vardır ve durumu `running` ise (sahte ortam değişkeni tek başına yetmez). Başka makine tazeyse yazma durur.

**Sürüm uyumu (Windows VLAD):** yeni şema alanları `additionalProperties:false` yüzünden eski CLI'ı bozar. S1a `vlad.config.json`'a `minCliVersion` ekler ve her komut başında kontrol eder (`VLAD CLI çok eski: <gerekli>`); yeni alan yazan her dilim S1a'dan sonra gelir; RUNBOOK ilk sunucu kullanımından önce Windows VLAD'ın güncellenmesini ister.

**Bildirim/oturum dışı:** `ListAgents`/`SendMessage`/zamanlanmış görev bildirimleri sunucuda kalkar (spec §11). CLAUDE.md açılışı "ListAgents yoksa atla" der; uyumlu.

### Arayüzler

**API (`contract/openapi.yaml`, taban `/v1`, hata `{error:{code, message_tr, details?}}`).**

| Uç | İmza | İstek | Yanıt |
|---|---|---|---|
| `GET /health` | yok | | `{ok:true, version}` |
| `POST /pair` | yok (kod) | `{code, device_name, session_pub, approval_pub, fcm_token?}` | `{device_id, server_time}`; hatalı kod `401` |
| `GET /home` | session | | `{seq, asks:Card[], workers:Worker[], quota:{limited, until?}, active_vlad:{machine, since, heartbeat, mine}}` |
| `GET /cards/{id}` | session | | `Card` (kapı kartı: PR, head SHA, CI, kapanış raporu, `reviews[]` kancası) |
| `GET /tasks/{id}`, `GET /pipelines` | session | | görev ayrıntısı, pipeline ağacı |
| `GET /projects`, `/projects/{slug}`, `/findings` | session | süzgeç | kart, bulgular |
| `GET /vault/search?q&zone`, `GET /vault/file?path` | session | | `{hits[]}`, `{path, content, headings[]}` |
| `POST /cards/{id}/answer` | session | `{option?, text?}` | `{ok}` |
| `POST /tasks/{id}/request-changes` | session | `{text}` | `{ok}` |
| `POST /chat`, `GET /chat/history?before` | session | `{client_msg_id, text}` | `202 {chat_id}` (cevap SSE) |
| `POST /actions/prepare` | session | `{kind, task_id?, card_id?, params?}` | `Challenge {action_id, bytes_b64, fields, exp}` |
| `POST /actions/{id}/approve` | session + approval | `{device_id, signature}` | `{status:"executed", result}`; `409 head_moved|not_mergeable`, `422 ci_not_green`, `410 expired`, `401` |
| `POST /actions/{id}/reject` | session | | `{ok}` |
| `GET /grants`, `DELETE /grants/{id}`, `POST /grants` | session; POST + approval | imzalı devir | liste, iptal, `{id}` |
| `POST /active/takeover` | session | | `{ok}` |
| `GET /devices`, `PUT /devices/me/fcm`, `POST /devices/{id}/revoke` | session; revoke + approval | | |
| `GET /events?after&limit`, `GET /stream` (SSE) | session | | `{seq, type, data}` |

SSE türleri: `card.opened`, `task.state`, `worker.progress`, `chat.delta`, `chat.done`, `action.executed`, `grant.used`, `quota.changed`. Hata kodları: `unauthorized`, `expired`, `head_moved`, `ci_not_green`, `not_mergeable`, `not_delegable`, `grant_invalid`, `device_revoked`, `bad_request`, `rate_limited`, `quota_hold`, `active_elsewhere`. İstemci/CI **hata kodu anahtarına** bakar, Türkçe metne değil. `PUT /devices/me/fcm` yalnız çağıran cihazın kaydını değiştirir. `/chat` metni 1..4000 karakter; `/events` `after` negatif/çok büyük -> `bad_request`, `limit` 1..500. Bir kb kaydı bozuksa `GET /home` o kaydı atlar ve `warnings[]` ekler, çökmez.

**Kayıt şemaları (CLI).** Hepsi `schemas/*.schema.json` + `src/kb/schema.ts` `SchemaKind`. Hata biçimi mevcut: stderr `{"error": <anahtar>, "details": [...]}` + çıkış 1; testler `error` anahtarına bakar.
- `task`: `host` (string|null); `progress` `{pct int 0-100|null, label, at}`; `pr` `{number, repo:"o/r", base, url}`|null. Komutlar: `vlad task progress <id> [--pct N] --label T`, `vlad task pr <id> --number N --repo o/r --base B [--url U]`, `vlad task relaunch <id>`.
- `project`: `paths` `{ "<makine>": "<yol>" }` (anahtar `^[A-Za-z0-9._-]+$`), `path` zorunlu kalır. `vlad project path <slug> [<yol>] [--machine A]`, `vlad project clone <slug>`.
- `config`: `launcher` enum + `"process"`; `machines.<ad> {roots?, launcher?, maxParallel?, worktreeDir?, kbPushBranch?}`; `minCliVersion`. Makine adı `VLAD_MACHINE` ya da `os.hostname().toLowerCase()`.
- `card` -> `kb/cards/C-<YYYYMMDD>-<NN>.md`: `id`, `kind` (`ci_red|conflict|vlad_question|action_request|kb_conflict`), `project`, `task|null`, `state` (`open|resolved|dismissed`), `title`, `options[{id,label}]`, `answer {option?, text?, by_device, at}|null`, `action` (yalnız `action_request`: `{kind, repo, pr?, base?, ref?}`), `created`, `updated`. `NN` günde 99'u aşarsa üç haneye genişler (`C-20261024-100`). `action_request` yalnız karttaki projenin kayıtlı repo(ları) için kabul edilir (başka repo reddedilir: `repo izin listesinde değil`). Komutlar: `vlad card new|list|answer|resolve|show` (`answer` ikinci kez: `zaten cevaplandı`).
- `grant` -> `kb/grants/G-<NNN>.md`: `id`, `scope {type:"project"|"pipeline", ref}`, `action` (`merge_phase|merge_final`), `conditions` (>= `ci_green`; ayrıca `no_severe_findings`, `codex_clear`), `created`, `expires` (en çok 30 gün; created+30 g aşan reddedilir, tam 30 g kabul), `max_uses`, `revoked`, `device_id`, `signature`, `payload_version:"v1"`. İmzalı bayt: `vlad-grant/v1\nid=..\nscope=<type>:<ref>\naction=..\nconditions=a,b\ncreated=..\nexpires=..\nmax_uses=..`. Komutlar: `vlad grant add --file <json>` (yalnız biçim), `grant list [--active]`, `grant revoke <id>`.
- `active` -> `kb/active.md`: `machine`, `since`, `heartbeat`, `takeover_from`. `vlad active show|claim [--takeover]|heartbeat|release`. Bayatlık eşiği 2 saat, ayrı nabız yazımı en çok 30 dk'da bir (Açık nokta 5).
- `audit` -> `kb/audit/YYYY-MM.jsonl`: `ts`, `action_id` (tekil), `kind`, `repo`, `pr`, `head_sha`, `approver {type:"device"|"grant", id}`, `result`, `merge_sha?`, `detail?`. `vlad audit add --file -`, `audit list [--since]` (bozuk satır uyarı olarak listelenir, çökmez).
- `quota` (`kb/logs/quota.json`, gitignored): `{limited_until, reason, at}`; `vlad quota set --until <iso> --reason T|show|clear`. `vlad task ready --json` çıktısı: `quota:{limited, until}`, `held_by_limit[].reason: "limit"|"quota"`.
- `vlad vault search <q> [--zone kb|docs] | read <yol> [--heading T] | ls [<dizin>]` (CLI alt komutu; MCP yok, çalışanların Bash'i zaten var). İzin listesi: `kb/` (hariç `kb/inbox`, `kb/logs`) ve `vault/docs/`; `realpath` kökte kalmalı; büyük/küçük harf farkıyla yasağı aşmak mümkün olmamalı.
- `vlad worker tap <id>` (iç): stdin stream-json; `kb/logs/workers/<id>.jsonl`; `session_id` -> `task session`; son adım -> `task progress`; sınır olayı -> `quota set`. Ayrıştırıcı bilinmeyen/yarım satırı yok sayar, >1 MB satırı atar.

**Launcher (`src/launcher/process.ts`)**
```ts
export function buildShScript(req: LaunchRequest): string;                  // saf
export function buildSystemdRun(req: LaunchRequest, scriptPath: string): { file: string; args: string[] };
export function closeWorker(taskId: string): number[];                       // win32: closeWorkerWindow; linux: systemctl --user stop
export class ProcessLauncher implements Launcher { constructor(o: { dryRun?: boolean; exec?: ExecFn; scriptDir?: string }) }
// LaunchRequest.resume?: { sessionId: string }; LaunchMode += "process"
// resolveLaunchMode("auto","linux",{}) -> "process" (bulut değişkeni varsa "cloud")
// worktreePath(root, slug, id, platform = process.platform): string        // path.join / path.win32.join
// readyWithLimit(tasks, maxParallel, quota?: { limited: boolean; until?: string })   // saf; dosya okuma çağıranda
```

**Sunucu iç arayüzleri (`server/src`)**
```ts
runVlad(args: string[], o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>  // zaman aşımında öldürür, eşzamanlı sınır 4
verifyEnvelope(req, devices: DeviceStore, nonces: NonceCache, now: number): Promise<{ deviceId: string }>
buildChallenge(a: ActionInput, pr: PrSnapshot, now: number): { bytes: string; fields: Record<string,string>; exp: number }
verifyApproval(ch: StoredChallenge, sigB64u: string, dev: Device): boolean
diffSnapshots(prev: Snapshot, next: Snapshot): LedgerEvent[]               // saf
executeAction(a: StoredAction, approval: { type:"device"|"grant"; id: string }): Promise<ExecResult>
evaluateGrants(task: TaskData, grants: Grant[], live: LiveChecks, now: number): Grant | null
promoteKb(): Promise<{ promoted: boolean; reason?: string }>
class ChatTurnRunner { enqueue(msg: { clientMsgId: string; text: string }): Promise<void> }  // seri; client_msg_id tekil; argüman dizisi shell'siz
```
`vlad-server doctor --json` çıktısı sürümlü: `{version:1, checks:[{id, status:"ok"|"fail"|"skip", detail}]}`; çıkış kodu 0 hepsi ok, 1 en az bir fail, 2 doctor çalışamadı.

**Android `:core`** (`mobile/core/src/main/kotlin/dev/vlad/core/`): `crypto/Canonical.kt` (`challengeBytes(fields)`, `envelopeString(...)`, `canonicalQuery(...)`), `api/VladApi.kt`, `api/Models.kt`, `repo/HomeRepository.kt`, `reduce/HomeReducer.kt`, `sse/SseParser.kt`. `:app`: `security/KeystoreSigner.kt` (`SessionSigner`, `ApprovalSigner`), `ui/<ekran>/`, `push/VladMessagingService.kt`.

### Dosya yapısı

Yeni:
- `src/cli-util.ts`, `src/cli-groups/{index,card,grant,active,audit,quota,vault,worker}.ts`, `src/{cards,grants,active,audit,quota}/store.ts`, `src/vault/search.ts`, `src/kb/{machine,lock}.ts`, `src/launcher/{process,stream}.ts`.
- `schemas/{card,grant,active,audit}.schema.json`.
- `test/records/*.test.ts`, `test/launcher/process.test.ts`, `test/tasks/relaunch.test.ts`, `test/acceptance/mobile-<dilim>-*.test.ts` (tester).
- `contract/{openapi.yaml, signing-vectors.json, fixtures/*.json, fixtures/external/*, fixtures/external/MANIFEST.json}`.
- `server/` (`package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index,config}.ts`, `src/http/{app,routes-*}.ts`, `src/auth/{pairing,signature,devices,nonces}.ts`, `src/vlad/cli.ts`, `src/read/*`, `src/events/{watcher,diff,ledger,sse}.ts`, `src/notify/fcm.ts`, `src/actions/{challenge,executor,grants,advance,state}.ts`, `src/github/{appToken,client,writer,doctor}.ts`, `src/kbsync/promote.ts`, `src/chat/{turnRunner,sessionClient}.ts`, `src/bin/{vlad-server,vlad-chat}.ts`, `test/{unit,integration,acceptance,e2e,helpers}/**`).
- `mobile/` (`settings.gradle.kts`, `build.gradle.kts`, `gradle/libs.versions.toml`, `gradle.lockfile`/dependency locking, `gradlew*`, `core/`, `app/`, `ci/check-tests.sh`).
- `.github/workflows/{mobile,server}.yml` (`server.yml` yol süzgeci: `server/**`, `contract/**`, `mobile/**`, `src/**`, `schemas/**`).
- `deploy/` (`install.sh`, `RUNBOOK.md`, `env.example`, `systemd/{vlad-api,vlad-chat,vlad-kbsync,vlad-kbpromote}.service|timer`, `tailscale-funnel.sh`, `github/{rulesets.sh,APP.md}`, `claude/worker-settings.json`, `rehearse.sh`).
- `docs/superpowers/specs/<tarih>-vlad-kb-topology.md` (S13a).

Değişecek: `src/cli.ts` (taşıma + `registerAll`; `task` grubuna `progress|pr|relaunch`; `project` grubuna `path|clone`; `process` modu), `src/kb/{types,schema,home,config,commit}.ts`, `src/git/git.ts:66`, `src/launcher/{mode,types,index}.ts`, `src/tasks/{launch,store,resume}.ts`, `schemas/{task,project,config}.schema.json`, `global/skills/vlad-worker/SKILL.md`, `.gitignore` (`kb/logs/workers/`, `kb/logs/chat-session.txt`, `kb/.vlad.lock`), `test/cloud/mode.test.ts` (Linux `auto` artık `process`; yorumla gerekçelendirilir), kök `package.json` `gate` (`tsc --noEmit && vitest run && npm --prefix server ci && npm --prefix server run gate`; sunucu testleri derlenmemiş `dist/`'e değil `tsx`/build adımına karşı koşar).

### Paylaşılan dosyalar ve ad alanları

| Dosya | Dokunan | Sahip | Kural |
|---|---|---|---|
| `src/cli.ts` | S1a | S1a | Yalnız S1a (taşıma + `registerAll`). Diğerleri `cli-groups/*.ts` ekler. `task`/`project` grup eklemeleri S1b (`cli-groups/task-ext.ts`, `project-ext.ts` olarak) |
| `src/cli-groups/index.ts` | S1b, S2b, S3a, S3b, S4a, S4b, S5, S2c | S1a (iskelet) | Her dilim yalnız kendi `import` + dizi satırını ekler (alfabetik tek satır) |
| `src/kb/{types,schema,home}.ts` | S1a, S1c, S3-S5 | S1a | S1a tüm iskeleti ekler; diğerleri kendi tipini doldurur, mevcut satırı değiştirmez |
| `schemas/{task,project,config}.schema.json` | S1a, S2a | S1a | `launcher:process` yalnız S2a'nın tek satırı |
| `src/tasks/store.ts` | S2c | S2c | `readyWithLimit` gövdesi; başka dilim dokunmaz |
| `src/launcher/{mode,types,index}.ts` | S2a | S2a | Tek sahip |
| `src/kb/commit.ts` | S13b | S13b | Tek sahip |
| `contract/openapi.yaml`, `fixtures/*` | S6a, sonra her server dilimi | S6a | Sonraki dilimler yalnız kendi yol/şema bölümünü ekler; mevcut alan değişikliği `Test itirazı` ile sorulur |
| `contract/signing-vectors.json` | S6a, S7b (cihaz vektörü ekler) | S6a | Mevcut vektör salt-okunur; yeni vektör satır ekleme |
| `contract/fixtures/external/MANIFEST.json` | D0A, D0B, S8a, S9b | D0A | Yalnız kendi girişini ekler |
| `server/src/http/app.ts` | S6b-S6d, S8a, S9a, S10a, S11b, S12a, S13c | S6b | Her dilim `registerXRoutes(app)` satırı + kendi `routes-<ad>.ts` dosyası |
| `server/src/events/ledger.ts` | S6d, S8a | S6d | S8a yalnız bildirim eşlemesi |
| `server/test/acceptance/single-exit.matrix.ts` | S9a (tester T9 sahibi) | T9 | Rota envanterinden üretilir; yeni rota satırsız eklenirse test kırılır |
| `mobile/app/.../NavGraph.kt`, `MainActivity.kt`, `Features.kt` | mobil hat | S7b | Hat sırası: S7b -> S8b -> S9c -> S11c -> S10b -> S12b -> S13d. **Aynı anda en çok bir mobil dilim çalışır.** Ekran kendi `<Ekran>Route.kt` dosyasını getirir, `Features.kt`'ye tek satır ekler |
| `mobile/gradle/libs.versions.toml`, `mobile/app/build.gradle.kts` | S7a, S7b, S8b, S9c | S7a | Yalnız satır ekleme |
| `global/skills/vlad-worker/SKILL.md` | S2b, S9d | S2b | S9d yalnız "faz PR'ı" paragrafı |

Ad alanları: birim `describe` önekleri `records:`, `launcher:`, `server:`, `mobile-core:`; harness adı dilime özgüdür. Tester kabul: `test/acceptance/mobile-<dilim>-` ve `server/test/acceptance/<dilim>-`; E2E `server/test/e2e/`. Test hijyeni: sabit takvim tarihi yok, `now` enjekte, göreli zaman, duvar saati beklemesi yok (bekleme yardımcısı).

### Görev listesi

**Dilim tablosu.** `İlk UI` = ilk kullanıcıya görünen dilim (VLAD bundan sonra ara `denetim` ekler). `Hat` = mobil hat. Roller: developer / tester / designer / devops (araştırma dilimlerinde developer: fixture'ı commit eder).

| ID | Başlık | Bağımlılık | Rol | İlk UI |
|---|---|---|---|---|
| D0A | Spike (sunucusuz): D0.1 stream-json oturumu, D0.2 ask/resume + allowlist, D0.5a GitHub REST gerçek yanıtlar | yok | developer | |
| D0B | Spike (kullanıcı ortamı): D0.3 Funnel SSE, D0.4 FCM, D0.5b ruleset/App/plan | kullanıcı ortamı (aşama 2); S14a RUNBOOK'tan ayrı | developer (+kullanıcı) | |
| U0 | UI tasarımı: Bugün, onay, sohbet, projeler, hafıza ekran görselleri + tema | yok | designer | |
| S1a | `cli-util` taşıma, şema alanları, `minCliVersion`, `machine.ts`, `worktreePath(platform)` | yok | developer | |
| S1b | `task progress|pr`, `project path|clone`, `launch` makine yolu + `host` | S1a | developer | |
| S1c | `withKbLock` ve tüm yazan komutlara uygulama | S1a | developer | |
| S2a | Linux `ProcessLauncher`, `mode.ts`, `closeWorker`, `worker-settings.json` | S1a, S1b | developer | |
| S2b | `worker tap`, `stream.ts`, `task relaunch`, ask->çıkış->answer->relaunch | S2a, S1c, D0A | developer | |
| S2c | `quota` komutları + `readyWithLimit` kota | S1a | developer | |
| S3a | `card` şeması/store/komutları | S1c | developer | |
| S3b | `audit` şeması/store/komutları | S1c | developer | |
| S4a | `grant` şeması/store/komutları | S1c | developer | |
| S4b | `active` kaydı + `activeGuard` | S1c, S1b | developer | |
| S5 | `vault search|read|ls` | S1a | developer | |
| T1 | Kabul testleri: S1-S5 CLI sözleşmesi (yalnız arayüzden) | S1a arayüz belirtimi (plan) | tester | |
| S6a | Sözleşme: `openapi.yaml`, fixture'lar, `signing-vectors.json`, MANIFEST doğrulayıcı | S1b, S3a, S3b, S4a, S5 | developer | |
| S6b | `auth/*`: eşleştirme, zarf, nonce, hız sınırı, rota envanteri testi (GÜVENLİK) | S6a | developer | |
| S6c | `runVlad`, `read/*`, `/home`, `/cards`, `/tasks`, `/pipelines` | S6a, S1c | developer | |
| S6d | `events/*`: `diffSnapshots`, defter, SSE, `/events`, cihaz iptalinde akış kapanışı | S6b, S6c | developer | |
| T6 | Kabul: auth/zarf/imza vektör negatifleri, nonce, hız sınırı, olay defteri | S6a | tester | |
| S7a | `mobile/` iskelet, `:core` (Canonical, Models, Reducer, SseParser), `mobile.yml` | S6a | developer | |
| U0b | (U0 çıktısı S7b girdisi) | U0 | designer | |
| S7b | `:app`: KeystoreSigner, eşleştirme, "Bugün" salt-okunur, sohbet iskeleti | S7a, S6b, S6c, U0 | developer | EVET (Hat 1) |
| S8a | `notify/fcm.ts`, bildirim defteri, `PUT /devices/me/fcm` | S6d, D0B (D0.4) | developer | |
| S8b | `:app`: `VladMessagingService`, kanal, derin bağlantı, izin | S8a, S7b | developer | Hat 2 |
| S9a | `actions/challenge`, `prepare`, `verifyApproval`, eylem durum makinesi (GÜVENLİK) | S6b, S6d, S3b | developer | |
| S9b | `executor`, `github/{client,writer,appToken}`, sahte GitHub, `advance`, denetim (GÜVENLİK) | S9a, D0A (D0.5a) | developer | |
| S9c | `:app`: onay kartı ekranı, BiometricPrompt, `FLAG_SECURE`, `head_moved` | S9a, S9b, S8b | developer | Hat 3 |
| S9d | `vlad-worker` SKILL: sunucu modunda faz PR'ı + `task pr` protokolü | S1b, S2b | developer | |
| S9e | (isteğe bağlı) Key attestation zinciri doğrulaması | S6b | developer | |
| T9 | Kabul: tek çıkış sayacı, TOCTOU, idempotans, devir negatifleri (S9+S10) | S6a, S9a arayüz | tester | |
| S10a | Devir motoru: `POST /grants`, `evaluateGrants`, kullanım sayacı (GÜVENLİK) | S4a, S9b | developer | |
| S10b | `:app`: "Yetki devirleri" ekranı | S10a, S9c | developer | Hat 5 |
| S11a | `ChatTurnRunner` (`claude -p --resume`), kuyruk, backoff, durum | D0A, S6d, S2b | developer | |
| S11b | `/chat`, `/chat/history`, `/cards/{id}/answer`, `/request-changes`, `action_request` akışı (GÜVENLİK) | S11a, S9a, S3a | developer | |
| S11c | `:app`: sohbet bağlama, akış, "Cevapla" | S11b, S9c | developer | Hat 4 |
| S11x | (D0A.1 olumluysa) kalıcı süreç; `ChatTurnRunner` arkasında | S11a, D0A | developer | |
| T11 | Kabul: sohbet/oturum dayanıklılığı, enjeksiyon, `evet` negatifi | S11b arayüz | tester | |
| S12a | `/projects`, `/projects/{slug}`, `/findings`, `/vault/*` uçları | S5, S6c | developer | |
| S12b | `:app`: Projeler ve Hafıza sekmeleri | S12a, S10b | developer | Hat 6 |
| S13a | Tasarım notu: kb-server/master topolojisi, takeover-promote yarışı | S4b | architect (developer değil; VLAD architect fazı) | |
| S13b | `commitKb kbPushBranch`, `vlad-kbsync` timer betiği | S13a, S1c | developer | |
| S13c | `promoteKb`, `kb_conflict`, `POST /active/takeover` (GÜVENLİK) | S13b, S9b, S4b | developer | |
| S13d | `:app`: etkin VLAD kartı ve "devral" | S13c, S12b | developer | Hat 7 |
| T13 | Kabul: promote izin listesi, çift VLAD yarışları | S13a | tester | |
| S14a | `install.sh`, systemd birimleri, `RUNBOOK.md`, `env.example` | S2a, S6b, S11a, S13b | devops | |
| S14b | `github/rulesets.sh`, `APP.md`, `vlad-server doctor` (GÜVENLİK) | S9b, D0B (D0.5b) | devops | |
| S14c | `rehearse.sh`, canary, temiz ortam provası | S14a, S14b | devops | |

Not: `U0b` ayrı faz değil, U0'ın çıktısıdır (satır S7b bağımlılığını açıklar; faz sayısına girmez). Toplam: 42 uygulama dilimi (U0b hariç, tester T1/T6/T9/T11/T13 dahil değil) + 5 tester dilimi = 47 faz. Paralel kümeler: {D0A, U0, S1a}; sonra {S1b, S1c, S2c, S5}; sonra {S2a, S3a, S3b, S4a, S4b}; {S6b, S6c} ∥ {S7a}; {S8a, S9a} ... Tester dilimleri ilgili uygulama dilimleriyle paralel koşar, kapıda birleşir.

**Ortak kabul kuralları.**
- Her dilimde kök `gate` (`tsc --noEmit` + `vitest run` + sunucu gate) yeşil kalır; Windows `launch/cleanup` birim testleri değişmeden geçer (`karakterizasyon` etiketi).
- Rapor üç sütunludur: **Otomatik** (CI/gate, kayıtlı çıktı), **Prova** (sunucuda, kayıtlı çıktı), **Cihaz** (kullanıcı kontrol listesi). Prova ve Cihaz maddeleri için "kanıtlandı" denmez; "kayıtlı çıktıyla geçti"/"kullanıcı teyidi bekliyor" denir.
- Mobil dilimlerde CI koşusu bağlantısı ve yeşil job raporda zorunlu; CI yeşil olmadan kapanış yok. Roborazzi referansları yalnız CI'da üretilir, karşılaştırma toleransı %0.5 piksel farkı; derlenmeyen/koşulmayan liste raporda.
- Bağımlılık kilidi dosyaları (`package-lock.json`, `gradle.lockfile`) ilk dilimden itibaren commit'lidir.
- Fixture kuralı: `contract/fixtures/external/MANIFEST.json` her dosya için `{file, kind:"real"|"synthetic", source, captured_at, command}` tutar; CI testi manifestin tam ve her dosyanın başlık yorumunun dolu olduğunu doğrular. **`synthetic` fixture ile ilerlenebilir** (S2b, S8a, S9b için) ama raporda belirtilir; **S9b ve S8a kabulünde sentetik fixture'a dayanan madde "karşılanmadı" sayılır** (kapanış engellenir; yalnızca `gerçek fixture sonradan eklenecek` notuyla kullanıcı kabulüyle kapanır).

**D0A: Spike, sunucusuz** (araştırma; merge yok yalnız fixture/karar notu commit'i). Çıktı `contract/fixtures/external/` + `docs/.../d0-notlar.md`.
- D0.1 `claude -p --input-format stream-json --output-format stream-json --verbose`: çoklu tur, `--resume`, otomatik sıkıştırma, slash/skill, izin istemi çözümü (`--permission-mode acceptEdits` + allowlist), **kota/sınır olayı biçimi**, abonelik girişi kullanım koşulu notu.
- D0.2 Çalışan `claude -p` ASK sonrası `--resume` döngüsü, `session_id` çıkarma; allowlist ile git/npm/gradle/vlad komutlarının çalıştığı, deny'lerin engellendiği.
- D0.5a Kapsam: kullanıcının mevcut `gh` kimliğiyle atılabilir bir test reposunda `GET /pulls/{n}` (head.sha, ilk çağrıda `mergeable:null`), check-run create/update, `PUT .../merge` 200/405/409/422, installation token biçimi (dokümandan).
- Kabul (Otomatik): MANIFEST'te her madde ya `real` fixture ya da `yapılamadı: <neden>`; sonuç Açık noktaları kapatır/değiştirir. Hiçbir sır fixture'a girmez (tarama testi).

**D0B: Spike, kullanıcı ortamı** (aşama 2'den önce yapılamaz; ana yolu BLOKE ETMEZ, yalnız S8a gerçek fixture'ı, S14b, S14c ve SSE kararı için).
- D0.3 Funnel: 10 dk boşta SSE, kalp atışı, HTTP/2; yok sayılırsa yoklama kararı.
- D0.4 FCM v1: 200, 404 `UNREGISTERED`, 401; MIUI'de `notification`+`data`.
- D0.5b Ruleset (private repoda plan desteği), `integration_id` ile sabit check, App token üretimi, ajan PAT'ının ana branch'e push reddi.
- Kabul (Prova/Cihaz): kayıtlı gerçek yanıtlar; kullanıcı ortamı yoksa "yapılamadı" ile kapanır ve ilgili dilimler sentetik kuralıyla ilerler.

**U0: UI tasarımı** (designer). Girdi spec §5.1-5.4 ve taslak linki. Çıktı: Bugün (boş, dolu, sınır bekliyor, bağlantı yok), onay kartı (kırmızı CI'da pasif), sohbet, projeler, hafıza için ekran görselleri ve tema tokenları (renk/tipografi serbest, düzen bağlayıcı); 2× yazı boyutu varyantı. Kabul: her ekran için görsel + durum listesi; erişilebilirlik notu (pasif düğme açıklaması).

**S1a: temel iskelet** (bağımlılık yok).
- `cli-util.ts` taşıma; `registerAll`; şemalar (`host`, `progress`, `pr`, `paths`, `machines`, `launcher:process`, `minCliVersion`); `src/kb/machine.ts` (`currentMachine()`, `resolveProjectPath(card, machine)`; hata `bu makinede klon yok: <slug>`); `worktreePath(root, slug, id, platform)`.
- Test adları: `records: task accepts progress/pr/host`, `records: task rejects progress.pct 101`, `records: config machines overlay`, `records: old cli rejected by minCliVersion`, `launcher: worktreePath windows platform characterization`, `launcher: worktreePath linux uses forward slashes`, `launcher: windows-style worktreeDir rejected on linux with explicit error`.
- Kabul (Otomatik): mevcut `test/cli.test.ts` değişmeden geçer; Linux'ta `vlad task launch --dry-run --json` yolu mutlak, `\` içermez ve `worktreeDir` altında; yeni alanlar `--json` çıktısında görünür.

**S1b** `task progress|pr`, `project path|clone`, `launchTask` `host` yazar, `launch.ts:21` makine yolu. Test: `records: project clone from local bare repo`, `records: project path per machine`, `records: launch writes host`. Kabul (Otomatik): `project clone` yerel bare repo ile; eksik yol kullanıcıya `vlad project clone <slug>` önerir (`error` anahtarı sabit).

**S1c** `src/kb/lock.ts` `withKbLock<T>(fn: () => T | Promise<T>): Promise<T>`; tüm yazan komutlar sarılır. Test: `records: 50 concurrent audit-like writes no interleave`, `records: stale lock recovered`, `records: lock wait timeout error kb-meşgul`. Kabul (Otomatik): iki alt süreçten eşzamanlı 50 yazma satır karışmadan tamamlanır.

**S2a: Linux launcher** (S1a, S1b).
- `process.ts`, `mode.ts`, `closeWorker`, `deploy/claude/worker-settings.json` (allowlist/deny listesi Sistem tasarımı'nda).
- Test: `launcher: sh script escapes single quote $ newline`, `launcher: 82KB prompt passed via file not argv`, `launcher: model value validated`, `launcher: systemd-run args have explicit setenv list`, `launcher: KillMode control-group`, `launcher: no skip-permissions flag anywhere (script, args, settings)`, `launcher: auto on linux resolves process`, `launcher: dry-run output`.
- Kabul (Otomatik): sahte `exec` ile launch/cleanup; `systemd-run` yoksa sabit `error` anahtarı; Windows akışı değişmez; `test/cloud/mode.test.ts` değişikliği yorumla gerekçeli. (Prova) gerçek `systemd-run` S14c'de.

**S2b: worker akışı** (S2a, S1c, D0A).
- `stream.ts` (D0A fixture'ıyla; yoksa sentetik işaretli), `worker tap`, `task relaunch`, ask->çıkış->answer->relaunch durum makinesi.
- Test: `launcher: tap extracts session_id and last step`, `launcher: tap ignores unknown and partial lines`, `launcher: tap drops over 1MB line`, `launcher: utf8 split across chunks`, `launcher: limit event writes quota`, `tasks: relaunch without session_id explicit error`, `tasks: relaunch on other host rejected`, `tasks: ask exits blocked then answer then relaunch resumes`, `tasks: argument injection safe (value starting with - and ;)`.
- Kabul (Otomatik): fixture oynatma ile uçtan uca durum geçişleri. Gerçek sınır olayı yakalanmadıysa kota ayrıştırıcısı "sentetik" etiketli ve rapor bunu söyler.

**S2c** `quota set|show|clear`; `readyWithLimit(tasks, maxParallel, quota?)`. Test: `tasks: quota holds all ready as held_by_limit reason quota`, `tasks: quota expired clears`, `tasks: quota beats maxParallel reason`, `tasks: corrupt or empty quota.json treated as none with warning`, `tasks: unknown reason ignored`. Kabul (Otomatik): `ready --json` şekli geriye uyumlu (eski alanlar aynı, `reason` ek).

**S3a** card. Test: `records: card new/list/answer`, `records: card answer twice -> zaten cevaplandı`, `records: card invalid kind rejected`, `records: card id rolls past 99/day and at midnight`, `records: concurrent card new unique ids`, `records: concurrent card answer one wins`, `records: action_request repo outside project allowlist rejected`. Kabul (Otomatik): `--json` hata biçimi `{error, details}` ve çıkış 1.

**S3b** audit. Test: `records: audit monthly file`, `records: audit rejects invalid line`, `records: audit list warns on corrupt line without crash`, `records: audit duplicate action_id rejected`. **S4a** grant. Test: `records: grant max 30 days (exact 30d accepted, +1s rejected)`, `records: grant requires ci_green`, `records: grant non-delegable action rejected by schema`, `records: grant revoke only reduces`. **S4b** active. Test: `records: active other machine fresh -> error active_elsewhere`, `records: stale warns and continues (threshold +-1s)`, `records: takeover refreshes`, `records: worker exemption requires running task file (fake env var alone not enough)`, `records: concurrent claim one wins`. Kabul (Otomatik): korumalı komut listesi test edilir; çalışan `log/ask/report` etkin başka makinede çalışır.

**S5** vault. Test: `records: vault read ../../etc/passwd rejected`, `records: vault absolute path / ..\ / null byte / %2e%2e / double-encoding rejected`, `records: vault symlink escape rejected`, `records: vault kb/inbox and KB/LOGS case variants forbidden`, `records: vault heading read returns section`, `records: vault turkish İ/ı search`, `records: vault empty and 10k-char query bounded`, `records: vault binary and invalid utf8 and size cap`, `records: vault search lists only allowlisted paths (no grants/audit)`. Kabul (Otomatik): `search` skor sırası ve `--zone`.

**T1 (tester)** `test/acceptance/mobile-s1-*` ... `mobile-s5-*`: planın arayüz bölümünden, uygulamaya bakmadan; S1-S5 test adlarının negatif listeleri çapraz doğrulanır.

**S6a: sözleşme fazı.** `openapi.yaml` (tablo), kanonik fixture'lar, `signing-vectors.json`, `@redocly/cli` lint, MANIFEST doğrulayıcı.
- İmza vektörleri (tester item 5): geçerli ve geçersiz (bayt değişmiş, yanlış anahtar, bozuk DER, ham r||s) vektörler yalnız **doğrulama yönünde** sabit; üretme yönü Node ve Kotlin'de round-trip. Kanonik sorgu vektörleri (yinelenen anahtar, yüzde kodlama, büyük/küçük, boş değer, `+` ve `%20`); boş gövde `sha256("")`; hash ham bayt üzerinden. Node `crypto.verify` (`dsaEncoding:'der'`) ve Kotlin `Signature` aynı dosyayı tüketir.
- Test: `server: contract fixtures parse`, `server: signing vectors verify (valid/invalid set)`, `server: external manifest complete`, `server: openapi lint`.
- Kabul (Otomatik): yukarıdaki testler CI'da yeşil; bu dilim bitmeden S6b/S6c/S7a başlamaz.

**S6b: auth (GÜVENLİK).** Test: `server: unpaired request 401 no body leak`, `server: replay nonce rejected`, `server: replay after restart rejected`, `server: ts skew 119/121 s`, `server: revoked device rejected`, `server: 5 wrong pair codes burn the code (then correct code also fails)`, `server: pair code expiry and reuse and two concurrent correct codes`, `server: body over 1 MB rejected`, `server: nonce stored only after valid signature (no cache bloat)`, `server: paired and unpaired rate buckets separate`, `server: non-P256 or malformed SPKI rejected`, `server: device_name and fcm_token validated`, **`server: route inventory equals openapi (every route except /health and /pair has signature preHandler; unknown route fails)`**.
- Kabul (Otomatik): hepsi CI'da; Prova: `vlad-server pair` gerçek SSH oturumunda (S14c).

**S6c** `runVlad` (zaman aşımı + öldürme, eşzamanlı alt süreç sınırı 4), 2 sn okuma önbelleği, `/home`, `/cards`, `/tasks`, `/pipelines`. Test: `server: runVlad timeout kills process`, `server: runVlad concurrency capped`, `server: one corrupt kb record does not crash /home (warnings)`, `server: /home matches fixture with real vlad CLI and temp VLAD_HOME` (CLI `tsx`/build adımıyla, eski `dist/` kullanılmaz), `server: index.lock or push failure surfaces as error code`. Kabul (Otomatik): imzasız uç yok (bkz. S6b envanter).

**S6d** events. Test: `server: diffSnapshots same (task,state,updated) one event`, `server: Last-Event-ID replay`, `server: seq gap detection`, `server: /events after negative or huge and limit bounds`, `server: many SSE connections capped`, `server: revoke closes open SSE and invalidates pending challenges`. Kabul (Otomatik): duvar saati yok; Prova: Funnel üzerinden SSE (D0B.3).

**T6 (tester)** `server/test/acceptance/auth-*`, S6b/S6d negatif listeleri bağımsız.

**S7a: mobil iskelet + `:core`.** Adım 1 doğrulama: `./gradlew -PskipAndroid=true :core:test` Android plugin'i yüklemeden ARM'da koşar mı. Koşmazsa `:core` ayrı katılım derlemesi (included build) yapılır; olmazsa "ARM'da yeşil" iddiası düşer, yalnız CI.
- Test: `mobile-core: signing vectors verify`, `mobile-core: canonical challenge bytes golden`, `mobile-core: reducer states`, `mobile-core: sse parser chunk boundary utf8`.
- Kabul: Otomatik: CI'da `lintDebug testDebugUnitTest assembleDebug`; `:core` ktlint/detekt. Prova: ARM'da bayrakla `:core:test` koşusu kayıtlı çıktı (yapılamadıysa "yapılamadı: neden"). `google-services.json`: CI yer tutucuyla derler. Debug keystore depoda: "release imzası yok, repo private" notu güvenlik listesine.

**S7b: ilk görünen UI dilimi.** KeystoreSigner (iki anahtar), eşleştirme (QR/kod), "Bugün" salt-okunur, sohbet kutusu iskeleti; eylem düğmeleri pasif; debug ekranı "gerçek Keystore imzasını dışa aktar" (vektör için).
- Kabul: Otomatik (CI): Compose testi kart sayısı, durum etiketi, "bağlantı yok" bandı, kırmızı CI düğmesi TalkBack açıklaması; Roborazzi (boş, dolu, sınır bekliyor, 2× yazı); debug APK artifact. Cihaz: eşleştirme, gerçek cihaz imzasının sunucuda doğrulanması ("cihaz imzası sunucuda doğrulandı" kontrol listesi maddesi; yakalanan vektör `signing-vectors.json`'a eklenir).

**S8a** FCM. Test: `server: same snapshot twice -> exactly 1 FCM request`, `server: only allowed kinds notify (negative per other kind)`, `server: UNREGISTERED marks token`, `server: 5xx/429 bounded retry no duplicate`, `server: notified.json persists across restart`, `server: cold start seeds without sending`, `server: reopen same key not renotified`, `server: payload has no head_sha/repo/title (field scan)`. Kabul: Otomatik yukarıdakiler (FCM gerçek yanıt fixture'ı yoksa sentetik, "karşılanmadı"); Cihaz: MIUI (uygulama kapalı, kilitli, pil kısıtı) 60 sn içinde bildirim, geçti/kaldı.
**S8b** Kabul: Otomatik: derin bağlantı `vlad://card/<id>` doğru kartı açar (Compose testi); izin istemi akışı; Cihaz: Android 13 bildirim izni.

**S9a (GÜVENLİK)** challenge + prepare + `verifyApproval` + durum makinesi. Test (hepsinde yazan GitHub çağrısı = 0): `server: prepare head change then approve -> 409 head_moved`, `server: old challenge unusable after new prepare`, `server: signature of challenge A on action B rejected`, `server: signature over tampered bytes rejected`, `server: signature uses stored bytes not client copy`, `server: session-key signed approval rejected`, `server: challenge line-injection / reordered / missing / extra field rejected`, `server: exp exactly 60s rejected, 59s accepted, clock skew and server clock rewind`, `server: expired challenge 410`, `server: pr closed or deleted or base changed or mergeable_state blocked/behind/dirty`.
**S9b (GÜVENLİK)** executor + `GithubWriter` + sahte GitHub (gerçek fixture'dan oynatır) + advance + denetim. Test: `server: merge call carries sha=head_sha`, `server: concurrent two approves (Promise.all) -> exactly one merge`, `server: check-run written then merge crashes -> retry completes once, no double merge or audit`, `server: ci red -> 422 and no write`, `server: audit written once keyed by action_id`, `server: mergeable null retries 3x then not_mergeable`, `server: advance starts ready phases without LLM turn`, `server: github write methods only via GithubWriter` (tek çıkış sayacı: GitHub istemcisi Proxy ile sarılır, PUT/POST/PATCH/DELETE sayılır).
- Kabul: Otomatik: tüm testler; **tek çıkış** (T9 matrisi): her uç için {imzasız, eşleşmemiş, hatalı imza, süresi dolmuş, yanlış cihaz, iptal cihaz} -> yazan çağrı 0; geçerli onay/devirde tam 1 ve `sha` doğru; ana branch'e `vlad-agent` kimliğiyle yazma yolu hiçbir kod yolunda yok (statik tarama testi). Fixture sentetikse bu dilimin kabulü "karşılanmadı".
**S9c** Kabul: Otomatik (CI): onay ekranı alanları challenge'dan çizilir (serbest metin ayrı bölümde "VLAD yazdı" etiketli), `FLAG_SECURE` Robolectric ile, `head_moved` sonrası kart yenilenir ve eski challenge imzalanamaz, kırmızı CI'da düğme pasif, BiometricPrompt iptal/başarısız/kilitlenme durumları. Cihaz: parmak izi onayı, yeni biyometrikte yeniden eşleştirme yönlendirmesi.
**S9d** `vlad-worker/SKILL.md`: faz PR'ı + `task pr`. Kabul (Otomatik): skill metni testi (`test/skills/`) komut adlarını doğrular. **S9e** isteğe bağlı: anahtar sertifika zinciri; yapılmazsa Açık nokta değil, "kapsam dışı" kalır.

**T9 (tester)** `server/test/acceptance/single-exit.*`, `route-inventory.*`, `toctou-*`, `grant-*`: Sistem tasarımı'ndaki tüm negatif listeler; tek çıkış matrisi rota envanterinden üretilir.

**S10a (GÜVENLİK)** Test: `server: unsigned grant file in kb ignored`, `server: tag_release grant not_delegable (schema and code separately)`, `server: grant expired/revoked/max_uses`, `server: max_uses=1 two concurrent cards -> one passes`, `server: revoke concurrent with use`, `server: scope other project skipped`, `server: grant with ci red skips`, `server: ci turns red or head moves after evaluation -> no merge`, `server: forged signature rejected`, `server: grant of revoked device not honored`, `server: codex_clear without codex -> card path, not auto`, `server: one audit and one notification per use`. Kabul (Otomatik): hepsi; devredilemez eylemler her zaman kart ister.
**S10b** Kabul: Otomatik: kapsam/eylem/koşul/bitiş düz dil özeti, iptal (Compose); Cihaz: biyometrikli devir üretimi.

**S11a** Test: `server: chat turn replays real stream-json fixture`, `server: unknown/partial/over-1MB line, utf8 chunk boundary`, `server: exit codes and hung turn timeout`, `server: crash loop backoff then session_down state reflected in /home`, `server: message not lost or marked not_delivered`, `server: client_msg_id deduped`, `server: resume fallback when session id invalid`, `server: argv injection (; rm -rf, leading -) safe`. Kabul: Otomatik; Prova: soket izinleri (S14c). **S11x** yalnız D0A.1 olumluysa; aynı testler kalıcı süreç için.
**S11b (GÜVENLİK)** Test: `server: chat "evet" never calls executeAction`, `server: chat empty/too long/duplicate bounded`, `server: card answer runs task answer then relaunch`, `server: action_request becomes card only; prepare required`, `server: by_device from verified envelope not client field`. Kabul (Otomatik): hepsi.
**S11c** Kabul: Otomatik: akış gösterimi, kota mesajı "sınır nedeniyle bekliyor", "Cevapla" kartı; Cihaz: uçtan uca sohbet.
**T11 (tester)** `server/test/acceptance/chat-*`: T11 negatif listesi (enjeksiyon, kayıp mesaj, devamlılık).

**S12a** Test: `server: vault path escape -> bad_request (encoded/double/backslash/null/symlink/case)`, `server: every vault search hit path returns 200 on /vault/file`, `server: kb/inbox and kb/logs forbidden at API`, `server: sensitive dirs (audit, grants) not listed`. **S12b** Kabul: Otomatik: arama sonucu dosyayı açar (Compose), salt okunur; Cihaz: yok.

**S13a** Tasarım notu (architect fazı): Sistem tasarımı'ndaki kb-server/master kararlarını ayrıntılandırır: merge mi rebase mi (karar: merge), takeover-promote sırası, Windows'un `master`'ı nasıl çektiği, çakışma çözüm akışı. Kabul: not commit'li; S13b/c bu nota göre test yazar.
**S13b** Test: `records: commitKb --push without kbPushBranch rejected on server machine`, `records: push goes to HEAD:refs/heads/kb-server`, `records: non-kb files in unpushed commits still block push`. **S13c (GÜVENLİK)** Test: `server: promote only kb/ and vault/docs paths`, `server: promote rejects ../, symlink, rename (--no-renames), mode change, submodule`, `server: diverged -> kb_conflict card, not reopened`, `server: takeover triggers promote, failure shows pending card`. Kabul (Otomatik): `kb/` dışı dosya içeren `kb-server` farkı ana branch'e geçmez. Prova: gerçek remote ile (S14c).
**S13d** Kabul: Otomatik: etkin VLAD kartı, salt-okunur mod, devral onayı (Compose); Cihaz: yok.
**T13 (tester)**: eşzamanlı claim (push reddi, kayıp yazma yok), saat kayması, takeover sonrası salt okunur.

**S14a** `install.sh` (kullanıcılar, grup, umask, systemd, `enable-linger`, Node 22, `claude`, `gh`, Tailscale), `RUNBOOK.md` (bölüm A AWS: EC2 Graviton arm64, ör. `t4g.large`, Ubuntu 24.04 arm64; güvenlik grubunda GELEN PORT YOK, SSH yalnız anahtarla ve tercihen Tailscale içinden; EBS boyutu önerisi ve anlık görüntü; AWS Budgets bütçe alarmı (kredi ~120 gün); bölüm B Raspberry Pi 5 arm64 taşıma: aynı `install.sh`, `kb/` klonu + `/var/lib/vladapi` + worktree kopyası, cihazlar yeniden eşleştirilir; sağlayıcıya özgü servis yok; Tailscale + Funnel + ACL `nodeAttr funnel`, Firebase, GitHub App/ruleset, Claude girişi, `google-services.json`, Windows VLAD güncelleme sırası), kilit dosyası/`npm audit` adımı. Kabul: Otomatik: `shellcheck` yeşil, birim dosyaları `systemd-analyze verify`; Prova: temiz ortam (S14c).
**S14b (GÜVENLİK)** `rulesets.sh`, `APP.md`, `doctor` (sahte GitHub yanıtlarıyla birim testli). Test: `server: doctor exit 0 all ok / 1 fail / 2 cannot run`, `server: doctor json fields versioned`, `server: doctor flags non-gate bypass actor`, `server: doctor flags missing integration_id pin`. Kabul: Otomatik: doctor birim testleri. Prova: gerçek ruleset kontrolü.
**S14c** `rehearse.sh`: umask 077, ikinci koşu, yetkisiz kullanıcı, `KillMode`, soket izinleri, `vlad-agent` PAT ile ana branch'e boş commit push **canary** (reddedilmeli). Kabul: Otomatik: yok (betik). Prova: sunucuda kullanıcıyla bir kez; kayıtlı çıktı. "Dış zorlayıcı kanıtlandı" denmez; "doctor yeşil + canary reddi kayıtlı" denir.

**Güvenlik kabul metni (S9/S10 raporu).** "Kod katmanı: tek çıkış (a) + rota envanteri (b) CI'da yeşil. Dış zorlayıcı: `doctor` yeşil + canary reddi kayıtlı; otomatik değil, sunucuda kullanıcıyla bir kez."

### Test stratejisi

| Senaryo | Seviye | Konum / araç |
|---|---|---|
| Şema, kayıtlar, makine yolu, kota, vault, launcher, kilit | Birim (developer) | `test/records/`, `test/launcher/`, `test/tasks/` (vitest, geçici `VLAD_HOME`) |
| CLI sözleşmesi yalnız arayüzden | Kabul (tester T1) | `test/acceptance/mobile-<dilim>-*.test.ts` |
| Eşleştirme, zarf, nonce, SHA, devir | Birim + entegrasyon | `server/test/` (Fastify `inject`, sahte GitHub/FCM, enjekte `now`) |
| Tek çıkış sayacı (a), rota envanteri (b) | Kabul (tester T9) | `server/test/acceptance/` |
| Uçtan uca: eşleştir -> home -> prepare -> approve -> sahte GitHub'da `sha`'lı merge -> denetim -> görev done | E2E (tester) | `server/test/e2e/` (gerçek `vlad` CLI + sahte GitHub + Node "sanal cihaz") |
| İmza uyumu Android <-> sunucu | Sözleşme | `signing-vectors.json` iki tarafta; üretme yönü round-trip |
| API modelleri | Sözleşme | `fixtures/*.json` iki tarafta + OpenAPI lint |
| Android mantığı | Birim | `mobile/core/src/test` |
| Compose UI, ekran görüntüsü, 2× yazı | UI (Robolectric + Roborazzi) | `mobile/app/src/test` (yalnız CI) |
| Keystore, BiometricPrompt, FCM, MIUI | Cihaz | Kullanıcı kontrol listesi (Android 13 / MIUI 14 varsayımı); otomatik kanıt yok |
| `systemd-run`, soket izinleri, temiz kurulum | Prova | `deploy/rehearse.sh` |
| Ruleset gerçekten engelliyor mu | Prova | `vlad-server doctor` + canary |

ARM'da derlenemeyenler: `:app` ve Roborazzi (GitHub Actions x64). Sunucudaki çalışanlar kartın `gate`'ini (`-PskipAndroid=true :core:test` + kök `npm run gate`) koşar ve CI sonucunu bekler. Developer birim kapsamı: her modülün başarı, hata ve sınır durumu (boş girdi, Türkçe karakter, aşırı uzun metin, eşzamanlı yazma). Gerçek yanıt fixture ilkesi: bkz. fixture kuralı (MANIFEST, sentetik = karşılanmadı). Çalışan kabul testini yanlış bulursa `vlad task ask` ile "Test itirazı".

### Riskler

| Risk | Olasılık / etki | Azaltma |
|---|---|---|
| Kalıcı headless Claude oturumu belirsiz | Orta / yüksek | Başlangıç tasarımı `--resume` turu; kalıcı süreç S11x'e bağlı D0A.1 |
| Max 5x kotası | Yüksek / orta | Olay başına LLM turu yok; `maxParallel=2`; kota -> `held_by_limit` |
| Sınır olayı biçimi bilinmiyor | Orta / orta | D0A.1; ayrıştırıcı bilinmeyeni yok sayar; elle `quota set` |
| Funnel uzun SSE'yi taşımıyor | Orta / orta | Defter + `/events` yoklaması; FCM bağımsız |
| Funnel herkese açık, DoS/saldırı | Yüksek / orta | Yalnız imzalı uçlar, tek 401, 1 MB, hız sınırı; eylem imza + GitHub ister |
| FCM MIUI'de gecikir | Orta / orta | `notification`+`data`; pil kılavuzu; kart "Bugün"de |
| Özel repoda ruleset yok (Free plan) | Orta / yüksek | Açık nokta 2; ruleset yoksa tasarım zayıf, kod tek başına zorlayıcı sayılmaz |
| Ajan PAT'ı ruleset'siz ana branch'e yazar | Düşük / kritik | `doctor` + canary; PAT dar |
| Ajan prompt enjeksiyonu ile sır sızdırır | Orta / yüksek | Allowlist/deny, sırlar `vlad` kullanıcısında yok (gate/FCM `vladapi`'de); zarar yarıçapı ruleset |
| `kb` push istisnası sıkı kapıyı deler | Yüksek / yüksek | `kb-server` + promote (karar) |
| Eski Windows CLI yeni şemayı reddeder | Orta / orta | `minCliVersion`; S1a önce; RUNBOOK sırası |
| İki VLAD yazma çakışması | Orta / orta | `active`, çalışan muafiyeti sıkılaştırması, `kb_conflict` |
| Çalışan sunucu yeniden başlayınca ölür | Orta / orta | linger, `stalled`, `relaunch` |
| Keystore anahtarı biyometrik değişince geçersiz | Orta / düşük | Yeniden eşleştirme yönlendirmesi |
| `:core` ARM'da koşmaz (bayrak varsayımı) | Orta / orta | S7a adım 1 doğrulama; yedek: included build, yoksa yalnız CI |
| Ajanın yazdığı kart onayı yanıltır | Orta / yüksek | Onay ekranı yalnız doğrulanmış alanlardan; serbest metin etiketli |
| 47 faz, mobil hat seri | Yüksek / orta | Sunucu ve CLI hatları paralel; mobil hat tek şeritli ve sıralı |
| Gerçek fixture gelmez | Orta / orta | MANIFEST + sentetik = karşılanmadı kuralı |

### Eleştiriler ve nasıl ele alındı

**Developer eleştirisi**
1. S6/S9/S10/S11/S13 büyük, NavGraph çakışması: **Kabul.** S6 -> a/b/c/d, S9 -> a/b/c/d/e, S11 -> a/b/c/x; ekran başına `Route` dosyası + tek şeritli mobil hat.
2. D0 bağımlılıkları prose'ta; D0 fixture commit'i; D0.3/D0.4 kullanıcı ortamı: **Kabul.** D0A/D0B ayrıldı, bağımlılık sütunu açık, sentetik fixture kuralı (S9b/S8a'da "karşılanmadı").
3. Kalıcı oturum ana yolda riskli: **Kabul.** `--resume` turu başlangıç; kalıcı süreç S11x (D0A.1'e bağlı).
4. `:core` ARM'da kanıtsız: **Kabul.** S7a adım 1 doğrulama + yedek.
5. İzin modu: **Kabul, karar olarak yazıldı.** `acceptEdits` + allowlist; allowlist S2a'ya çekildi; `--dangerously-skip-permissions` yok (test var). VLAD kullanıcıya sunacak.
6. İki Unix kullanıcısı, `kb/` yazma modeli: **Kabul.** `withKbLock` (S1c) + tek commit'leyici `vlad-kbsync`; `vladapi` CLI'ı grup yazmasıyla çağırır; Alternatif (yazıcı soketi) reddedildi: ikinci bir ayrıcalıklı süreç ve kuyruk karmaşası; `kb/` güven sınırı değil, denetim/devir sunucuda yetkili.
7. `worktreePath` `\\`: **Kabul.** `platform` parametresi, Windows karakterizasyon testi, Linux'ta Windows `worktreeDir` açık hatayla reddedilir.
8. `readyWithLimit` saf: **Kabul.** Üçüncü parametre `quota?`.
9. `additionalProperties:false` / eski CLI: **Kabul.** `minCliVersion`, S1a ilk.
10. `kbPushBranch`/promote çelişkisi: **Kabul.** Topoloji kararı + S13a tasarım notu; merge, rebase değil; Windows `master`.
11. `sha` merge yarışı: **Kabul.** check-run sonrası 10 sn bekleme, 405/409 ayrımı D0A fixture'ıyla.
12. `enable-linger`, `--setenv`, KillMode: **Kabul.** S2a testi + S14a/S14c.
13. ASK -> blocked akışı: **Kabul.** S2b durum makinesi görevi.
14. `server/` lock, `npm ci`, yol süzgeci: **Kabul.** Kök gate'e `npm --prefix server ci`, `server.yml` süzgecine `src/**`, `schemas/**`. Fastify gerekçesi: şema doğrulama + `inject` testi; sürümler sabit.
15. `project clone` yerel bare repo: **Kabul** (S1b).
16. Test önekleri: **Kabul.**
17. Robolectric/Roborazzi yalnız CI: **Kabul.** Ortak kabul kuralı: CI bağlantısı zorunlu, derlenmeyen liste.
18. `google-services.json`: **Kabul.** CI yer tutucu, RUNBOOK.
19. Debug keystore depoda: **Kabul.** Güvenlik listesine not (S7a).
20. Önerilen sıra: **Kabul**, tabloda bağımlılık olarak somutlaştırıldı.

**Tester eleştirisi**
1. Üç katmanlı kanıt (tek çıkış, rota envanteri, doctor/canary): **Kabul.** S6b envanter testi, S9b/T9 tek çıkış matrisi, S14b/S14c; kabul metni verbatim.
2. Gerçek fixture + MANIFEST + sentetik = karşılanmadı + `mergeable:null` kararı: **Kabul.**
3. TOCTOU negatifleri: **Kabul.** S9a/S9b test adlarında; `exp` sınırı, idempotans, eşzamanlı approve.
4. Devir sahteciliği/yarışları, Codex yok kararı, 30 gün sınırı: **Kabul.** S4a/S10a; `codex_clear` Codex yoksa sağlanmaz (kart yolu açık).
5. İmza vektörleri: **Kabul.** S6a (doğrulama yönü sabit, round-trip), gerçek cihaz imzası S7b.
6. Nonce/zaman/hız sınırı/eşleştirme: **Kabul.** S6b.
7. FCM: **Kabul.** S8a; soğuk başlangıç tohumlama; reopen bildirimi bastırılır; MIUI Cihaz maddesi.
8. Kalıcı oturum dayanıklılığı: **Kabul.** S11a/T11. Soket izinleri S14c.
9. Ölçülemez kabul ölçütleri: **Kabul.** Hata kodu anahtarı, JSON alanları, `doctor` çıkış kodları, Roborazzi toleransı, "tek bildirim = tam 1 FCM isteği".
10. CI ayrıntıları: **Kabul.** `tsx`/build, `diffSnapshots` saf, CI yeşil zorunlu, süzgeç, kilit dosyaları.
11. Windows karakterizasyonu: **Kabul.** S1a.
12. Çift VLAD / promote: **Kabul.** S4b/S13b/S13c/T13; `kbPushBranch` yoksa `--push` reddi.
13. Vault okuma: **Kabul.** S5 (CLI) ve S12a (API) ayrı.
14. Kota: **Kabul.** S2c; koşan çalışan öldürülmez.
15. Kayıtlar: **Kabul.** S3a/S3b/S4b; `by_device` zarftan; `action_request` repo izin listesi.
16. Test hijyeni: **Kabul.**
17. UI testleri: **Kabul.** S9c.
18. Üç sütunlu rapor: **Kabul.** Ortak kabul kuralı.
19. Ek negatifler: **Kabul.** S6d (iptalde SSE/challenge), S6c (alt süreç), S10a (iptal edilen cihaz devirleri geçersiz), S11a vb.

**Reddedilen/ertelenen:** (a) MCP vault sunucusu: reddedildi (CLI alt komutu yeter). (b) Tek anahtarla imza: reddedildi (okuma ve onay gereksinimleri çelişir). (c) Yazıcı soketi: reddedildi (6). (d) S9e key attestation: ertelendi (isteğe bağlı, kapsam dışı). (e) Gece `/digest` otomasyonu: ertelendi, yeni karar gerekli (Açık nokta 6).

### Açık noktalar

Yalnız kullanıcı kararı gerektirenler (her biri için öneri):
1. **exposure:** kart `local`; sistem Funnel ile internete açılıyor. Öneri: `vlad project set vlad exposure internet`.
2. **GitHub planı / ruleset:** private repoda ruleset ve `integration_id` pinli check'in plan desteği doğrulanmadı (D0B.5b). Öneri: plan desteği yoksa ya Team planı ya depo public; ruleset olmadan sıkı kapı kod seviyesinde zayıf ve kabul edilmez.
3. **Ajan kimliği:** ince ayarlı PAT mı, ikinci GitHub App mı? Öneri: PAT (`vlad/*` push + PR, yalnız gerekli repolar, kısa ömür). Kapı kimliği `vlad-gate` GitHub App'ini kullanıcı kurar.
4. **`merge_final` devre açık mı?** Öneri: ilk dönemde yalnız `merge_phase` devredilebilir, `merge_final` kart ister (şema ikisini de destekler, kod bayrağıyla kapalı).
5. **Nabız:** `kb/active.md` nabzı en çok 30 dk'da bir, 2 saatte bayat; git'te görünmesi kabul mü? Öneri: kabul.
6. **Gece `/digest` sunucuda otomatik mi?** (kota harcar). Öneri: hayır, elle/sohbetle.
7. **Gerçek yanıt örnekleri (kullanıcı ortamı):** Funnel SSE, FCM yanıtı, ruleset/App gerçek çıktıları ancak aşama 2'den sonra alınabilir (D0B). Öneri: aşama 2'de D0B koşulsun; o zamana dek S8a/S14 sentetik fixture ile ilerler ve kapanışta "karşılanmadı" olarak kalır.
8. **Abonelik koşulu:** abonelik girişiyle sürekli headless/stream-json kullanımının koşullara uygunluğunun teyidi (D0A.1 not düşer). Öneri: kullanıcı koşul metnini teyit etsin.

Plan kararı olarak yazılan, VLAD'ın kullanıcıya güvenlik etkili karar diye sunacağı maddeler: çalışan izin modu (`acceptEdits` + allowlist, `--dangerously-skip-permissions` yok), kb-server/promote topolojisi, `kb/` tek yazma kapısı + kilit, `codex_clear` Codex yokken devir uygulamaz, iptal edilen cihazın devirleri geçersiz, kilit ekranı bildirimi genel.

Varsayımlar (doğrulanmadı): cihaz Android 13 / MIUI 14, `minSdk 33`, `targetSdk 35`; `applicationId` `dev.vlad.mobile`; GitHub merge `sha` parametresi `expectedHeadSha` işlevini görür; Node 22 `crypto.verify` DER'i Android `SHA256withECDSA` çıktısıyla doğrular (S6a vektörleri); `blocked` görev maxParallel'e sayılmaz (S2b'de mevcut kuralla doğrulanacak).

Kapsam dışı: Codex ikinci göz ve görsel üretimi (`reviews[]` kancası bırakıldı), vault'a belge taşıma (aşama 3), web uygulaması (aşama 4), AWS EC2 ve Pi kurulumu (kullanıcı; kılavuz S14a'da; Medialog küçültmesi gerekmiyor), iPhone, çok kullanıcı, tmux canlı terminal, key attestation (S9e isteğe bağlı).
