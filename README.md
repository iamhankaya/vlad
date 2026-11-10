# VLAD

Claude Code için dosya tabanlı "ana akıl": tüm projelerinin hafızası ve iş dağıtıcısı. Tek bir kalıcı Claude Code session'ı (`<vlad-klasörü>`) projeleri `kb/` dosyalarından tanır, geliştirme işlerini git worktree'lerinde açılan görünür çalışan session'larına devreder ve `vlad` CLI ile takip eder.

Tasarım: [`docs/superpowers/specs/2026-10-15-vlad-core-design.md`](docs/superpowers/specs/2026-10-15-vlad-core-design.md)

## Gereksinimler

- Node.js 22+, git, Claude Code (`claude`); beyin Mac veya Windows olabilir (çok makine kurulumu için bkz. `docs/machines-setup.md`)
- İsteğe bağlı: Windows Terminal (`wt`), GitHub CLI (`gh`, PR için)

## Kurulum

```
cd <vlad-klasörü>
npm i
npm run build
npm link            # vlad komutunu global PATH'e ekler
vlad install --dry-run   # yapılacakları gösterir, hiçbir şeye dokunmaz
vlad install
```

`vlad install` şunları yapar:
- `~/.claude/settings.json`'u `settings.json.bak-<YYYYMMDDTHHmmss>` olarak yedekler (dosya varsa ve değişiklik gerekiyorsa) ve `hooks.SessionEnd`'e `node "C:/dev/vlad/dist/hooks/session-report.js"` kaydını ekler. Hook `timeout: 10` ile kaydedilir (Claude Code'un SessionEnd varsayılanı 1,5 sn; hook'un git çağrıları ~6 sn sürebilir); zaman aşımı olmadan kayıtlı eski bir girdi yerinde yükseltilir. Diğer ayarlara dokunmaz; tekrar çalıştırmak güvenlidir.
- `global/skills/*` klasörlerinin tümünü (`vlad-worker` zorunlu, `ci-triage` dahil) `~/.claude/skills/<ad>/`'a kopyalar (çalışan protokolü ve CI skill'i her repoda kullanılabilir olur). Her çalıştırmada hedefteki klasörlerin üzerine yazılır; orada yaptığınız elle değişiklikler kaybolur.
- `VLAD_CLAUDE_DIR` ortam değişkeni `~/.claude` yerine başka bir klasörü hedefler (test ve deneme için).

Ayarlar `vlad.config.json`'dadır (kök klasörler, yetki seviyesi, `staleAfterHours`, launcher (`auto|wt|powershell|cloud|tmux|terminal`; macOS'ta `auto` = `tmux new-session -d -s vlad-<id>`, `terminal` = Terminal.app; `--external` POSIX betik `$TMPDIR/vlad/<id>.sh` + `bash <betik>` döner; `close-window`/`cleanup` tmux oturumunu kapatır), opsiyonel `maxParallel` — aynı anda en fazla bu kadar `running` dev çalışanı; yoksa sınırsız; çok makine alanları (kök `consoles`, `workerSilentMinutes`; makine başına `agent.bind`) `docs/machines-setup.md` §1'de; opsiyonel `workerAutoCompact` — çalışanların `claude --autocompact` eşiği, ör. `"300k"`, aralık 100000–1000000, `k`/`M` eki; yerel launch, `task launch --external` ve `task resume --external` betiklerine girer, bulutta karşılığı yok).

`vlad task ready --parent <id>` sınıra uyan fazları `tasks`, sınır yüzünden bekleyenleri `held_by_limit` olarak verir. `vlad task resume <id>` kesilmiş (`running`/`stalled`) bir çalışan için devam bilgisi üretir: yerelde worktree/branch/kirli ağaç kontrolü ve devam prompt'u, bulutta `send_message` argümanları.

## Yeni makine / arkadaş kurulumu (`vlad setup`)

