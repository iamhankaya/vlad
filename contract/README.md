# contract/

API sözleşmesinin tek kaynağı. Sunucu (`server/`), Android `:core` (vlad-mobile reposu) ve testler aynı dosyaları tüketir.
Plan: `docs/plan/vlad-mobile-plan.md` ("Arayüzler", "Eşleştirme ve imza").

| Yol | İçerik | Sahip / kural |
|---|---|---|
| `openapi.yaml` | OpenAPI 3.1, taban `/v1`. Her ucun `x-vlad-auth: none\|session\|session+approval` değeri, şemalar, hata kodu enum'u, SSE olay türleri | Sonraki dilimler yalnız kendi yol/şema bölümünü ekler; mevcut alanı değiştirmek `Test itirazı` ile sorulur |
| `signing-vectors.json` | İmza ve kanonikleştirme vektörleri (aşağıda) | Salt okunur; yeni vektör satır ekleme. **Yeniden üretme** (ECDSA imzaları rastgeledir) |
| `fixtures/api/*.json` | İç API örnekleri (uç başına istek/yanıt) | `server/test/unit/contract-fixtures.test.ts` openapi şemasına karşı doğrular |
| `fixtures/external/` | Dış servislerden kaydedilmiş gerçek yanıtlar + `MANIFEST.json` (D0A) | Yalnız ilgili dilim kendi girişini ekler; `external-manifest.test.ts` tamlığı doğrular |

Doğrulama: `cd server && npm run gate` (tip denetimi + `redocly lint` + vitest). Kök `npm test` `grantSigningPayload()` ile vektörü karşılaştırır.

## `signing-vectors.json` biçimi (dilden bağımsız)

Tüm ikili değerler **base64url, dolgusuz** (`+`→`-`, `/`→`_`). Metinler UTF-8, satır sonu `\n`, sonda satır sonu yok.
İmza: **ECDSA P-256, SHA-256, ASN.1 DER** (ham `r||s` DEĞİL), **minimal kısa biçim** (öndeki gereksiz sıfır, uzun biçim uzunluk, sondaki bayt yok) ve **low-S zorunlu** (`s <= n/2`; yüksek-S ikizi reddedilir). Node/OpenSSL bunları kabul eder, bu yüzden tüketici imzayı doğrulamadan önce kendisi denetler (`server/src/auth/der.ts`: `isCanonicalSignature`). İmzalayanlar üretimde `s > n/2` ise `n - s` yazmalıdır. Anahtarlar SPKI DER (91 bayt → 122 karakter). Özel anahtar dosyada
yoktur; vektörler yalnız **doğrulama yönünde** sabittir. Üretme yönü her dilde round-trip testiyle sınanır (taze anahtar, imzala,
doğrula).

```
{
  "vectors_version": 2,
  "signature_format": "...",
  "keys":  [ { "id", "note": "TEST ONLY ...", "spki_b64u" } ],
  "canonical_query":        [ { "id", "raw_query", "expected" } ],
  "canonical_query_errors": [ { "id", "raw_query" } ],                // canonicalQuery hata vermeli
  "body_hash": [ { "id", "body_b64u", "sha256_hex" } ],               // hash ham bayt üzerinden
  "envelope":  [ { "id", "description", "key_id",
                   "input": { "method", "path", "raw_query", "ts_ms", "nonce", "body_b64u" },
                   "envelope_string", "signature_b64u", "expect_valid" } ],
  "envelope_errors": [ { "id", "description", "input": {..} } ],      // envelopeString hata vermeli
  "challenge": [ { "id", "description", "key_id", "fields": {..}, "challenge_text", "signature_b64u", "expect_valid" } ],
  "grant":     [ { "id", "description", "key_id", "input": {..}, "payload", "signature_b64u", "expect_valid" } ],
  "revoke":    [ { "id", "description", "key_id", "fields": { "device", "signer", "ts_ms" }, "revoke_text", "signature_b64u", "expect_valid" } ],
  "revoke_errors": [ { "id", "fields": {..} } ]                        // revokeBytes hata vermeli
}
```

