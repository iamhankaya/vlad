# VLAD Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Görevler bir çatı (`pipeline`) görevin altında fazlar olarak, bağımlılıklarıyla ve ortak bir entegrasyon branch'iyle yürütülebilsin; roller skill bağlasın; skill'ler döngü seçip pipeline'ı yönetsin.

**Architecture:** Görev frontmatter'ına `parent`, `depends_on`, `phase` ve `kind: pipeline` eklenir; CLI bunları doğrular ve `task ready` ile başlatılabilir fazları verir. `launchTask` çocuk görevin worktree'sini `vlad/<parent>` entegrasyon branch'inden açar (gerekirse onu ve worktree'sini de açar). Rol şemasına `skills` eklenir, prompt'lar skill'leri yükletir. Döngü seçimi ve kapılar skill (Markdown) düzeyindedir.

**Tech Stack:** TypeScript (Node ≥22), commander, ajv, vitest.

**Spec:** `docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md`

## Global Constraints

- Tek görevlik (parent'sız) akış birebir aynı kalır; mevcut tüm testler geçer.
- `pipeline` görevi `launch` edilmez, rol almaz, worktree'si entegrasyon branch'i `vlad/<parent-id>`'dir.
- `depends_on` yalnızca aynı `parent` altındaki var olan görevler; `depends_on` verilen görevde `parent` zorunlu.
- Hata mesajları Türkçe; CLI hata yolu mevcut `fail()`.
- PowerShell 5.1'de `Get-Content -Raw | Set-Content` ve tırnaklı tek satır commit mesajı yok (UTF-8 bozulur / argüman bölünür): Edit/Write ve `git commit -F <dosya>`.

## Review Focus

- Entegrasyon worktree'si elle silinmiş ama branch duruyor → ikinci çocuk launch'u branch'i yeniden kullanıp worktree'yi açmalı, "zaten var" hatası vermemeli. Task 2 testi.
- Çocuk launch'u launcher hatasıyla geri alınırken (undo) entegrasyon branch'i/worktree'si silinmemeli. Task 2 testi.
- `--depends-on` virgüllü listede boşluk/boş öğe (`"a, b,"`) → kırpılır, boşlar atılır. Task 1 testi.
- Çatı görev `cancelled` iken altına yeni faz eklenmesi → hata. Task 1 testi.
- Rol `skills` listesi boş dizi → prompt'a skill satırı eklenmez. Task 3 testi.

---

### Task 1: Görev modeli (`pipeline`, `parent`, `depends_on`, `phase`, `task ready`)

**Files:**
- Modify: `schemas/task.schema.json`, `src/kb/types.ts` (`TaskKind` + alanlar), `src/tasks/store.ts`, `src/cli.ts`
- Test: `test/tasks/store.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces:
  - `TaskKind = "dev" | "research" | "pipeline"`; `TaskData.parent?: string | null`, `depends_on?: string[]`, `phase?: string | null`.
  - `createTask(o: { …; parent?: string | null; dependsOn?: string[]; phase?: string | null })` — doğrulama sırası: kind geçerli → `pipeline` ise `role`/`parent`/`dependsOn` verilmemiş olmalı (`pipeline görevi rol/parent/bağımlılık alamaz`) → `dependsOn` doluysa `parent` zorunlu (`bağımlılık için --parent gerekli`) → parent var, `kind: pipeline`, durumu `done/cancelled/failed` değil (`çatı görev <id> <state>; yeni faz eklenemez`) → her bağımlılık var ve `parent`'ı aynı (`bağımlılık <id> aynı pipeline'da değil`). Yazılan değerler: `parent ?? null`, `depends_on ?? []`, `phase ?? null`.
  - `readyTasks(f?: { parent?: string }): Task[]` — `state === "queued"`, `kind !== "pipeline"`, tüm `depends_on` görevleri `done`; ID sırasında.
  - `listTasksWithWarnings(f: { …; parent?: string })` filtre.
  - CLI: `task new --kind pipeline|dev|research --parent <id> --depends-on <a,b> --phase <ad>`; `task ready [--parent <id>] --json` → `{ tasks: TaskData[] }`; `task list --parent <id>`.

- [ ] **Step 1: Failing tests** (store): `creates a pipeline and phases with parent/depends_on/phase`; `readyTasks returns queued phases whose dependencies are done` (A done, B depends A → B hazır; C depends B → değil; çatı görev listede yok); `rejects a dependency outside the pipeline`; `rejects depends_on without parent`; `rejects a role or parent on a pipeline task`; `rejects a new phase under a cancelled pipeline`; `old task files without the new fields still read` (frontmatter'dan alanları silip `getTask`/`listTasks`). CLI: `task new --kind pipeline` + `--parent --depends-on "a, b," --phase spec` (boş öğe atılır) → `task ready --parent --json` ve `task list --parent`.
- [ ] **Step 2:** `npx vitest run test/tasks/store.test.ts test/cli.test.ts` → yeni testler FAIL.
- [ ] **Step 3:** Uygula (şema: `parent` string|null, `depends_on` string dizisi + id pattern, `phase` string|null, kind enum'a `pipeline`; `ROLE_KIND_FOR`'a `pipeline` girmez — `roleFor` pipeline'da `geçersiz görev türü` yerine yukarıdaki pipeline hatasını önce verir).
- [ ] **Step 4:** `npm test` PASS; commit `feat(tasks): pipeline görevleri, bağımlılıklar ve task ready`.

### Task 2: Entegrasyon branch'i ve launch/cleanup

**Files:**
- Modify: `src/git/git.ts` (`addWorktree(repo, dir, branch, base?)`, `branchExists(repo, branch)`), `src/tasks/launch.ts`
- Test: `test/tasks/launch.test.ts`, `test/git/git.test.ts`

**Interfaces:**
- Consumes: Task 1 alanları, `getTask`.
- Produces:
  - `addWorktree(repo, dir, branch, base?: string)` — `base` verilirse `git worktree add -b <branch> <dir> <base>`.
  - `attachWorktree(repo, dir, branch)` — var olan branch için `git worktree add <dir> <branch>`.
  - `ensureIntegration(parentId: string, cfg: VladConfig): { repo: string; branch: string; worktree: string }` (`src/tasks/launch.ts`, export) — branch `vlad/<parent>` yoksa ana HEAD'den açar; worktree dizini yoksa açar/bağlar; çatı görevin `branch`/`worktree`'sini yazar; çatı `queued` ise `running` yapar.
  - `launchTask`: `parent` doluysa önce `ensureIntegration`, sonra çocuğu `base = vlad/<parent>` ile açar. Undo yalnızca çocuğun worktree/branch'ini geri alır.
  - `launchTask` `kind: pipeline` için mevcut hata (`yalnızca dev görevleri başlatılır`) korunur.
  - `cleanupTask` `pipeline` görevinde de çalışır (pencere kapatma yok — `closeWorker` yine çağrılır, eşleşen süreç yoktur).

- [ ] **Step 1: Failing tests:** `first phase launch creates the integration branch and worktree and runs the pipeline` (çatı `running`, `branch === vlad/<P>`, worktree var); `child branches from the integration branch` (entegrasyon worktree'sinde commit at → ikinci çocuğun worktree'sinde o dosya var); `integration worktree deleted by hand is re-attached` (dizini `git worktree remove` ile sil, branch kalsın → sonraki launch hata vermez); `launcher failure rolls back only the child` (entegrasyon branch'i ve worktree'si duruyor); `cleanup removes the integration worktree of a done pipeline and keeps the branch`. git: `addWorktree with base`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Uygula.
- [ ] **Step 4:** `npm test` + `npm run build` PASS; commit `feat(tasks): pipeline entegrasyon branch'i`.

### Task 3: Rollere skill bağlama (kod)

**Files:**
- Modify: `schemas/role.schema.json` (`skills`: string dizisi, opsiyonel), `src/kb/types.ts` (`RoleData.skills?`), `src/roles/store.ts` (`Role.skills: string[]`, yoksa `[]`), `src/tasks/launch.ts` (`buildPrompt` rol parametresi `{ title; file; skills }`)
- Test: `test/roles/store.test.ts`, `test/tasks/launch.test.ts`

**Interfaces:**
- Produces: `buildPrompt(taskFile, autonomy, role?: { title: string; file: string; skills: string[] })` — `skills` doluysa rol cümlesinden sonra: ``İşe başlamadan şu skill'leri yükle: `a`, `b`. Yüklenemeyen olursa kapanış raporunda belirt.``

- [ ] **Step 1: Failing tests:** store `reads skills, defaulting to []`; launch `prompt lists the role's skills` / `no skill sentence for an empty list`.
- [ ] **Step 2:** FAIL. **Step 3:** Uygula. **Step 4:** `npm test` PASS; commit `feat(roles): rollere skill bağlama`.

### Task 4: Rol içerikleri (paralel, yalnızca `roles/`)

**Files:**
- Create: `roles/architect.md`
- Modify: `roles/{analyst,developer,tester,finans,pazarlama}.md`
- Test: `test/roles/repo-roles.test.ts` (architect beklenen listeye; `skills` alanları)

- [ ] **Step 1:** `architect` (advisory, title `Software Architect`): spec §7 plan çıktısı başlıkları (`### Bileşenler`, `### Arayüzler`, `### Dosya yapısı`, `### Görev listesi`, `### Test stratejisi`, `### Riskler`, `### Eleştiriler ve nasıl ele alındı`), kod yazmaz.
- [ ] **Step 2:** Her role spec §8'deki `skills:` listesi; tester'a ek olarak `superpowers:verification-before-completion`. Tarayıcı bir skill değil, kurulu Playwright MCP araçlarıdır (`mcp__plugin_playwright_playwright__*`): tester'ın `## Kaynaklar`'ına "doğrulama fazında, UI varsa Playwright MCP araçlarıyla uçtan uca dene; araçlar yoksa raporda belirt" yazılır. Tester ve developer'ın `## Yetki`'sine spec §4 dosya sahipliği; analyst'in Çıktı'sına spec §7 senaryo biçimi (Verilen/Olduğunda/O zaman) ve fazlar; tüm rollere "pipeline fazındaysan `depends_on` görevlerinin `## Kapanış raporu`'nu oku".
- [ ] **Step 3:** repo-roles testi 6 rol + `skills` dizisi beklentisiyle; Task 3 merge'ünden sonra PASS; commit `feat(roles): architect ve skill bağlamaları`.

### Task 5: Skill'ler ve protokol (paralel, yalnızca Markdown)

**Files:**
- Modify: `.claude/skills/delegate/SKILL.md`, `.claude/skills/status/SKILL.md`, `.claude/skills/digest/SKILL.md`, `global/skills/vlad-worker/SKILL.md`, `CLAUDE.md`

- [ ] **Step 1: /delegate:** spec §3 döngü tablosu ve seçim işaretleri; belirsizse iki döngüyü artı/eksiyle sorma; taslakta **Döngü:** satırı + faz tablosu (faz, rol, tür, bağımlılık) + kapılar; onaydan sonra `task new --kind pipeline` → fazlar sırayla `--parent --depends-on --phase --role` → `vlad task ready --parent <id> --json` → hazırları başlat (dev `launch`, research arka plan agent'ı). Plan fazı yaz–eleştir döngüsü (spec §7). Danışman yan görevleri.
- [ ] **Step 2: /status:** pipeline ağacı; çocuk kapısında merge hedefi entegrasyon worktree'si (`git -C <çatı worktree> merge --no-ff vlad/<child>`), sonra `done` + `cleanup` + `task ready --parent` → hazırları sormadan başlat; tüm fazlar `done` → çatıyı `awaiting_approval` yap, son kapı (ana branch'e merge veya push+PR, açık onay), açık noktaları topla; faz `failed/cancelled` seçenekleri (spec §11).
- [ ] **Step 3: /digest:** pipeline tek madde altında fazlarıyla.
- [ ] **Step 4: vlad-worker:** `parent` doluysa `depends_on` görevlerinin kapanış raporlarını oku (`vlad task list --parent <parent> --json` + dosyalar); branch'in entegrasyon branch'inden açıldığını bil; asla entegrasyon branch'ine kendisi merge etmez.
- [ ] **Step 5: CLAUDE.md:** komut listesine `vlad task ready`; skill tablosuna pipeline notu; "Uzman roller" bölümüne pipeline paragrafı ve spec linki.
- [ ] **Step 6:** commit `docs(skills): pipeline akışları`.

## Execution

Native (yazar VLAD) + paralel subagent'lar: Task 1 → Task 2 → Task 3 sıralı (aynı dosyalar: `store.ts`, `launch.ts`). Task 4 (`roles/`) ve Task 5 (skill Markdown'ları) koddan disjoint ve arayüzleri bu planda sabit → baştan iki ayrı worktree'de subagent'lara. Hepsi bitince `feat/pipeline`'a merge, birleşik sonuçta tam suite + build, `vlad install`, tek bir reviewer incelemesi, düzeltmeler, `master`'a merge + push.
