# VLAD Uzman Roller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Görevlere `roles/<slug>.md` ile tanımlı bir uzman rol atanabilsin; danışman roller VLAD içinde research, uygulayıcı roller çalışan session'ında persona olarak çalışsın.

**Architecture:** Roller VLAD reposunda düz Markdown (`roles/`), frontmatter'ı `schemas/role.schema.json` ile doğrulanır. `src/roles/store.ts` listeler/okur; görev frontmatter'ına `role` eklenir, `task new --role` rol varlığını ve kind uyumunu denetler; `buildPrompt` rol dosyası yolunu çalışana söyler. Skill'ler rol önerir ve gösterir.

**Tech Stack:** TypeScript (Node ≥22), commander, ajv, vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-vlad-roles-design.md`

## Global Constraints

- Rol slug'ı `^[a-z][a-z0-9-]*$` ve dosya adıyla aynı; `kind` ∈ `advisory | executor`.
- `advisory` rol yalnızca `research`, `executor` rol yalnızca `dev` görevinde.
- Rolsüz görevlerin davranışı değişmez (mevcut testler aynen geçer).
- Hata mesajları Türkçe; CLI hata yolu mevcut `fail()` (stderr JSON, çıkış 1).
- PowerShell 5.1 `Get-Content -Raw | Set-Content` ile dosya düzenleme yok (UTF-8 bozuluyor); Edit/Write aracı kullan.

## Review Focus

- Rol dosyası BOM'lu veya CRLF satır sonlu → yine okunur (Windows'ta elle düzenlenmiş dosya). Task 1'de CRLF testi.
- `--role` verilip `--kind` verilmedi → kind varsayılanı `dev`; advisory rol ile hata mesajı rolün kind'ını söyler. Task 3'te test.
- Görev oluştuktan sonra rol dosyası silindi → `launch` görevi `queued` + `error` bırakır, worktree açılmaz. Task 3'te test.
- `roles/` klasörü hiç yok → `role list` boş liste, hata değil. Task 1'de test.
- Rol başlığı tek tırnak içeriyor → launcher script'i bozulmaz (mevcut `q()` kaçışı prompt'u zaten kapsar; ek iş yok, Task 3 prompt testinde başlıkta `'` kullan).

---

### Task 1: Rol deposu ve `vlad role list`