Bir tüketicinin yapması gerekenler:

1. `canonical_query`: `canonicalQuery(raw_query) == expected`; `canonical_query_errors`: hata. `body_hash`: `sha256_hex(base64url_decode(body_b64u)) == sha256_hex`.
2. `envelope`: `input`'tan `envelopeString(...)` üret, `envelope_string`'e **eşit** olmalı; ardından `verify(keys[key_id], envelope_string, signature_b64u) == expect_valid`. Geçersiz vektörler: gövde baytı değişmiş, yöntem/ts değişmiş, yanlış anahtar, kesik DER, yanlış DER etiketi, ham `r||s`. Doğrulayıcı hata fırlatırsa sonuç "geçersiz"dir (çökmez).
   Zarf vektörleri ek olarak: yol sınıfları (`%2F`, `//`, sondaki `/` ayrı imzalı yoldur; birine atılan imza ötekinde geçersiz), yüksek-S, öndeki sıfır, uzun biçim, sondaki bayt. `envelope_errors`: nonce 21/23 karakter, base64url dışı, boş; küçük harfli yöntem; yolda sorgu; yinelenen sorgu anahtarı.
3. `challenge`: `challengeBytes(fields)` UTF-8 olarak `challenge_text`'e eşit olmalı; `verify(approval anahtarı, bayt, imza) == expect_valid`. Session anahtarıyla atılmış imza geçersizdir.
5. `revoke`: `revokeBytes(...)` UTF-8 olarak `revoke_text`'e eşit; `verify(approval anahtarı, bayt, imza) == expect_valid`. `revoke_errors` hata vermeli.
4. `grant`: `payload`, `src/grants/store.ts` `grantSigningPayload()` çıktısıdır (tek kaynak; kök `test/contract/grant-signing-vector.test.ts` eşitliği doğrular). `verify(approval anahtarı, payload, imza) == expect_valid`.

### Kanonik kurallar

- **Zarf hedefi**: sunucu zarfı yönlendirmeden önce **ham istek hedefinden** (`req.raw.url`; `?` öncesi ham yol, çözülmeden/normalleştirilmeden) kurar. Yönlendirici normalleştirmesi imzayı etkilemez; `/a%2Fb`, `/a//b`, `/a/` ayrı imzalıdır.
- **Sorgu** (`canonicalQuery`): baştaki `?` atılır; `&` ile bölünür, boş parçalar atılır; ilk `=`'te anahtar/değer (`=` yoksa değer boş → `a` = `a=`); `+` boşluk, `%XX` bayt olarak çözülür (UTF-8, katı; bozuk yüzde kodu ya da geçersiz UTF-8 hata); çiftler **anahtara göre, UTF-8 bayt sırasıyla** sıralanır (büyük harf küçükten önce gelir); **yinelenen anahtar (çözümden sonra da, `a` ve `%61`) `bad_query` hatasıdır** (hiçbir uç dizi parametre almaz); yeniden kodlamada yalnız `A-Za-z0-9-._~` açık kalır, kalan her bayt `%XX` (büyük harf hex), boşluk `%20`.
- **Zarf**: `v1\n<METHOD>\n<yol[?kanonik sorgu]>\n<ts_ms>\n<nonce>\n<sha256hex(ham gövde)>`. Yöntem büyük harf; yol olduğu gibi imzalanır (çözülmez, `?`/`#`/boşluk/kontrol karakteri içermez); `ts_ms` negatif olmayan tam sayı; nonce base64url. Boş gövde `sha256("")`. **Nonce tam 22 karakter base64url (16 bayt)**; kısa/uzun nonce hatadır. Başlıklar: `X-Vlad-Device`, `X-Vlad-Ts`, `X-Vlad-Nonce`, `X-Vlad-Sig`.
- **Challenge**: `vlad-approve/v1` + `action_id, kind, repo, pr, base, head_sha, task, nonce, exp` satırları (`anahtar=değer`) bu sırayla; değer alfabesi `[A-Za-z0-9._/#:-]` ve alana özgü kalıp; eksik/fazla alan, farklı sıra, satır sonu enjeksiyonu, sonda `\n` reddedilir. `exp` unix saniye; `now >= exp` reddedilir.
- **İptal** (`revokeBytes`): `vlad-revoke/v1\ndevice=<hedef>\nsigner=<çağıran cihaz>\nts=<ts_ms>`, `approval` anahtarıyla. Sunucu kuralları (S6b): `signer == X-Vlad-Device`, `ts_ms == X-Vlad-Ts`, ±120 sn, `(signer, ts)` tek kullanım; ihlal `401`. Gövdede cihaz kimliği yoktur; `POST /actions/{id}/approve` gövdesinde de yoktur: cihaz yalnız `X-Vlad-Device` başlığıdır.
- **Devir tekilliği/iptali (S10a)** imza baytına değil `id` ve payload hash'ine bağlanır (imza biçimi esnemez ama tekillik anahtarı imza olmamalı; low-S zorunluluğu malleability'yi zaten kapatır).
- **Devir**: `vlad-grant/v1\nid=..\nscope=<type>:<ref>\naction=..\nconditions=<sıralı,virgüllü>\ncreated=..\nexpires=..\nmax_uses=..`.

