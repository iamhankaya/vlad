# D0A spike notları (T20261024-98)

Tarih: 2026-10-24. Ortam: bulut çalışanı (Linux), Claude Code 2.1.310, `claude auth` = oauth_token, `gh` kimliği `iamhankaya/vlad` üzerinde admin. Fixture'lar: `contract/fixtures/external/` (`MANIFEST.json`; her dosyada `_fixture_header` satırı/alanı). Hepsi **real**; yapılamayanlar MANIFEST `not_captured`'da.

## D0.1 stream-json olay türleri (gerçek gözlem)
`claude -p --output-format stream-json --verbose` satır başına bir JSON verir; `type`/`subtype` envanteri:
`active_goal`, `autocompact_state` (her turun başı), `system/init` (cwd, session_id, tools, model, permissionMode, slash_commands, skills, agents, plugins, claude_code_version…), `system/status`, `system/thinking_tokens`, `system/post_turn_summary` (status_category, needs_action), `system/permission_denied` (tool_name, tool_use_id, decision_reason_type, message), `system/task_summary`, `system/vcs_state_changed`, `system/compact_boundary`, `rate_limit_event`, `assistant` (message.content[]: text|tool_use|thinking), `user` (tool_result), `stream_event` (yalnız `--include-partial-messages`: message_start/content_block_*/message_delta/message_stop), `result` (`success` | `error_during_execution`; alanlar: result, is_error, num_turns, session_id, total_cost_usd, usage, modelUsage, permission_denials[], terminal_reason, stop_reason).
- Ayrıştırıcı **bilinmeyen `type`/`subtype`'ı yok saymalı**; sürümler arası olay seti değişir.
- Tur sonu işareti = `result`. Ek: `post_turn_summary` ondan hemen önce gelir.

## `--resume`
- Çok tur: `--resume <session_id>` aynı `session_id`'yi korur (3 tur doğrulandı; model önceki turları hatırladı). Her turda yeni `system/init` gelir.
- **Tuzak:** çalışanın ortamından miras kalan `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_REMOTE_*` / `CLAUDE_SESSION_INGRESS_TOKEN_FILE` değişkenleri alt `claude` sürecinde `session_id`'yi miras kılar ve ana oturuma yazabilir. Launcher/ChatTurnRunner alt süreci **temiz env** ile başlatmalı (bu değişkenleri `env -u`).
- Stdin bağlı değilse 3 sn sonra uyarı verir ("no stdin data received"); `stdin`'i `/dev/null`'a yönlendir.
- Geçersiz id: stdout'ta tek `result` (`subtype:error_during_execution`, `is_error:true`, num_turns 0), stderr `No conversation found with session ID: …`, **çıkış kodu 1** → S11a "resume fallback" bu imzayla tetiklenir.
- Kalıcı süreç (`--input-format stream-json`, stdin'e `{"type":"user","message":{"role":"user","content":"…"}}` satırları): iki mesaj aynı süreçte işlendi, aynı `session_id`, her biri kendi `init…result` bloğuyla; stdin EOF'ta temiz çıkış (rc 0). **D0A.1 olumlu** → S11x mümkün.
- `/compact` `-p` içinde çalışır: `system/compact_boundary` + `user` satırları, `result.success` (boş `result`).

## Kota / sınır olayı
`rate_limit_event.rate_limit_info`: `status` (gözlenen: `allowed`), `rateLimitType` (`five_hour`), `resetsAt` (epoch sn), `overageStatus`, `isUsingOverage`, `unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt,status}`. **Limit aşılmış biçim gözlenemedi** (yapılamadı: sınırı zorlamadık). Çıkarım: S11a `status !== "allowed"` ve `utilization` yüksekse `quota` durumu üretir, bilinmeyen değerlerde elle `quota set`'e düşer; `result.is_error` ve `terminal_reason` ikinci sinyaldir. Abonelik koşulu teyidi yapılamadı (kullanıcıya).

## D0.2 ASK → çıkış → ANSWER → `--resume` ve allowlist
- ASK: model satır başında `[VLAD:ASK #1] …` yazıp turu bitirdi (`result.success`, `session_id` çıkarıldı). Cevap `--resume <sid>` + `[VLAD:ANSWER #1] …` ile işlendi; bağlam korundu. S2b `session_id`'yi `result` satırından almalı.
- `--permission-mode acceptEdits` + `--allowedTools "Bash(git status:*)" … "Bash(npm:*)"` + `--disallowedTools "Bash(git push:*)"` sonuçları:
  - `git status/log/add/commit`, `node --version`, `npm --version`: **çalıştı**.
  - `git push`: **engellendi** (`permission_denied`, `subcommandResults`); deny kuralı bileşik komutta da tutar.
  - allowlist dışı `curl`: **engellendi**; `result.permission_denials[]` dolar (tool_input ile).
  - `cd X; echo > f` gibi **cd+yönlendirme içeren bileşik komut** otomatik reddedildi (`decision_reason_type: other`) → çalışan komutları ayrı ve cd'siz yazmalı.
  - **Dikkat:** allowlist'te olmayan `rm -rf a.txt` `acceptEdits` altında **çalıştı** (cwd içindeki dosya silme/yazma kabul edilir). Yıkıcı silmeyi engellemek için `--disallowedTools "Bash(rm:*)"` açıkça gerekir. Güvenlik etkili seçim: S2b'de karar `### Açık noktalar`.
  - `vlad` ve `gradle` komutları bu ortamda kurulu olmadığı için sınanmadı (yapılamadı); kural biçimi `Bash(vlad:*)` aynıdır.

## D0.5a GitHub REST
Gerçek: `GET /pulls/{n}` (PR #42), liste, check-runs, birleşik durum, 404. Yapılamadı (neden MANIFEST'te): test PR açma (izin sistemi reddetti; protokol PR açmayı yasaklıyor), dolayısıyla taze PR'da `mergeable:null`, check-run yazma, `PUT …/merge` 200/405/409/422, installation token.
- Gözlenen: birleşmiş PR'da `mergeable: null`, `mergeable_state: "unknown"`, `merged: true`, `state: closed` → `null` yalnız "hesaplanıyor" demek değildir; S9b `merged/state`'i önce kontrol etmeli, `null` kararı (2 sn × 3 deneme → `mergeable_unknown`) açık PR'a uygulanmalı ve **doğrulanmadı**.
- `GET /commits/{sha}/check-runs`: check-run yoksa `{"total_count":0,"check_runs":[]}` (200). Boş = "geçti" sayılmamalı.
- 404 gövdesi: `{"message":"Not Found","documentation_url":…,"status":"404"}` (status alanı string).
- `GET /rulesets` özel depoda 403: "Upgrade to GitHub Pro or make this repository public" → D0.5b: ruleset bu planda kullanılamıyor, sıkı kapı yalnız sunucu tarafında kalır.
- **S9b kabulü:** 200/405/409/422 gerçek fixture'ı yok → plana göre S9b'de bu maddeler "karşılanmadı"; kullanıcı onaylı test PR'ı (tek seferlik, ana branch'e merge'siz) ile tamamlanmalı.

## S2b / S9b / S11a çıkarımları
- S2b `stream.ts`: `result` = tur sonu; `session_id` oradan; bilinmeyen olay yok sayılır; `permission_denials` boş değilse çalışan "takıldı" ile ayrılır.
- S11a: temiz env, stdin kapalı, `--resume` hata imzası (rc 1 + `error_during_execution`), kalıcı süreç seçeneği çalışıyor (EOF ile kapanır).
- S9b: `merged` önce, `mergeable` ikinci; check-runs boş ≠ yeşil.
