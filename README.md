# VLAD

Claude Code için dosya tabanlı "ana akıl": tüm projelerinin hafızası ve iş dağıtıcısı. Tek bir kalıcı Claude Code session'ı (`C:\dev\vlad`) projeleri `kb/` dosyalarından tanır, geliştirme işlerini git worktree'lerinde açılan görünür çalışan session'larına devreder ve `vlad` CLI ile takip eder.

Tasarım: [`docs/superpowers/specs/2026-10-15-vlad-core-design.md`](docs/superpowers/specs/2026-10-15-vlad-core-design.md)

## Gereksinimler

- Windows, Node.js 22+, git, Claude Code (`claude`)
- İsteğe bağlı: Windows Terminal (`wt`), GitHub CLI (`gh`, PR için)

## Kurulum

```
cd C:\dev\vlad
npm i
npm run build
npm link            # vlad komutunu global PATH'e ekler
vlad install --dry-run   # yapılacakları gösterir, hiçbir şeye dokunmaz
vlad install
```

`vlad install` şunları yapar:
- `~/.claude/settings.json`'u `settings.json.bak-<YYYYMMDDTHHmmss>` olarak yedekler (dosya varsa ve değişiklik gerekiyorsa) ve `hooks.SessionEnd`'e `node "C:/dev/vlad/dist/hooks/session-report.js"` kaydını ekler. Hook `timeout: 10` ile kaydedilir (Claude Code'un SessionEnd varsayılanı 1,5 sn; hook'un git çağrıları ~6 sn sürebilir); zaman aşımı olmadan kayıtlı eski bir girdi yerinde yükseltilir. Diğer ayarlara dokunmaz; tekrar çalıştırmak güvenlidir.
- `global/skills/vlad-worker/` klasörünü `~/.claude/skills/vlad-worker/`'a kopyalar (çalışan protokolü her repoda kullanılabilir olur). Her çalıştırmada hedefteki `vlad-worker` klasörünün üzerine yazılır; orada yaptığınız elle değişiklikler kaybolur.
- `VLAD_CLAUDE_DIR` ortam değişkeni `~/.claude` yerine başka bir klasörü hedefler (test ve deneme için).

Ayarlar `vlad.config.json`'dadır (kök klasörler, yetki seviyesi, `staleAfterHours`, launcher, opsiyonel `maxParallel` — aynı anda en fazla bu kadar `running` dev çalışanı; yoksa sınırsız).

`vlad task ready --parent <id>` sınıra uyan fazları `tasks`, sınır yüzünden bekleyenleri `held_by_limit` olarak verir. `vlad task resume <id>` kesilmiş (`running`/`stalled`) bir çalışan için devam bilgisi üretir: yerelde worktree/branch/kirli ağaç kontrolü ve devam prompt'u, bulutta `send_message` argümanları.

## Günlük kullanım

```
cd C:\dev\vlad
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

**Proje kapısı (`gate`):** proje kartında opsiyonel `gate` alanı projenin tek kapı komutunu tutar (ör. `scripts/gate.sh`, `npm run gate`): `vlad project set <slug> gate "<komut>"`. `/status` entegrasyon doğrulamasını, çalışanlar rapordan önceki koşuyu bununla yapar; tanımlı değilse `/status` uyarır ve `/scan` kart için öneri sorar.

**Bulgu kaydı:** ertelenen/açık noktalar `kb/findings/` altında tutulur: `vlad finding add --project <slug> --severity <kritik|yüksek|orta|düşük|bilgi> --source <görev> --title "<…>" [--detail-file <md>] [--state deferred]`, `vlad finding list [--project] [--state] [--severity] [--json]`, `vlad finding set <id> <open|deferred|fixed|wontfix> [--by <görev>]`. `/digest` kapanış raporlarının açık noktalarını buraya işler; `vlad status --summary` açık kritik/yüksek bulgu sayısını ekler.

**Ekip kuralları:** `tam`/`özellik`'te `sözleşme` fazı (kabul ∥ uygulamadan önce), developer'ın `vlad task ask` ile test itirazı, fazın rapordan önce entegrasyon branch'ini merge edip lint+gate koşması, ara `denetim` + UI öz-kontrolü, auth/yetki/oturum/silme için güvenlik incelemesi, dış API için gerçek fixture ve architect'in paylaşılan dosyalar tablosu (pipeline spec §18).

**Dağıtım provası:** iş dağıtım betiğine/CI'a/altyapıya dokunuyorsa `/delegate` `prova` fazı (`devops` rolü) önerir; devops betiği temiz ortamda (umask 077, `bash -s < script`, pipefail, boş volume, yedek+geri yükleme, ikinci koşu, yetkisiz kullanıcı) prova eder ve `### Prova matrisi` / `### Prova edilemeyenler` raporlar. Kırmızı provada `/status` canlıya almayı önermez.

**Çalışma notları:** pipeline bittikten sonra `/status` kısa bir retro yapar; dersler `vlad project note <slug> "<ders>"` ile kartın `## Çalışma notları` bölümüne yazılır. Çalışanlar ve roller bu bölümü işe başlarken okur.

## Geliştirme

```
npm run build
npx vitest run
npx tsc --noEmit
```

Testler `VLAD_HOME`'u geçici klasöre ayarlar; gerçek `kb/` ve `~/.claude` dosyalarına dokunmaz.
