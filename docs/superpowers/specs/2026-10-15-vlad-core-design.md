# VLAD Çekirdeği — Tasarım Dokümanı

- **Tarih:** 2026-10-15
- **Durum:** Taslak (kullanıcı onayı bekliyor)
- **Kapsam:** Alt proje 1 (Çekirdek) + Alt proje 2 (Orkestrasyon) + Alt proje 3 (Farkındalık)

## 1. Amaç

VLAD, proje ve repo bağımsız, kalıcı bir "ana akıl" session'ıdır. Kullanıcının tüm projelerine hakimdir, yapılan işlerin çoğundan haberdardır ve işleri yeni Claude Code session'larına devredip takip eder.

### Başarı kriterleri (ilk sürüm)

1. **Proje hafızası (A):** Kullanıcı VLAD'a "X projesinde nerede kalmıştık, ne karar vermiştik?" diye sorduğunda VLAD, bilgi tabanındaki proje kartı, günlük ve karar kayıtlarından doğru ve güncel bir cevap verir.
2. **İş devri (B):** Kullanıcı "X projesinde Y'yi yap" dediğinde VLAD bir görev tanımlar, onay alır, izole bir worktree'de görünür bir çalışan session başlatır, ilerlemeyi takip eder ve sonucu onaya sunar.
3. Kullanıcının elle açtığı session'lar dahil **tüm** Claude Code session'ları VLAD'ın hafızasına raporlanır.
4. VLAD kapatılıp açıldığında hiçbir bilgi kaybolmaz (durum dosyalardadır, sohbet geçmişinde değil).

### Kullanıcı kararları

| Konu | Karar |
|---|---|
| Öncelik | A (proje hafızası) + B (iş devri ve takibi) |
| Çalışan modeli | Karma: kısa işler VLAD içinde arka plan agent'ı, geliştirme işleri ayrı ve görünür terminal session'ı |
| Çalışan yetkisi (varsayılan) | Kendi branch'inde commit'e kadar; push/PR/merge kullanıcı onayıyla. Proje bazlı değiştirilebilir. |
| Projeleri tanıma | Otomatik tarama (kök klasörler ayarlanabilir, varsayılan `C:\dev`) |
| Farkındalık | Tüm session'lar global hook ile raporlanır |
| Yaklaşım | Dosya tabanlı (Yaklaşım 1); ileride Agent SDK tabanlı ayrı orkestratör uygulamasına (Yaklaşım 3) geçilecek |
| Dil | TypeScript / Node |

### Kapsam dışı (bu tur)

