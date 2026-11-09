# Kayıtlı bakım betikleri (T20261109-03 / -07)

Beyin, işçi makinede **yalnız repoda kayıtlı** betikleri çalıştırabilir. Keyfi komut/betik yoktur: yol, yorumlayıcı ve argv istekten gelmez.

## Kullanım

```
vlad machine scripts <ad>                       # işçinin betikleri + bütünlük durumu (salt okuma)
vlad machine run <ad> <betik> --plan            # ne çalışacağını ve plan-id'yi gösterir; çalıştırmaz
vlad machine run <ad> <betik> --confirmed <plan-id> [--param k=v]... [--op-id <id>] [--json]
```

- `read` sınıfı betik `--plan` ya da onay olmadan çalışır. `write` sınıfı (ör. `repo-guncelle`) **kullanıcının açık onayından sonra** `--confirmed <plan-id>` ile çalışır; plan-id makine, ad, platform, betik karması ve parametrelerden türer (biri değişirse onay geçersiz).
- Zaman aşımında aynı `--op-id` ile tekrar çağır: Agent aynı işi ikinci kez çalıştırmaz (journal).
- Çıkış kodu: betik ≠ 0 → 1, geçici ağ hatası → 75.

## Kayıt (`agent-scripts/manifest.json`)

Her giriş: `name`, `title`, `platform` (win32|darwin|linux), `file` (`agent-scripts/<ad>.ps1|.sh`), `sha256`, `class` (read|write), `timeoutSec`, `outputMaxKb`, `selfUpdate`, `params`. Şema dışı alan, çift (ad, platform) ya da uzantı/platform uyumsuzluğu manifestin tamamını reddeder (`[bad_manifest]`). Parametre tipleri: `string` (varsayılan `[A-Za-z0-9._-]`, baştaki `-` ve `..` yasak), `enum`, `int`, `bool`, `root` (config `roots` üyesi).

Betik ya da manifest değişince karmayı güncelle: `node scripts/agent-scripts-sha.mjs --write` (`--check` modu çıkış 1 verir; `test/machines/script-registry.test.ts` aynı denetimi CI'da yapar). `.gitattributes` `agent-scripts/* -text` ile bayt kararlılığı sağlar; `.ps1` yalnız ASCII.

## Bütünlük ve yürütme

1. `VLAD_HOME` bir git deposunun kökü olmalı; `agent-scripts/` altında değişmiş/izlenmeyen dosya varsa red (`dirty`).
2. Doğruluk kaynağı **HEAD'deki blob**'dur (çalışma ağacı değil): düzenli dosya (100644/100755), karması manifestle eşleşmeli (`hash_mismatch`, `not_in_head`, `not_regular`).
3. Çalışan commit origin'in **varsayılan dalında** olmalı (dalın upstream'i `refs/remotes/origin/HEAD`, yoksa origin/main|master olmalı; `unpushed`, `no_upstream`): itilmemiş commit ve özellik dalına itilmiş kod çalışmaz. **Repo push yetkisi = işçide kod çalıştırma yetkisi**; varsayılan dalı korumalı tut (inceleme/branch protection).
   HEAD bir kez okunur (oid); manifest, betik ve atalık kontrolü aynı oid ile yapılır, sonuçtaki `head` çalışan betiğin commit'idir.
4. Blob baytları özel (0600; dizin 0700 / Windows ACL) geçici dosyaya yazılıp o çalıştırılır; Windows'ta ACL kurulamazsa betik çalışmaz (fail-closed); çalışırken `git pull` ya da autocrlf sonucu değiştirmez.
5. `shell:false`; parametreler argv'de değil `VLAD_PARAM_<AD>` ortam değişkenindedir. Ortam allowlist'tir (sırlar, `NODE_OPTIONS`, `VLAD_AGENT_*` geçmez) + `VLAD_HOME/REPO/MACHINE/OP_ID/SCRIPT/ROOTS`.
6. Tavanlar (UTF-8 **bayt**, karakter ortadan kesilmez): stdout `outputMaxKb` (≤32 KiB), stderr 16 KiB, sonuç JSON 16 KiB; zaman aşımında süreç ağacı öldürülür (çıkış 124). Aynı anda tek betik (meşgul kilidi).
7. Yapılandırılmış sonuç: stdout'un son 20 satırında `@@VLAD-RESULT@@ {json}`. Betikteki `restart` anahtarı atılır.

Hata iletisi biçimi: `<kod>: [<neden>] <ayrıntı>`; nedenler: bad_name, bad_param, unregistered, no_variant, dirty, hash_mismatch, not_regular, not_in_head, unpushed, no_upstream, approval, bad_manifest, no_repo.

## Onay ve uzlaştırma notları

- **plan-id kriptografik değil, işlemsel bir kontroldür:** gizli değildir, herkes hesaplayabilir; `--confirmed`'ın kullanıcı onayından sonra verilmesi prosedürel kuraldır (CLAUDE.md). Amacı, onaylanan plan ile çalışan betik/parametre/makine arasındaki kaymayı yakalamaktır. `class`/`timeoutSec`/`file` plan-id'de yoktur (değişimleri `sha256` ve manifest satırıyla incelemede görünür).
- Agent çökmesinde yarım kalan `script-run` kaydı: sınıf (read/write) başlangıçta kayda yazılır; `read` → `aborted` (aynı opId yeniden koşabilir), `write` ya da sınıfı yazılmamış → `done + uncertain` (otomatik yeniden koşma yok; mevcut HEAD'deki manifeste güvenilmez). Belirsiz kayıtta aynı `--op-id` betiği koşmaz, CLI "belirsiz, makinede doğrula" der.
- Terminale yazılan uzak çıktıdan kontrol karakterleri (ESC dizileri) ayıklanır; `--json` çıktısı ham (kaçışlı) kalır.
- Desenli `string` parametrede baştaki `-` yine reddedilir (bayrak enjeksiyonu); manifestte `allowLeadingDash: true` ile açıkça izin verilebilir.

## repo-guncelle

Kök klasörlerdeki (`--param root=<ad>` ya da config `roots`) git depolarında `fetch --prune` + `pull --ff-only`. Agent'ın kendi klonu, symlink/junction alt dizinler, detached HEAD, upstream'siz, kirli ve ayrışmış depolar **atlanır**; fetch/pull hatası `error` sayılır. En çok 80 depo ayrıntısı döner (`omitted`).

## Kapsam dışı (faz b, T20261109-10)

`selfUpdate`/yeniden başlatma, `vlad-guncelle`, dist değişimi ve bakım bayrağı. Manifestte `selfUpdate: true` olan betik şimdilik `forbidden` ile reddedilir.
