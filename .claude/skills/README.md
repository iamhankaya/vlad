# Proje skill'leri

Bu dizinde iki tür skill var:

- **VLAD'ın kendi skill'leri:** `scan`, `delegate`, `status`, `digest`.
- **Rol skill'leri (vendored):** bulut çalışan session'ları eklenti (plugin) kuramadığı için rollerin `skills:` alanındaki skill'ler buraya kopyalandı (vlad kartı, açık konu C10). Claude Code bu dizindeki skill'leri her session'da otomatik yükler. Kopyalar `iamhankaya/medialog` reposundaki vendored kopyalardan alındı; içerik değiştirilmedi. Güncellemek için kaynaktan yeniden kopyalayın.

| Skill | Kaynak | Commit | Lisans |
|---|---|---|---|
| `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review` | github.com/obra/superpowers (`skills/`) | bb92a77 | MIT |
| `ui-ux-pro-max` | github.com/nextlevelbuilder/ui-ux-pro-max-skill (`.claude/skills/ui-ux-pro-max`) | 56ea9cf | MIT |
| `impeccable` | github.com/pbakaus/impeccable (`plugin/skills/impeccable`) | dad8dbb | Apache-2.0 (NOTICE.md dahil) |
| `security-audit` | github.com/cloudflare/security-audit-skill (`skills/security-audit`) | c1c8a8c | MIT |
| `design-taste-frontend` | github.com/Leonxlnx/taste-skill (`skills/taste-skill`) | 6010f91 | MIT |

Notlar:
- superpowers skill'leri burada `superpowers:` öneki olmadan yüklenir: rollerdeki `superpowers:test-driven-development`, bu dizinde `test-driven-development` adıyla bulunur.
- `brainstorming`, `writing-plans` (architect) ve `subagent-driven-development` (developer, isteğe bağlı) henüz kopyalanmadı.
- Bu kopyalar yalnızca VLAD reposunda açılan session'lara yüklenir. Başka bir projedeki bulut çalışanının skill'leri kullanabilmesi için skill'lerin o projenin reposunda da bulunması gerekir (medialog'da olduğu gibi).
- Testler (`vitest`) yalnızca `test/**` altını tarar; buradaki `*.test.cjs` dosyaları koşulmaz.
