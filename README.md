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
- `~/.claude/settings.json`'u `settings.json.bak-<YYYYMMDDTHHmmss>` olarak yedekler (dosya varsa ve değişiklik gerekiyorsa) ve `hooks.SessionEnd`'e `node "C:/dev/vlad/dist/hooks/session-report.js"` kaydını ekler. Diğer ayarlara dokunmaz; tekrar çalıştırmak güvenlidir.
- `global/skills/vlad-worker/` klasörünü `~/.claude/skills/vlad-worker/`'a kopyalar (çalışan protokolü her repoda kullanılabilir olur).

Ayarlar `vlad.config.json`'dadır (kök klasörler, yetki seviyesi, `staleAfterHours`, launcher).

## Günlük kullanım

```
cd C:\dev\vlad
claude
```

Açılışta SessionStart hook'u `İşlenmemiş N rapor, M aktif görev (…)` özetini bağlama ekler; VLAD buna göre `/digest` veya `/status` önerir.

| Skill | Ne yapar |
|---|---|
| `/scan` | Repoları tarar, proje kartlarını yazar/günceller |
| `/delegate` | Görev taslağı → onay → `vlad task new` → çalışanı başlatır |
| `/status` | Aktif görevler; onay bekleyenler için rapor + diff, push/PR/merge onayı |
| `/digest` | Session raporlarını günlüğe, kartlara ve karar günlüğüne işler |

Push, PR ve merge her zaman açık onayınla yapılır.

## Geliştirme

```
npm run build
npx vitest run
npx tsc --noEmit
```

Testler `VLAD_HOME`'u geçici klasöre ayarlar; gerçek `kb/` ve `~/.claude` dosyalarına dokunmaz.
