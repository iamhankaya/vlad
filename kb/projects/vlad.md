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
last_activity: 2026-10-20T15:51:31+03:00
last_scanned: 2026-10-18T22:54:00+03:00
---

## Özet
Kullanıcının projelerinin kalıcı hafızası ve iş dağıtıcısı. `vlad` CLI (TypeScript/Node), `kb/` bilgi tabanı, skill'ler (`/scan`, `/delegate`, `/status`, `/digest`), uzman roller (`roles/`) ve pipeline (yazılım departmanı). Remote: private `iamhankaya/vlad`, ana branch `master`.

## Mimari notlar
- CLI: `src/cli.ts`; çalışan başlatma `src/launcher/terminal.ts` (Windows: PowerShell script'i, WMI ile pencere) ve bulut modu `src/tasks/cloud.ts` (`launcher: cloud`; `auto` `CLAUDE_CODE_REMOTE=true` ile seçer; VLAD `create_session` çağırır).
- Bulut çalışanı `kb/` yazmaz; `[VLAD:*]` transcript işaretleri `vlad task ingest` ile işlenir; bitişte VLAD'a tek seferlik zamanlanmış görevle haber verir, hatırlatma yedek.
- Tasarım dokümanları: `docs/superpowers/specs/` (core, roles, pipeline, cloud).
- `kb/` yalnızca CLI ile yazılır; yerelde `kb:` commit'leri ana branch'e doğrudan gider, bulutta session branch'ine gider ve `master`'a onaylı PR ile alınır (yazmadan önce `origin/master` merge).
- Rol başına model (`model: sonnet`); kartta `repo`, `local_only`, `default_branch`, `exposure`.

## Son aktivite
- 2026-10-20: Son dokunuşlar: C16, C17, `vlad project set` (PR #19). (T20261020-57)
- 2026-10-20: System design iş akışına bağlandı: `/delegate` exposure işareti, tester/developer (PR #17). (T20261020-56)
- 2026-10-20: `exposure` alanı ve architect/analyst sistem tasarımı bölümleri `master`'da (PR #15). (T20261020-53)
- 2026-10-20: Bulut başlatma sağlamlığı (C7), çalışan bitiş bildirimi (C9), fazda çatı bölümü (C15) (PR #13). (T20261020-52)
- 2026-10-20: Bulut kb master senkronu ve `commitKb` push kontrolü (PR #10). (T20261020-51)
- 2026-10-20: Bulut (Linux) desteği `master`'da: cloud launcher, `task ingest` (PR #9). (T20261020-01)
- 2026-10-18: Rol başına model seçimi; tüm roller `model: sonnet`. (T20261018-07)
- 2026-10-18: Designer rolü eklendi (c79e2c3).

## Açık konular
- Bulutta rol skill'leri yüklenmiyor: setup script'e `superpowers` eklenmeli; designer skill'lerinin (`ui-ux-pro-max`, `impeccable`, `design-taste-frontend`) kaynağı kullanıcıdan bekleniyor (C10).
- Bulut ortamında `vlad` CLI kurulumu (setup script / SessionStart hook) yok; VLAD `npm ci && build` ile çalışıyor (B6).
- watchparty kartına `repo` değeri kullanıcıdan bekleniyor.
- Yerel Windows'ta `git pull`, `npm run build`, `vlad install` yapılmalı (bugünkü değişiklikler).
- `list_events` çok sayfalı girdi yalnızca sentetik verilerle test edildi.
- Sistem tasarımı bölümü henüz gerçek bir plan fazında denenmedi; ilk `tam` döngüde architect çıktısının derinliği değerlendirilecek.