**Files:**
- Create: `schemas/role.schema.json`, `src/roles/store.ts`, `test/roles/store.test.ts`
- Modify: `src/kb/schema.ts` (`SchemaKind`'a `"role"`), `src/kb/home.ts` (`KbPaths.roles = join(home, "roles")`), `src/kb/types.ts` (`RoleData`), `src/cli.ts` (`role list`), `test/helpers.ts` (`makeHome` boş `roles/` oluşturur), `test/cli.test.ts`

**Interfaces:**
- Produces:
  - `interface RoleData { slug: string; title: string; kind: "advisory" | "executor"; summary: string }` (`src/kb/types.ts`)
  - `type Role = RoleData & { file: string }`
  - `listRolesWithWarnings(dir?: string): { roles: Role[]; warnings: string[] }` — dir varsayılan `kbPaths().roles`; ada göre sıralı; bozuk/geçersiz/slug≠dosya adı → uyarı
  - `getRole(slug: string): Role` — yoksa `rol bulunamadı: <slug>; mevcut: <a, b>`; geçersizse doğrulama hatası

- [ ] **Step 1: Failing tests** (`test/roles/store.test.ts`):
  - `lists valid roles sorted, with file path` — `tester.md`, `analyst.md` yaz → slug sırası `["analyst","tester"]`, `file` mutlak yol.
  - `invalid frontmatter, slug/file mismatch and broken yaml become warnings` — 3 bozuk dosya → `roles: []`, `warnings.length === 3`.
  - `reads CRLF files` — `\r\n` ile yazılmış rol okunur.
  - `missing roles dir yields empty list`.
  - `getRole throws for unknown slug listing available ones` — `/rol bulunamadı: x; mevcut: tester/`.
- [ ] **Step 2:** `npx vitest run test/roles` → FAIL (modül yok).
- [ ] **Step 3:** Şema (spec §4: 4 zorunlu alan, `additionalProperties: false`, slug pattern) ve store'u `projects/store.ts` kalıbıyla yaz (`readDoc` + `validate("role")`).
- [ ] **Step 4:** CLI testi: `role list --json` → `{roles:[...], warnings:[]}`; `vlad role list` metin çıktısı `slug  kind  title`. `def(role, "list", ...)`.
- [ ] **Step 5:** `npm test` → hepsi PASS; commit `feat(roles): rol deposu ve vlad role list`.

### Task 2: Beş başlangıç rolü (içerik)

**Files:**
- Create: `roles/finans.md`, `roles/pazarlama.md`, `roles/analyst.md`, `roles/tester.md`, `roles/developer.md`
- Test: `test/roles/repo-roles.test.ts`

**Interfaces:**
- Consumes: `listRolesWithWarnings(dir)` (Task 1). İçerik yazımı Task 1'den bağımsız; test Task 1 merge'ünden sonra çalışır.

- [ ] **Step 1:** Her dosya spec §4 tablosundaki `slug/title/kind/summary` ve dört bölüm (`## Sorumluluk`, `## Yetki`, `## Kaynaklar`, `## Çıktı`). Ortak sınırlar (spec §4 madde listesi) her dosyanın `## Yetki`'sinde. Rol özelinde:
  - finans/pazarlama: web araştırması serbest, kaynak linki zorunlu, rakamlar için varsayım tablosu; çıktı: yönetici özeti + bulgular + öneriler + varsayımlar + kaynaklar.
  - analyst: kodu/dokümanı okuyarak doğrular (`dosya:satır`), seçenek karşılaştırma tablosu, risk listesi; kod yazmaz.
  - tester: üretim kodunu değiştirmez; test dosyaları ve test yardımcıları yazabilir; her hata için yeniden üretme adımı + başarısız test; kapanış raporunda kapsam tablosu.
  - developer: vlad-worker protokolü + TDD + review; kabul kriterleri tek tek; yalnızca `vlad/<id>` branch'i.
- [ ] **Step 2:** `test/roles/repo-roles.test.ts`: `listRolesWithWarnings(<repo>/roles)` → `warnings: []`, slug'lar `["analyst","developer","finans","pazarlama","tester"]`, kind'lar spec tablosuyla aynı; her dosya dört başlığı içerir.
- [ ] **Step 3:** `npm test` PASS; commit `feat(roles): beş başlangıç rolü`.

### Task 3: Görevde rol (`--role`, prompt)

**Files:**
- Modify: `schemas/task.schema.json` (`role: string|null`), `src/kb/types.ts` (`TaskData.role?`), `src/tasks/store.ts` (`createTask` `role?`), `src/tasks/launch.ts` (`buildPrompt`, `launchTask`), `src/cli.ts` (`task new --role`)
- Test: `test/tasks/store.test.ts`, `test/tasks/launch.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `getRole(slug)` (Task 1).
- Produces:
  - `createTask(o: { project; title; kind; body; role?: string | null }, ...)` — rol verilirse `getRole` + kind kontrolü; hata metni `rol <slug> (<role.kind>) <kind> görevinde kullanılamaz`; `data.role = slug ?? null`.
  - `buildPrompt(taskFile: string, autonomy: string, role?: { title: string; file: string }): string` — rol varsa sona: ``Rolün: <title>. Göreve başlamadan önce `<file>` dosyasını oku ve oradaki sorumluluk, yetki ve çıktı kurallarına uy.``
  - `launchTask` rolü `getRole(task.data.role)` ile çözer; hata → mevcut `recordError` yolu, worktree açılmadan.

- [ ] **Step 1: Failing tests:**
  - store: `createTask stores a valid role` (executor rol + dev → `role === "tester"`); `rejects unknown role`; `rejects advisory role on a dev task` (`/rol finans \(advisory\) dev görevinde kullanılamaz/`); rolsüz görevde `role === null`.
  - launch: `prompt names the role file` (rol başlığı `Senior Tester'ın` — tek tırnaklı); `launch with a deleted role file keeps queued, records error, opens no worktree`.
  - cli: `task new --role tester --json` → görev dosyasında `role: tester`; `--role finans` (kind dev) → çıkış 1, stderr JSON hatası.
- [ ] **Step 2:** Testler FAIL.
- [ ] **Step 3:** Uygula.
- [ ] **Step 4:** `npm test` + `npm run build` PASS; commit `feat(tasks): görevlere rol atanır, prompt rol dosyasını söyler`.

### Task 4: Skill'ler ve protokol

**Files:**
- Modify: `.claude/skills/delegate/SKILL.md`, `.claude/skills/status/SKILL.md`, `.claude/skills/digest/SKILL.md`, `global/skills/vlad-worker/SKILL.md`, `CLAUDE.md` (komut listesine `vlad role list`, skill tablosuna rol notu), `docs/superpowers/specs/2026-10-15-vlad-core-design.md` (§1 kapsam dışı maddesine "→ roller spec'i" referansı)

**Interfaces:**
- Consumes: `vlad role list --json`, `vlad task new --role` (Task 1, 3).

- [ ] **Step 1:** delegate: spec §6 adımları (rol listesi, taslakta **Rol:** satırı + gerekçe, `--role`, research agent prompt'u rol dosyasıyla başlar).
- [ ] **Step 2:** vlad-worker adım 1: rol dosyasını oku; çelişkide daha kısıtlayıcı kural.
- [ ] **Step 3:** status tablosuna "Rol" sütunu; digest maddesine rol başlığı.
- [ ] **Step 4:** `vlad install --dry-run` ile worker skill kopyalama satırı görünür; `npm test` PASS; commit `docs(skills): rol desteği`.

## Execution

Native: Task 1 → Task 3 sıralı (3, 1'in arayüzünü tüketir). Task 2 (yalnızca `roles/` içerik dosyaları) Task 1 ile disjoint olduğu için ayrı worktree'de bir subagent'a paralel verilir; testi Task 1 merge'ünden sonra çalışır. Task 4, Task 3 bitince. Sonunda tüm suite birleşik branch'te + tek bir reviewer incelemesi.
