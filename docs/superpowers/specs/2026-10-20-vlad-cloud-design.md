# VLAD bulut (Linux) desteği — tasarım notu

Çatı: T20261020-01. Spec: T20261020-02. Uygulama: T20261020-04. Kararlar: `kb/decisions.md` → 2026-10-20 "VLAD bulut çalışma modeli".

## 1. Amaç

VLAD bulut Claude Code ortamında (Linux) çalışabilsin: dev görevinin çalışanı ayrı bir bulut session'ı olarak açılır, VLAD izler, `kb/`'ye yalnızca VLAD yazar. Windows (`wt`/`powershell`) akışı değişmez.

## 2. Mod seçimi

`vlad.config.json` → `launcher: auto | wt | powershell | cloud`.

| launcher | platform | sonuç |
|---|---|---|
| `cloud` | herhangi | cloud |
| `auto` | Windows | terminal (`wt`, yoksa `powershell`) — bugünkü davranış |
| `auto` | Windows dışı, `CLAUDE_CODE_REMOTE=true` | cloud |
| `auto` | Windows dışı, bulut yok | açık hata (`--dry-run` terminal komutunu yine yazdırır) |
| `wt`/`powershell` | herhangi | terminal |

Bulut algılama: `CLAUDE_CODE_REMOTE=true` (`src/kb/env.ts`, `src/launcher/mode.ts`).

## 3. Proje kartı

Opsiyonel alanlar (mevcut kartlar geçerli kalır):
- `repo: owner/name` — bulutun çalışacağı GitHub reposu. `path` bulutta kullanılmaz (`C:\dev\…`).
- `local_only: true` + `local_only_reason` — bulutta başlatılamaz (ör. DiskPilot/WPF).
- `gate: <komut>` — projenin tek kapı komutu (bulut/yerel fark etmez); bkz. pipeline spec §14.

## 4. `vlad task launch --json` (cloud)

`prepareCloudLaunch` (`src/tasks/cloud.ts`): yerel worktree/terminal yok. Görev `running` olur, `branch=vlad/<id>`, `worktree=null`. Çıktı: `repo`, `source_url`, `source_revision`/`base_branch` (pipeline fazında `vlad/<çatı-id>`, değilse kartın opsiyonel `default_branch`'i, yoksa `master`), `outcome_branch`, `integration {branch, needs_remote_create, from}` (`needs_remote_create` her launch'ta `git ls-remote https://github.com/<repo>.git refs/heads/<branch>` ile hesaplanır; çatının `branch` alanına güvenilmez, erişilemezse `true` + `warnings`), `model` (rolden, yoksa `null`), `title`, `tags`, `permission_mode`, `prompt`, `next`.

Prompt görev bölümlerini (`## Tanım`, `## Kabul kriterleri`, `## Bağlam`), pipeline fazında çatı görevin aynı üç bölümünü ("## Çatı görev (<id>)"; `### Fazlar`/`### Kapılar` hariç), rol dosyasının gövdesini, `depends_on` görevlerin `## Kapanış raporu`'nu ve "VLAD bulut protokolü"nü satır içi taşır (çalışanın `kb/`/CLI erişimi yoktur).

`needs_remote_create`: çatı görevin `branch` alanı entegrasyon branch'ine eşit değilse `true`. Launch çatının `branch`'ini kaydeder; VLAD branch'i remote'ta hemen oluşturur (`create_branch`), sonraki fazlarda `false` döner.

Hata (kartta `repo` yok, `local_only`, dev değil, çatı kapalı, rol uyumsuz): görev `queued` kalır, `error` dolar. `create_session` başarısız olursa görev `running`'den `queued`'a dönemez → `failed`.

Görev ID'leri bulutta günlük `51`'den başlar (`T20261020-51`), yerel VLAD ile çakışmaz.

## 5. Transcript biçimi ve `vlad task ingest`

Çalışan, yanıtlarında satır başında (kod çitinin dışında) işaretler yazar; `#n` çalışan başına artan sıra numarasıdır:

```
[VLAD:LOG #n] <adım>
[VLAD:ASK #n] <soru>            (turu bitirir; cevap: [VLAD:ANSWER #n])
[VLAD:REPORT #n branch=vlad/<id> head=<sha>] … [VLAD:END #n]
[VLAD:FAIL #n] <neden>
```

