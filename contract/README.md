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
İmza: **ECDSA P-256, SHA-256, ASN.1 DER** (ham `r||s` DEĞİL). Anahtarlar SPKI DER (91 bayt → 122 karakter). Özel anahtar dosyada
yoktur; vektörler yalnız **doğrulama yönünde** sabittir. Üretme yönü her dilde round-trip testiyle sınanır (taze anahtar, imzala,
doğrula).

```
{
  "vectors_version": 1,
  "signature_format": "...",
  "keys":  [ { "id", "note": "TEST ONLY ...", "spki_b64u" } ],
  "canonical_query":        [ { "id", "raw_query", "expected" } ],
  "canonical_query_errors": [ { "id", "raw_query" } ],                // canonicalQuery hata vermeli
  "body_hash": [ { "id", "body_b64u", "sha256_hex" } ],               // hash ham bayt üzerinden
  "envelope":  [ { "id", "description", "key_id",
                   "input": { "method", "path", "raw_query", "ts_ms", "nonce", "body_b64u" },
                   "envelope_string", "signature_b64u", "expect_valid" } ],
  "challenge": [ { "id", "description", "key_id", "fields": {..}, "challenge_text", "signature_b64u", "expect_valid" } ],
  "grant":     [ { "id", "description", "key_id", "input": {..}, "payload", "signature_b64u", "expect_valid" } ]
}
```

Bir tüketicinin yapması gerekenler:

1. `canonical_query`: `canonicalQuery(raw_query) == expected`; `canonical_query_errors`: hata. `body_hash`: `sha256_hex(base64url_decode(body_b64u)) == sha256_hex`.
2. `envelope`: `input`'tan `envelopeString(...)` üret, `envelope_string`'e **eşit** olmalı; ardından `verify(keys[key_id], envelope_string, signature_b64u) == expect_valid`. Geçersiz vektörler: gövde baytı değişmiş, yöntem/ts değişmiş, yanlış anahtar, kesik DER, yanlış DER etiketi, ham `r||s`. Doğrulayıcı hata fırlatırsa sonuç "geçersiz"dir (çökmez).
3. `challenge`: `challengeBytes(fields)` UTF-8 olarak `challenge_text`'e eşit olmalı; `verify(approval anahtarı, bayt, imza) == expect_valid`. Session anahtarıyla atılmış imza geçersizdir.
4. `grant`: `payload`, `src/grants/store.ts` `grantSigningPayload()` çıktısıdır (tek kaynak; kök `test/contract/grant-signing-vector.test.ts` eşitliği doğrular). `verify(approval anahtarı, payload, imza) == expect_valid`.

### Kanonik kurallar

- **Sorgu** (`canonicalQuery`): baştaki `?` atılır; `&` ile bölünür, boş parçalar atılır; ilk `=`'te anahtar/değer (`=` yoksa değer boş → `a` = `a=`); `+` boşluk, `%XX` bayt olarak çözülür (UTF-8, katı; bozuk yüzde kodu ya da geçersiz UTF-8 hata); çiftler **anahtar sonra değer, UTF-8 bayt sırasıyla** sıralanır (yinelenen anahtarlar korunur, büyük harf küçükten önce gelir); yeniden kodlamada yalnız `A-Za-z0-9-._~` açık kalır, kalan her bayt `%XX` (büyük harf hex), boşluk `%20`.
- **Zarf**: `v1\n<METHOD>\n<yol[?kanonik sorgu]>\n<ts_ms>\n<nonce>\n<sha256hex(ham gövde)>`. Yöntem büyük harf; yol olduğu gibi imzalanır (çözülmez, `?`/`#`/boşluk/kontrol karakteri içermez); `ts_ms` negatif olmayan tam sayı; nonce base64url. Boş gövde `sha256("")`. Başlıklar: `X-Vlad-Device`, `X-Vlad-Ts`, `X-Vlad-Nonce`, `X-Vlad-Sig`.
- **Challenge**: `vlad-approve/v1` + `action_id, kind, repo, pr, base, head_sha, task, nonce, exp` satırları (`anahtar=değer`) bu sırayla; değer alfabesi `[A-Za-z0-9._/#:-]` ve alana özgü kalıp; eksik/fazla alan, farklı sıra, satır sonu enjeksiyonu, sonda `\n` reddedilir. `exp` unix saniye; `now >= exp` reddedilir.
- **Devir**: `vlad-grant/v1\nid=..\nscope=<type>:<ref>\naction=..\nconditions=<sıralı,virgüllü>\ncreated=..\nexpires=..\nmax_uses=..`.

### Tüketici eşlemesi

| Dil | Kanonik fonksiyonlar | Doğrulama |
|---|---|---|
| TypeScript | `server/src/auth/canonical.ts`: `canonicalQuery`, `envelopeString`, `challengeBytes`, `parseChallengeBytes` | `crypto.verify` + `dsaEncoding: "der"` |
| Kotlin (`:core`, S7a) | `crypto/Canonical.kt` aynı adlarla | `java.security.Signature("SHA256withECDSA")` (DER) |

Kotlin tarafı aynı dosyayı okuyup yukarıdaki dört adımı koşar; vektör eklemek S7b'nin (cihaz vektörü) işidir.

## Açık noktalar (varsayım)

- `POST /devices/{id}/revoke` için `approval` imzasının baytları plan'da tanımlı değil. Varsayım: `vlad-revoke/v1\ndevice=<hedef id>\nts=<ts_ms>`. S6b/S7b onaylayana kadar bu uç için imza vektörü yok; değişirse `Test itirazı` ile sorulur.
- Kapı kartı kimliği `gate-<görev id>` (görevden türetilir, depolanmaz) ve `Card.kind` enum'una `gate` eklendi: plan kapı kartının depolanmadığını söyler ama API kimliğini tanımlamaz.
- `fixtures/api/*` `synthetic`tir (sunucu henüz yok); S6c `/home` fixture'ını gerçek CLI ile karşılaştırır.