`vlad setup` bir makineyi sıfırdan hazırlar; `vlad setup --check` salt okuma doktordur (hangi parça eksik/eski/çakışan, düzeltme komutu). Kişisel veriler tracked `vlad.config.json`'a değil gitignored `vlad.config.local.json`'a yazılır (tracked dosyanın üstüne sığ birleşir, `null` anahtarı siler); sırlar (`vlad.local.json` anahtarları) git'e ve çıktıya girmez. Arkadaş kurulumu **boş kb** ile başlar; sizin kartlarınız/kararlarınız taşınmaz.

Ön koşul: Node 22+, git 2.38+, `claude`, macOS/Windows için tmux (Mac) / PowerShell (Windows). Linux: işçi deneysel, beyin desteklenmez.

**1. Tek makine (Mac ya da Windows)**
```
git clone <vlad-repo-url> ~/dev/vlad && cd ~/dev/vlad     # Windows: <vlad-klasörü>
npm i && npm run build
node dist/cli.js setup --answers cevaplar.json --yes      # Windows: node dist\cli.js setup ...
node dist/cli.js setup --check
```
`cevaplar.json` örneği (anahtarlar `vlad setup --help` ve `src/setup/questions.ts`; sır konmaz):
```
{"role":"brain","machines":"single","kb":{"mode":"local","dir":"~/dev/vlad-kb"},"roots":["~/dev"]}
```
TTY'de `--answers` vermezseniz sihirbaz soruları sorar. `kb.mode`: `local` (yerel git), `path` (var olan klasör), `existing` (var olan repoyu klonla; `kb.remote`), `github-new` (gh ile yeni **private** repo; yalnız `--confirm kb-repo-create` ile, ilk push ayrıdır).

**2. İkinci makine (beyin + işçi)**
- Beyinde: `vlad setup --answers beyin.json` (`"machines":"multi","machine":{"name":"mac","agent":{"host":"<özel LAN IP>"}},"keys":"generate","confirm":["keygen"]`), sonra `vlad setup --add-worker windows --host <işçi IP> --os win32`, anahtarı `vlad agent keygen windows --show` ile alın.
- İşçide: `vlad setup --answers isci.json --join mac --brain-host <beyin IP> --brain-os darwin` ve anahtarı stdin'den verin (`printf %s "$ANAHTAR" | vlad setup --answers isci.json --join mac ...`; `--answers` dosya yolu olmalı, `-` stdin'i anahtara bırakın). Agent adresleri yalnız özel ağ (RFC1918/loopback) olabilir.
- Doğrulama: iki uçta `vlad setup --check`, beyinde `vlad machine list` / `vlad machine ping <ad>`.

