---
slug: vlad
name: VLAD
path: C:\dev\vlad
exposure: local
repo: iamhankaya/vlad
default_branch: master
stack:
  - typescript
  - node
status: active
autonomy: commit
last_activity: 2026-10-18T22:54:00+03:00
last_scanned: 2026-10-18T22:54:00+03:00
---

## Özet
Kullanıcının projelerinin kalıcı hafızası ve iş dağıtıcısı. `vlad` CLI (TypeScript/Node), `kb/` bilgi tabanı, skill'ler (`/scan`, `/delegate`, `/status`, `/digest`), uzman roller (`roles/`) ve pipeline (yazılım departmanı). Remote: private `iamhankaya/vlad`, ana branch `master`.

## Mimari notlar
- CLI: `src/cli.ts`; çalışan başlatma `src/launcher/terminal.ts` (PowerShell script'i, WMI ile pencere).
- Tasarım dokümanları: `docs/superpowers/specs/` (core, roles, pipeline).
- `kb/` yalnızca CLI ile yazılır; `kb:` commit'leri ana branch'e doğrudan gider.

## Son aktivite
- 2026-10-18: Designer rolü eklendi (c79e2c3).

## Açık konular
- Çalışan modeli rol bazında seçilebilsin (Sonnet ile limit tasarrufu).