### Tüketici eşlemesi

| Dil | Kanonik fonksiyonlar | Doğrulama |
|---|---|---|
| TypeScript | `server/src/auth/canonical.ts`: `canonicalQuery`, `envelopeString`, `challengeBytes`, `parseChallengeBytes` | `crypto.verify` + `dsaEncoding: "der"` |
| Kotlin (`:core`, S7a) | `crypto/Canonical.kt` aynı adlarla | `java.security.Signature("SHA256withECDSA")` (DER) |

Kotlin tarafı aynı dosyayı okuyup yukarıdaki adımları koşar (DER katılığı ve low-S denetimi dahil); vektör eklemek S7b'nin (cihaz vektörü) işidir.

## Açık noktalar (varsayım)

- İptal imza baytları plan'da yoktu; güvenlik incelemesinde (VLAD) yukarıdaki biçime bağlandı.
- Kapı kartı kimliği `gate-<görev id>` (görevden türetilir, depolanmaz) ve `Card.kind` enum'una `gate` eklendi: plan kapı kartının depolanmadığını söyler ama API kimliğini tanımlamaz.
- `fixtures/api/*` `synthetic`tir (sunucu henüz yok); S6c `/home` fixture'ını gerçek CLI ile karşılaştırır.

## Olay verisi (S6d)

`Event.data` bir geçersiz kılma ipucudur: kimlik ve yeni durum taşır, başlık/rapor/yol taşımaz (kilit ekranı güvenli). İstemci `GET /home` ile yeniler.

| `type` | `data` | Ne zaman |
|---|---|---|
| `card.opened` | `{card_id, project}` | Yeni açık kart |
| `task.state` | `{task_id, project, state}` | Yeni görev ya da durum değişimi; `(görev, durum, updated)` başına tek olay |
| `worker.progress` | `{task_id, pct}` | Aynı durumda ilerleme değişimi |
| `quota.changed` | `{limited}` | Sınır durumu döndü |

`chat.delta`, `chat.done`, `action.executed`, `grant.used` ilgili dilimlerde (S11, S9b, S10a) deftere yazılır. `seq` defterde artar; defter en çok 2000 olay tutar, eskiler atılır: bir istemcinin konumundan sonraki ilk olay `konum + 1` değilse olay kaçmıştır, `GET /home` ile yenilenir. SSE ve `/events` aynı `seq`'i kullanır; `GET /stream` Funnel gibi bir ara katman akışı taşımazsa `/events?after=` yoklanır.