**3. Sonradan**
- `git pull` sonrası: `npm i && npm run build && vlad setup --upgrade` (global skill farkı gösterilir; yerel değişiklik `.bak-` olarak yedeklenir).
- Geri alma: `vlad setup --uninstall hooks|global-skills|config` (yalnız VLAD'ın yazdığı girdiler; kb, anahtarlar ve kendi izinleriniz dokunulmaz).
- `--dry-run` hiçbir şeye dokunmaz; yeniden koşu idempotenttir (zaten güncel ise hiçbir şey yazılmaz). `~/.claude/settings.json` değişiminden önce `settings.json.bak-<zaman>` alınır; mevcut ayarlarınız (model, hook, izin, autoMode) silinmez. Çalışan push/CI izinleri ve `additionalDirectories` yalnız `"perms":true`/`"claudedirs":true` **ve** `"confirm":["permissions-write"]` ile yazılır; geniş kalıp (`Bash(*)`) yazılmaz. `vlad install` geri uyum için durur.

## Günlük kullanım

```
cd <vlad-klasörü>
claude
```

Açılışta SessionStart hook'u `İşlenmemiş N rapor, M aktif görev (…, F hatalı)` özetini bağlama ekler; VLAD buna göre `/digest` veya `/status` önerir.

| Skill | Ne yapar |
|---|---|
| `/scan` | Repoları tarar, proje kartlarını yazar/günceller |
| `/delegate` | Görev taslağı → onay → `vlad task new` → çalışanı başlatır |
| `/status` | Aktif görevler; onay bekleyenler için rapor + diff, push/PR/merge onayı |
| `/digest` | Session raporlarını günlüğe, kartlara ve karar günlüğüne işler |

Push, PR ve merge her zaman açık onayınla yapılır.

**Proje kapısı (`gate`):** proje kartında opsiyonel `gate` alanı projenin tek kapı komutunu tutar (ör. `scripts/gate.sh`, `npm run gate`): `vlad project set <slug> gate "<komut>"`. `/status` entegrasyon doğrulamasını, çalışanlar rapordan önceki koşuyu bununla yapar; bulut çalışanının prompt'una da satır içi girer (entegrasyon öncesi `git merge vlad/<çatı>` kuralıyla birlikte); tanımlı değilse `/status` uyarır ve `/scan` kart için öneri sorar.

**Bulgu kaydı:** ertelenen/açık noktalar `kb/findings/` altında tutulur: `vlad finding add --project <slug> --severity <kritik|yüksek|orta|düşük|bilgi> --source <görev> --title "<…>" [--detail-file <md>] [--state deferred]`, `vlad finding list [--project] [--state] [--severity] [--json]`, `vlad finding set <id> <open|deferred|fixed|wontfix> [--by <görev>]`. `/digest` kapanış raporlarının açık noktalarını buraya işler; `vlad status --summary` açık kritik/yüksek bulgu sayısını ekler.

**Ekip kuralları:** `tam`/`özellik`'te `sözleşme` fazı (kabul ∥ uygulamadan önce), developer'ın `vlad task ask` ile test itirazı, fazın rapordan önce entegrasyon branch'ini merge edip lint+gate koşması, ara `denetim` + UI öz-kontrolü, auth/yetki/oturum/silme için güvenlik incelemesi, dış API için gerçek fixture ve architect'in paylaşılan dosyalar tablosu (pipeline spec §18).

**Dağıtım provası:** iş dağıtım betiğine/CI'a/altyapıya dokunuyorsa `/delegate` `prova` fazı (`devops` rolü) önerir; devops betiği temiz ortamda (umask 077, `bash -s < script`, pipefail, boş volume, yedek+geri yükleme, ikinci koşu, yetkisiz kullanıcı) prova eder ve `### Prova matrisi` / `### Prova edilemeyenler` raporlar. Kırmızı provada `/status` canlıya almayı önermez.

**Çalışma notları:** pipeline bittikten sonra `/status` kısa bir retro yapar; dersler `vlad project note <slug> "<ders>"` ile kartın `## Çalışma notları` bölümüne yazılır. Çalışanlar ve roller bu bölümü işe başlarken okur.

## kb deposu (ayrı private repo)

`kb/` ayrı bir private repoda tutulur: `<kullanıcı>/vlad-kb`. vlad CLI kb'yi şu sırayla bulur: `VLAD_KB_DIR` ortam değişkeni → `vlad.config.json`'daki `kbDir` (VLAD_HOME'a göre göreli ya da mutlak; varsayılan config `"../vlad-kb"`) → geriye uyum için `<VLAD_HOME>/kb`. `schemas/` ve `roles/` VLAD_HOME'da kalır.

Kurulum: Windows'ta `git clone https://github.com/<kullanıcı>/vlad-kb <kb-klasörü>`; Linux/bulutta `git clone https://github.com/<kullanıcı>/vlad-kb ~/vlad-kb` (VLAD_HOME `~/vlad` ise aynı göreli yol). Klon yoksa CLI "kb deposu bulunamadı" hatası ve klon komutunu verir.

kb reposunun `.gitignore`'ı şu satırları içermelidir (yoksa `vlad kb commit` uyarır):
```
inbox/
logs/
vlad-session.txt
.vlad.lock
```

## Geliştirme

```
npm run build
npx vitest run
npx tsc --noEmit
```

Testler `VLAD_HOME`'u geçici klasöre ayarlar; gerçek `kb/` ve `~/.claude` dosyalarına dokunmaz.