`vlad task ingest <id> [--file events.json|-] [--remote-head <sha>]`:
- Girdi `list_events` çıktısı. Gerçek şekil: araç sonucu bir metin zarfı içinde `{"ccr": {"data": [...], "has_more": bool, "first_id", "last_id"}}` döner; olay türü anahtar adıdır (`{"assistant": {"internal_anthropic_catchall": {"message": {"content": [{"type":"text","text":…}]}}}}`, `user`, `result` aynı biçimde). Ayrıştırıcı ayrıca düz diziyi, `{data|events|items}` sarmalayıcısını ve JSONL'i kabul eder; zarf metninde `[`/`{` olsa da gömülü JSON'u bulur.
- Sayfalama: dosyada ardışık birden çok `{ccr:{…}}` nesnesi olabilir; `data` dizileri birleştirilir. Son sayfada `has_more: true` ise `warnings`'e "sayfa eksik olabilir" eklenir. Çalışan bitişte tüm işaretlerini (LOG'lar dahil) son tur mesajında tekrar eder; böylece son sayfa yeterlidir.
- Yalnızca assistant olaylarının metni okunur (user olayları prompt'taki örnekleri içerir). `result` olayı son turun metnini tekrar eder; yalnızca hiç assistant olayı tanınmazsa yedek olarak okunur (çift işleme yok).
- LOG → `vlad task log`; ASK → `blocked`; FAIL → log + `failed`; REPORT → `## Kapanış raporu` + `awaiting_approval`.
- Idempotent: işlenen her işaret görev dosyasına `[cloud #n]` etiketiyle yazılır (`## İlerleme`, ASK için `## Sorular`); etiketi bu bölümlerde taşıyan seq atlanır. Kapanış raporu gövdesindeki `[cloud #n]` metni sayılmaz.
- REPORT'ta `branch=` `vlad/<id>` olmalı ve `head=`, remote `vlad/<id>` ucuyla eşleşmeli (`git ls-remote https://github.com/<repo>.git`, veya `--remote-head`; kısa sha kabul). Eşleşmez/okunamazsa `awaiting_approval` yapılmaz, uyarı verilir; eşleşen rapor sonra tekrar ingest edilince işlenir.
- Geçersiz geçiş (ör. blocked iken yeni ASK) uyarıdır; diğer işaretler işlenmeye devam eder.

## 6. İzleme, kapılar, kb

- **Hızlı yol (T20261020-52):** prompt VLAD'ın session ID'sini (`CLAUDE_CODE_REMOTE_SESSION_ID`) taşır; çalışan REPORT/ASK/FAIL sonrası VLAD session'ına ~1 dk sonrası için tek seferlik zamanlanmış görev kurar ("VLAD görev <id>: <durum> — ingest et"); kuramazsa yalnızca LOG yazar. Bildirim gelince VLAD ingest eder ve o görevin hatırlatmasını iptal eder.
- **Yedek:** `/status` her çağrıda `get_session`/`list_events` → `ingest`. Sürekli yoklama yok; bunun yerine her bulut çalışanı başlatıldıktan sonra VLAD `send_later` ile ~15 dk sonrasına tek seferlik hatırlatma kurar, çalışan bitmemişse yeniden kurar (çalışan başına en fazla 4 deneme) — karar günlüğü "Bulut çalışanları için tek seferlik hatırlatmalar" (2026-10-20), 3. karar maddesini günceller. Yalnızca bulut modu.
- Bulut ortamında `markStale` (`vlad status`, SessionStart hook) yalnızca `session_id`'si `session_` önekli (bu bulut VLAD'ın açtığı) görevleri `stalled` yapar; yerel görevlere dokunmaz. Yerelde davranış aynı.
- Merge kapıları GitHub PR ile: PR aç (onay), kullanıcı onaylar, VLAD `merge_pull_request`. Son kapı ayrı PR + onay.
- Çalışan yalnızca `vlad/<id>`'ye push eder (kalıcı kural).
- Bulut VLAD'ın `kb:` commit'leri session branch'ine gider; `commitKb --push` upstream yoksa `git push -u origin <branch>` ile push eder (kb dışı push edilmemiş commit varsa yine push etmez; "push edilmemiş" = hiçbir remote-tracking branch'ten erişilemeyen). `master`'a onaylı merge.

### kb senkronu (kriter 9)

Bulut VLAD `kb/`'ye yazmadan önce (status, delegate, digest akışlarının başında, bir kez) `git fetch origin master` + `git merge origin/master` çalıştırır; böylece başka session'ların/yerelin `master`'a aldığı kb değişiklikleri üzerine yazılır. Çakışmada `git merge --abort` ile temizlenir, akış durur ve kullanıcıya bildirilir. Yerelde atlanır. `vlad kb sync` komutu eklenmedi (isteğe bağlıydı).

## 7. Windows güvencesi

Terminal akışı (`launchTask`, `TerminalLauncher`, `closeWorkerWindow`) değişmedi. `auto` Windows'ta aynı seçimi yapar. Cloud görevi için `cleanupTask` worktree `null` olduğundan hiçbir şey yapmaz.

## 8. Test

`test/cloud/` altında birim testler: mod seçimi, şemalar, `prepareCloudLaunch`, ID aralığı, `ingest`, `commitKb` upstream'siz push, CLI. `vitest.config.ts` testlerde `CLAUDE_CODE_REMOTE`'u boşaltır; bulut davranışı test başına açılır.

## 9. Bilinen sınırlar

- Varsayılan branch adı `default_branch` kartında yoksa `master` varsayılır.
- `create_session`'ın `outcome_branch`'i remote'ta yoksa kendisinin oluşturduğu, ASK sonrası `send_message`'ın idle çalışanı uyandırdığı ve GitHub MCP branch/PR/merge araçlarının çalıştığı doğrulanmadı.
