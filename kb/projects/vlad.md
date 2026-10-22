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
last_activity: 2026-10-22T16:20:11+03:00
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
- 2026-10-22: **Yazılım ekibi iyileştirmeleri** `master`'da (PR #32, b8cbf11): `gate` + test hijyeni, `vlad finding` + `project note` + retro, `maxParallel` + `task resume`, `devops` rolü + `prova`, `sözleşme` fazı/test itirazı/entegrasyon kontrolü/erken denetim; rol skill'leri `.claude/skills`'e vendored. vitest 424/0 kırmızı. (görev T20261022-55)
- 2026-10-20: Son dokunuşlar: C16, C17, `vlad project set` (PR #19). (T20261020-57)
- 2026-10-20: System design iş akışına bağlandı (PR #17). (T20261020-56)
- 2026-10-20: `exposure` alanı ve architect/analyst sistem tasarımı bölümleri (PR #15). (T20261020-53)
- 2026-10-20: Bulut başlatma sağlamlığı (C7), çalışan bitiş bildirimi (C9), fazda çatı bölümü (C15) (PR #13). (T20261020-52)
- 2026-10-20: Bulut kb master senkronu ve `commitKb` push kontrolü (PR #10). (T20261020-51)
- 2026-10-20: Bulut (Linux) desteği: cloud launcher, `task ingest` (PR #9). (T20261020-01)
- 2026-10-18: Rol başına model seçimi; tüm roller `model: sonnet`. (T20261018-07)
- 2026-10-18: Designer rolü eklendi (c79e2c3).

## Açık konular
- **Açık bulgular:** düşük: F-vlad-002 yeni kurallar ilk gerçek pipeline'da sınanmalı. bilgi: F-vlad-003 retro adımının CLI komutu yok.
- Rol skill'leri (superpowers 8 skill, security-audit, 3 tasarım skill'i) VLAD reposunda `.claude/skills` altında (C10; PR #36); başka projelerin bulut çalışanları için skill'ler o projenin reposunda olmalı (medialog'da var).
- Bulut ortamında `vlad` CLI kurulumu (setup script / SessionStart hook) yok; VLAD `npm ci && build` ile çalışıyor (B6).
- watchparty kartına `repo` değeri kullanıcıdan bekleniyor.
- Yerel Windows'ta `git pull`, `npm run build`, `vlad install` yapılmalı (2026-10-20 ve 2026-10-22 değişiklikleri).
- `list_events` çok sayfalı girdi yalnızca sentetik verilerle test edildi.
- Sistem tasarımı bölümü henüz gerçek bir plan fazında değerlendirilmedi; ilk `tam` döngüde architect çıktısının derinliği değerlendirilecek.

## Çalışma notları
- 2026-10-22: Bulut çalışanının bitiş bildirimi (create_trigger) bazen izin sistemince reddediliyor, bazen ~8 dk gecikiyor; yedek send_later hatırlatmasını atlama, /status ile kendin kontrol et (T20261022-58, -62).
- 2026-10-22: Bulut prompt'unda önceki fazın raporunu özet olarak vermek yeterli; çalışan kodun tamamını entegrasyon branch'inden okuyor (T20261022-55).
- 2026-10-22: Skill/rol kurallarının yalnız metin düzeyinde test edilmesi yetmiyor; doğrulama fazının uçtan uca testleri 3 haneli ID ve bulut prompt eksiği gibi gerçek hatalar buldu (T20261022-61).
- 2026-10-22: Rol skill'leri artık .claude/skills altında (vendored); başka projeye bulut çalışanı gönderirken skill'lerin o projenin reposunda olup olmadığını kontrol et (T20261022-55).
- 2026-10-22: Digest'te raporun açık noktasını bulgu olarak açmadan önce sonraki görevlerde/projenin ana branch'inde kapanıp kapanmadığını kontrol et; ilk digest'te kapanmış maddeler (F-medialog-002, -005) açık yazıldı (2026-10-22).
