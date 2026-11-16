---
name: release
description: Projenin deploy'unu ve/veya APK/mobil build'ini GitHub Actions ile yürütür — ayrı kullanıcı onayı, workflow dispatch, run takibi, sağlık kontrolü, APK artifact bilgisi, görev günlüğüne kayıt. Kullan - kullanıcı "deploy et", "canlıya al", "APK üret", "preview build al" dediğinde ya da bir görev/çatı main'e girdikten sonra sürüm istendiğinde.
---

# release — deploy ve APK

Deploy ve APK **her seferinde ayrı, açık kullanıcı onayı** ister: gece modu, `night.push`, önceki bir deploy kararı ya da kapı onayı bunu kapsamaz (`integrate` K7: `deploy` istisna sınıfı; APK da aynı muameleyi görür). Onay "o proje, o dal/sha, o eylem (deploy | APK)" içindir; "sanırım istiyor" yetmez.

## 1. Sürüm bilgisini oku

Proje kartındaki `## Sürüm` bölümü tek kaynaktır (`<kbDir>/projects/<slug>.md`; `kbDir` `vlad.config.json`'dan; kartı baştan sona değil yalnız bu bölümü oku). Beklenen satırlar:

```
- deploy: gh workflow run deploy.yml -R <owner>/<repo> --ref main -f mode=deploy
- sağlık: <URL> → {"status":"ok","db":"up"}
- apk: gh workflow run mobile-build.yml -R <owner>/<repo> --ref main -f profile=preview -f local=true
```

Bölüm ya da gereken satır yoksa **uydurma**: kullanıcıdan komutu/URL'yi iste, onayla birlikte kartı güncelle (kartı `vlad project write <slug> --file <md>` ile yaz: kartı oku, `## Sürüm` bölümünü ekle/güncelle, geçici dosyaya yaz; `kb/` dosyasını elle düzenleme) ve `vlad kb commit "<özet>" --push` çalıştır. Medialog örneği (D-medialog-044): deploy `gh workflow run deploy.yml -R iamhankaya/medialog --ref main -f mode=deploy`, APK `gh workflow run mobile-build.yml -R iamhankaya/medialog --ref main -f profile=preview -f local=true`; sağlık beklentisi `{"status":"ok","db":"up"}`.

## 2. Ön kontrol ve onay

- Dispatch edilecek dal (`--ref`) uzakta güncel mi? `git -C <proje-yolu> fetch origin` sonra `git -C <proje-yolu> rev-parse origin/<ref>`; yerel `main` push edilmemişse deploy eski kodu çıkarır: kullanıcıya söyle, push onayı ayrıdır.
- Kullanıcıya tek mesajda göster: proje, eylem (deploy / APK / ikisi), `--ref` + kısa sha, çalışacak komut. **Açık "evet" bekle.** İki eylem istenmişse ikisi için ayrı ayrı onay al (sıra: önce deploy + sağlık, sonra APK).

## 3. Dispatch

Onaydan sonra komutu kartta yazdığı gibi, tek başına çalıştır (zincir/`cd` yok). Dispatch çıktısı run ID vermez; run'ı bul:

```
gh run list -R <owner>/<repo> --workflow <dosya.yml> --branch <ref> --limit 3 --json databaseId,status,createdAt,url
```

Dispatch'ten sonra oluşmuş en yeni run'ı al (`createdAt` ≥ dispatch zamanı; birden çok aday ya da hiç yoksa birkaç saniye sonra yeniden dene, tahmin yürütme). Sonra tek bir bekleme:

```
gh run watch <run-id> -R <owner>/<repo> --exit-status --interval 60
```

Yoklama döngüsü kurma. Kırmızıysa: `gh run view <run-id> -R <owner>/<repo> --log-failed` ile nedeni özetle, **kendiliğinden yeniden dispatch etme**; kullanıcıya sor.

## 4. Sonuç kontrolü

- **Deploy:** kartın `sağlık` URL'sine `curl -fsS <URL>`; yanıt beklenen gövdeyle (ör. `{"status":"ok","db":"up"}`) eşleşmeli. Eşleşmezse başarı deme: yanıtı göster, kullanıcıya bildir (geri alma kararı kullanıcınındır).
- **APK:** `gh run view <run-id> -R <owner>/<repo> --json artifacts,url` ya da `gh api repos/<owner>/<repo>/actions/runs/<run-id>/artifacts` ile artifact adı ve boyutunu (MiB) al; indirme bağlantısı olarak **run URL'sini** ver (artifact doğrudan bağlantısı oturum ister). **30 MiB üstü APK sohbete gönderilmez** (indirip eklemeye çalışma); altındaysa ve kullanıcı isterse `gh run download <run-id> -R <owner>/<repo> -n <artifact> -D <geçici-dizin>` ile geçici dizine indir.

## 5. Kayıt

İlgili çatı (ya da tek görev) için, sonuç yeşil ya da kırmızı fark etmeden:

```
vlad task log <çatı-id> "Deploy: <proje> <ref>@<sha7> run <run-id> başarılı, sağlık ok"
vlad task log <çatı-id> "APK: <proje> <ref>@<sha7> run <run-id> başarılı, <artifact-adı> <boyut> MiB, <run-url>"
```

Başarısızda `başarısız (<neden>)` yaz. Görev yoksa kaydı kullanıcıya özetle; günlük/digest akışı bunu sonra işler. Kullanıcıya sonda: eylem, run URL'si, sağlık sonucu ya da APK adı/boyutu/bağlantısı.

## Sınırlar

- `gh workflow run` yalnız kartta yazılı workflow/bayraklarla; kullanıcının onaylamadığı bayrak (`mode`, `profile`) değiştirilmez.
- Canlıya veri yazan eylem (migration/backfill, `mode=deploy` dışı modlar) bu skill'in kapsamı değildir; ayrı onay ve `integrate` K7 sınıfları geçerlidir.
- Bulutta (`CLAUDE_CODE_REMOTE=true`) `gh` yoksa dur ve kullanıcıya söyle.