Mail modülü, uzman roller (Finans, Pazarlama, Tester, Analyst, Developer persona'ları — sonradan `2026-10-15-vlad-roles-design.md` ile eklendi), orkestratör uygulaması, dashboard, MCP sunucusu. Şema ve `Launcher` arayüzü bunlara hazır tasarlanır.

## 2. Mimari ilkeler

1. **Durumun tek kaynağı `kb/`'dir.** Sohbet geçmişi kaybolabilir; dosyalar kalır.
2. **Veri bir sözleşmedir.** Her dosya türünün JSON Schema'sı `schemas/` altında tanımlıdır. Tüm yazmalar CLI üzerinden yapılır ve şemaya göre doğrulanır. Geleceğin orkestratörü aynı şemayı kullanır.
3. **Belirleyici işler script'te, yargı gerektiren işler prompt'ta.** Tarama, görev oluşturma, worktree, başlatma, hook → TypeScript (`src/`). Özetleme, kart yazma, kabul kriteri belirleme → VLAD (skill'ler).
4. **Görev yaşam döngüsü açık bir durum makinesidir** (§5.2). Geçersiz geçiş reddedilir.
5. **Çalışan başlatma tek bir arayüzün arkasındadır** (`Launcher`). Bugün `TerminalLauncher`, yarın `SdkLauncher`.
6. **Dış dünyaya etki eden her eylem kullanıcı onayı ister** (push, PR, merge, ileride mail gönderme).

## 3. Klasör yapısı

```
C:\dev\vlad\
├─ CLAUDE.md                  VLAD kimliği, kurallar, yetki sınırları
├─ vlad.config.json           ayarlar (§4)
├─ package.json, tsconfig.json, vitest.config.ts
├─ kb\
│  ├─ projects\<slug>.md      proje kartları
│  ├─ tasks\<id>.md           görevler
│  ├─ decisions.md            karar günlüğü
│  ├─ journal\<YYYY-MM-DD>.md işlenmiş günlük özet
│  ├─ inbox\<ts>-<sid>.json   ham session raporları        (gitignore)
│  ├─ inbox\processed\        işlenmiş raporlar            (gitignore)
│  └─ logs\                   hook/launcher hata kayıtları (gitignore)
├─ schemas\                   project.schema.json, task.schema.json, inbox.schema.json, config.schema.json
├─ src\
│  ├─ kb\                     frontmatter okuma/yazma, şema doğrulama, yol çözümleme
│  ├─ scan\                   repo keşfi ve ham bilgi toplama
│  ├─ tasks\                  durum makinesi, görev CRUD, log/rapor ekleme
│  ├─ git\                    worktree/branch yardımcıları
│  ├─ launcher\               Launcher arayüzü, TerminalLauncher
│  ├─ hooks\session-report.ts global SessionEnd hook'u
│  └─ cli.ts                  `vlad` komutu
├─ test\                      vitest testleri + fixture'lar
└─ .claude\
   ├─ settings.json           VLAD'a özel SessionStart hook'u
   └─ skills\                 scan, delegate, status, digest
```

Global olarak kurulanlar:
- `~/.claude/skills/vlad-worker/SKILL.md` — çalışan protokolü (her repoda erişilebilir olmalı)
- `~/.claude/settings.json` → `hooks.SessionEnd` — session raporu
- `vlad` CLI, `npm link` ile global PATH'e

## 4. Ayarlar — `vlad.config.json`

```json
{
  "roots": ["C:\\dev"],
  "ignore": ["*-wt", "node_modules", "vlad"],
  "defaultAutonomy": "commit",
  "staleAfterHours": 6,
  "launcher": "auto",
  "worktreeDir": "{repo}-wt",
  "projects": {
    "watchparty": { "autonomy": "commit" }
  }
}
```

- `defaultAutonomy` / `projects.<slug>.autonomy`: `plan` | `commit` | `pr`
  - `plan`: çalışan yalnızca plan yazar, onaysız kod yazmaz
  - `commit`: kendi branch'inde commit'e kadar (varsayılan)
  - `pr`: push + PR açmaya kadar; merge her zaman kullanıcıda
- `launcher`: `auto` (önce Windows Terminal, yoksa PowerShell penceresi) | `wt` | `powershell`
- `worktreeDir`: worktree'lerin oluşturulacağı klasör şablonu; `{repo}` repo yolu ile değiştirilir. Görev worktree'si `<worktreeDir>\<task-id>` olur.

## 5. Veri modeli

Tüm `.md` türleri YAML frontmatter + markdown gövdedir. Tarihler ISO 8601.

### 5.1 Proje kartı — `kb/projects/<slug>.md`

| Alan | Tip | Açıklama |
|---|---|---|
| `slug` | string | Dosya adıyla aynı, küçük harf-tire |
| `name` | string | Görünen ad |
| `path` | string | Repo kök yolu |
| `stack` | string[] | Teknolojiler (ör. `["typescript","react"]`) |
| `status` | `active`\|`paused`\|`archived` | |
| `autonomy` | `plan`\|`commit`\|`pr` | Config'ten türetilir; kartta görünür |
| `last_activity` | datetime | Son raporlanan session veya commit |
| `last_scanned` | datetime | |

Gövde başlıkları: `## Özet`, `## Mimari notlar`, `## Açık konular`, `## Son aktivite` (digest tarafından güncellenir).

### 5.2 Görev — `kb/tasks/<id>.md`

ID biçimi: `T<YYYYMMDD>-<NN>` (gün içinde sıralı, ör. `T20261015-01`).

| Alan | Tip | Açıklama |
|---|---|---|
| `id` | string | |
| `project` | string | Proje slug'ı |
| `title` | string | |
| `kind` | `dev`\|`research` | `dev` → ayrı session; `research` → VLAD içi arka plan agent'ı |
| `state` | enum | Aşağıda |
| `autonomy` | `plan`\|`commit`\|`pr` | Oluşturulurken projeden kopyalanır |
| `branch` | string? | `vlad/<id>` |
| `worktree` | string? | |
| `session_id` | string? | Çalışan Claude session ID'si (hook raporundan veya çalışandan) |
| `created`, `updated` | datetime | |
| `error` | string? | Son hata |

Gövde başlıkları: `## Tanım`, `## Kabul kriterleri`, `## Bağlam`, `## İlerleme` (zaman damgalı satırlar, `vlad task log` ekler), `## Sorular` (çalışan ↔ VLAD), `## Kapanış raporu`.

**Durum makinesi:**

```
queued ──launch──▶ running ──report──▶ awaiting_approval ──approve──▶ done
  │                 │  ▲                       │
  │                 │  └──────changes──────────┘
  │                 ├──ask──▶ blocked ──answer──▶ running
  │                 ├──fail─▶ failed ──retry──▶ queued
  │                 └─(status: no progress > staleAfterHours)─▶ stalled ──resume──▶ running
  └──cancel──▶ cancelled   (running, blocked, stalled, awaiting_approval, failed'dan da)
```

İzin verilen geçişler (diğerleri hata):

| Kimden | Kime |
|---|---|
| queued | running, cancelled |
| running | blocked, awaiting_approval, failed, stalled, cancelled |
| blocked | running, cancelled |
| stalled | running, cancelled |
| awaiting_approval | done, running, cancelled |
| failed | queued, cancelled |
| done, cancelled | — (son durum) |

Launch başarısız olursa görev `queued`'da kalır ve `error` doldurulur (durum değişmez).

### 5.3 Inbox kaydı — `kb/inbox/<ts>-<session_id>.json`

```json
{
  "session_id": "…",
  "cwd": "C:\\dev\\watchparty",
  "project": "watchparty",
  "task_id": "T20261015-01",
  "transcript_path": "…",
  "reason": "exit",
  "ended": "2026-10-15T21:10:00+03:00",
  "git": {
    "branch": "vlad/T20261015-01",
    "head": "abc1234",
    "recent_commits": [{ "sha": "abc1234", "subject": "…", "date": "…" }],
    "changed_files": ["src/a.ts"]
  },
  "excerpt": [{ "role": "user", "text": "…" }, { "role": "assistant", "text": "…" }],
  "user_message_count": 7
}
```

- `project`: `cwd`'nin bilinen bir proje yolu veya worktree'si altında olup olmadığına bakılarak çıkarılır; bulunamazsa `null`.
- `task_id`: ortam değişkeni `VLAD_TASK_ID`'den; yoksa `null`.
- `recent_commits`: session süresi içindeki (bulunamazsa son 24 saatteki) en fazla 20 commit.
- `excerpt`: son en fazla 6 kullanıcı/asistan metin mesajı, her biri 1000 karakterle kırpılmış. Tool çıktıları dahil edilmez.

### 5.4 Karar günlüğü — `kb/decisions.md`

Ekleme yapılan tek dosya; her karar bir blok:

```
### 2026-10-15 — watchparty — Oda senkronizasyonu WebSocket ile
- **Karar:** …
- **Gerekçe:** …
- **Kaynak:** session <id> / görev <id>
```

### 5.5 Günlük — `kb/journal/<YYYY-MM-DD>.md`

Proje başlıkları altında o gün olanların özeti; her madde kaynak session/görev ID'si taşır.

## 6. CLI — `vlad`

Tüm komutlar `--json` ile makine okunur çıktı verir (skill'ler ve gelecekteki orkestratör için).

| Komut | Yaptığı |
|---|---|
| `vlad scan` | Kök klasörleri tarar; her repo için ham bilgi (yol, README ilk 4 KB, package.json/pyproject vb. manifest özeti, son 20 commit, mevcut kart var mı) döndürür. Kart yazmaz. |
| `vlad project write <slug> --file <md>` | Kartı şemaya göre doğrulayıp yazar |
| `vlad project list` | Kartları listeler |
| `vlad task new --project <slug> --title … --kind dev --body-file <md>` | `queued` görev oluşturur, ID döndürür |
| `vlad task launch <id> [--dry-run]` | Worktree + branch açar, `running` yapar, Launcher'ı çağırır |
| `vlad task log <id> "<mesaj>"` | `## İlerleme`'ye zaman damgalı satır, `updated` günceller |
| `vlad task ask <id> "<soru>"` | `## Sorular`'a ekler, `blocked` yapar |
| `vlad task answer <id> "<cevap>"` | Cevabı ekler, `running` yapar |
| `vlad task report <id> --file <md>` | `## Kapanış raporu`'nu yazar, `awaiting_approval` yapar |
| `vlad task set <id> <state>` | Durum makinesine uygun genel geçiş (approve/cancel/retry/fail) |
| `vlad task cleanup <id>` | `done`/`cancelled` görevin çalışan penceresini kapatır, worktree'sini kaldırır (branch silinmez) |
| `vlad task digested <id…>` | `done` görevlerin kapanış raporunu `/digest`'te işlenmiş olarak işaretler (`digested` alanı) |
| `vlad task list [--state …] [--project …] [--undigested]` | Listeleme; `--undigested`: kapanış raporu işlenmemiş `done` görevler |
| `vlad status` | Tüm aktif görevler; `running` olup `updated` + `staleAfterHours` geçmişse `stalled` yapar |
| `vlad inbox list` / `vlad inbox count` | İşlenmemiş raporlar |
| `vlad inbox done <dosya…>` | Raporları `processed/`'a taşır |
| `vlad decision add --project … --title … --body-file <md>` | Karar günlüğüne ekler |
| `vlad journal append <tarih> --file <md>` | Günlüğe ekler |

Push/PR/merge için ayrı CLI komutu yoktur; VLAD bunları kullanıcı onayından sonra `git`/`gh` ile görevin worktree'sinde yapar.

## 7. Launcher

```ts
interface LaunchRequest {
  taskId: string;
  cwd: string;            // worktree yolu
  prompt: string;         // başlangıç prompt'u
  env: Record<string, string>; // VLAD_TASK_ID vb.
  title: string;          // pencere/sekme başlığı
}
interface LaunchResult { ok: boolean; method: string; detail?: string }
interface Launcher { launch(req: LaunchRequest): Promise<LaunchResult> }
```

`TerminalLauncher`:
- `auto`: `wt.exe` bulunursa `wt -w 0 nt --title <title> -d <cwd> …` ile yeni sekme; yoksa `Start-Process powershell -ArgumentList '-NoExit', …` ile yeni pencere.
- Prompt, kaçış sorunlarını önlemek için geçici bir dosyaya yazılır; terminalde çalışan komut ortam değişkenlerini ayarlayıp `claude "<kısa yönlendirme: prompt dosyasını oku>"` çalıştırır.
- `--dry-run`: çalıştırılacak komutu döndürür, hiçbir şey başlatmaz.

Başlangıç prompt'u (şablon):
> Sen bir VLAD çalışanısın. Görevin: `C:\dev\vlad\kb\tasks\<id>.md`. Önce `vlad-worker` skill'ini yükle ve protokolünü uygula. Yetki seviyen: `<autonomy>`.

## 8. Çalışan protokolü — `vlad-worker` skill'i (global)

1. Görev dosyasını ve ilgili proje kartını oku.
2. Mevcut iş akışını kullan (brainstorming/plan → TDD → review); `autonomy: plan` ise yalnızca planı yaz, `vlad task report` ile onaya sun.
3. Önemli adımlarda `vlad task log <id> "…"`.
4. Kullanıcı kararı gerektiren belirsizlikte `vlad task ask <id> "…"`, ardından VLAD'a bildirim gönder (§9) ve cevabı bekle.
5. `vlad/<id>` branch'inde commit'le. `autonomy: pr` ise push + `gh pr create`. Asla merge etme, asla başka branch'e push etme.
6. Bitince `vlad task report <id>` (ne yapıldı, test sonuçları, açık noktalar), VLAD'a bildirim gönder.

## 9. Haberleşme

- **Doğruluk kaynağı görev dosyasıdır.** Mesajlar yalnızca "durum değişti, dosyaya bak" bildirimidir.
- Bildirim kanalı: Claude Code'un yerel session'lar arası mesajlaşması (`ListAgents` / `SendMessage`). VLAD session'ı sabit, bilinen bir adla çalışır.
- **Spike (planın ilk adımı):** Ayrı bir terminalde açılmış bir session'dan VLAD session'ına `SendMessage` ile güvenilir mesaj gidip gitmediği ve VLAD'ın sabit adla bulunup bulunamadığı denenir. Başarısızsa bildirim kanalı devre dışı kalır; VLAD durumu `/status` ile dosyalardan okur. Tasarımın geri kalanı değişmez.

## 10. Farkındalık

### 10.1 Global SessionEnd hook'u

- Kayıt: `~/.claude/settings.json` → `hooks.SessionEnd` → `node C:/dev/vlad/dist/hooks/session-report.js`.
- Girdi: stdin JSON (`session_id`, `transcript_path`, `cwd`, `reason`).
- `user_message_count < 2` ise kayıt yazılmaz.
- Git bilgisi: `cwd` bir git reposundaysa toplanır; her git komutu 3 sn zaman aşımlı.
- Toplam süre hedefi < 5 sn. LLM çağrısı yok.
- Her hata yakalanır, `kb/logs/hook-<tarih>.log`'a yazılır; süreç her durumda `exit 0` ile çıkar.
- VLAD'ın kendi session'ları da raporlanır (`project: "vlad"`).

### 10.2 VLAD SessionStart hook'u (yalnızca vlad reposunda)

`vlad inbox count` ve `vlad status --summary` çıktısını bağlama ekler: "İşlenmemiş N rapor, M aktif görev (K'si onay bekliyor, L'si takıldı)."

### 10.3 Skill'ler (VLAD reposunda)

| Skill | Akış |
|---|---|
| `/scan` | `vlad scan --json` → her repo için kartı yaz/güncelle (`vlad project write`) → yeni/değişen projeleri kullanıcıya bildir |
| `/delegate` | Proje kartı + ilgili kararlar okunur → görev taslağı (tanım, kabul kriterleri, bağlam) kullanıcıya gösterilir → onayda `vlad task new` → `dev` ise `vlad task launch`; `research` ise arka plan agent'ı çalıştırılır, sonucu `vlad task report` ile yazılır |
| `/status` | `vlad status --json` → özet; `awaiting_approval` görevler için kapanış raporu + diff özeti ve onay seçenekleri (push/PR/merge/değişiklik iste); `stalled` için resume/iptal |
| `/digest` | `vlad inbox list --json` → projelere göre grupla → `journal` + kartların `## Son aktivite`/`## Açık konular`'ı + `decisions` güncellenir → `vlad inbox done` |

## 11. Hata durumları

| Durum | Davranış |
|---|---|
| Hook hatası | Loglanır, session etkilenmez |
| Launcher başarısız | Görev `queued` kalır, `error` doldurulur; VLAD kullanıcıya bildirir |
| Worktree/branch zaten var | `launch` durur, hata döner; VLAD kullanıcıya sorar. Üzerine yazma yok |
| Çalışan çöktü / kapandı | `vlad status` ilerleme kaydı `staleAfterHours`'tan eskiyse `stalled` yapar; VLAD `claude --resume <session_id>` ile aynı worktree'de devam etmeyi veya iptali önerir |
| Geçersiz durum geçişi | CLI hata kodu + izin verilen geçişleri listeler |
| Şemaya uymayan veri | Yazma reddedilir; hangi alanın hatalı olduğu bildirilir |
| Bozuk/okunamayan kb dosyası | Listelemelerde atlanır, uyarı olarak raporlanır |

## 12. Test stratejisi

- **Birim (vitest):** frontmatter okuma/yazma ve şema doğrulama; durum makinesi (tüm geçerli ve geçersiz geçişler); görev ID üretimi; scan (geçici klasörde sahte repolarla); hook ayrıştırıcısı (fixture transcript'lerle; kısa session atlama, kırpma, `project` çıkarımı, hata durumunda `exit 0`); launcher komut üretimi (`--dry-run`, wt var/yok).
- **Entegrasyon:** geçici bir git reposunda `task new → launch --dry-run → log → report → set done → cleanup`.
- **Elle uçtan uca smoke testi:** `/scan` ile watchparty kartı; gerçek bir küçük görev devri; çalışanın raporu; `/status` ile onay; başka bir elle açılmış session'ın `/digest` ile günlüğe girmesi.

## 13. Orkestratör uygulamasına geçiş yolu

- `src/` bir kütüphane olarak yazılır (CLI ince bir sarmalayıcıdır); orkestratör aynı modülleri import eder.
- `SdkLauncher`, Agent SDK ile session başlatarak `Launcher` arayüzünü uygular; mesajlaşma SDK akışına taşınır.
- Skill'ler, `CLAUDE.md` ve agent tanımları SDK'nın ayar kaynakları üzerinden aynen yüklenir.
- `kb/` dosyaları olduğu gibi kullanılabilir veya şemalar üzerinden bir veritabanına aktarılır.

### Spike sonucu (2026-10-15)

- `notify: "sendmessage"` — çalışıyor. Ayrı bir session'dan (`claude -p`, cwd `C:\dev\vlad`) `SendMessage({to: "dev-15"})` ile gönderilen mesaj hedef session'a `<cross-session-message>` olarak ulaştı.
- Session adları otomatik ve sabit değil: `<cwd klasör adı>-<2 hex>` (ör. `vlad-72`, `watchparty-b1`). `ListAgents` çıktısının ilk satırı session'ın kendi adını verir: `This session is <ad> [<ref>]`.
- Bu yüzden VLAD açılışta kendi adını `ListAgents` ile öğrenip `vlad session register <ad>` ile `kb/vlad-session.txt`'ye yazar; çalışanlar `vlad session name` ile okuyup `SendMessage` gönderir. Dosya yoksa veya ad `ListAgents`'ta görünmüyorsa bildirim atlanır (dosya tabanlı durum yeterli).
- Not: Farklı izin modundaki session'lar gelen mesajı kullanıcı onayına bekletebilir; bildirimler yalnızca "görev dosyasına bak" içerdiği için bu kabul edilebilir.
