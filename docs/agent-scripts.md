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
3. HEAD upstream'in atası olmalı (`unpushed`, `no_upstream`): itilmemiş commit çalışmaz.
4. Blob baytları özel (0600) geçici dosyaya yazılıp o çalıştırılır; çalışırken `git pull` ya da autocrlf sonucu değiştirmez.
5. `shell:false`; parametreler argv'de değil `VLAD_PARAM_<AD>` ortam değişkenindedir. Ortam allowlist'tir (sırlar, `NODE_OPTIONS`, `VLAD_AGENT_*` geçmez) + `VLAD_HOME/REPO/MACHINE/OP_ID/SCRIPT/ROOTS`.
6. Tavanlar: stdout `outputMaxKb` (≤32 KiB), stderr 16 KiB, sonuç JSON 16 KiB; zaman aşımında süreç ağacı öldürülür (çıkış 124). Aynı anda tek betik (meşgul kilidi).
7. Yapılandırılmış sonuç: stdout'un son 20 satırında `@@VLAD-RESULT@@ {json}`. Betikteki `restart` anahtarı atılır.

Hata iletisi biçimi: `<kod>: [<neden>] <ayrıntı>`; nedenler: bad_name, bad_param, unregistered, no_variant, dirty, hash_mismatch, not_regular, not_in_head, unpushed, no_upstream, approval, bad_manifest, no_repo.

## repo-guncelle

Kök klasörlerdeki (`--param root=<ad>` ya da config `roots`) git depolarında `fetch --prune` + `pull --ff-only`. Agent'ın kendi klonu, detached HEAD, upstream'siz, kirli ve ayrışmış depolar **atlanır**; fetch/pull hatası `error` sayılır. En çok 80 depo ayrıntısı döner (`omitted`).

## Kapsam dışı (faz b, T20261109-10)

`selfUpdate`/yeniden başlatma, `vlad-guncelle`, dist değişimi ve bakım bayrağı. Manifestte `selfUpdate: true` olan betik şimdilik `forbidden` ile reddedilir.
