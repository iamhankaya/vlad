---
name: second-opinion
description: Codex ile bağımsız 3. göz alır — architect planı eleştirisi (mod plan), son kapıda ana branch öncesi kod review'u (mod review) ya da iki çıktının kör A/B karşılaştırması (mod blind-compare). Kullan - /delegate plan fazında eleştiri adımında, /status son kapıda merge/PR'dan önce, iki çözümü karşılaştırırken.
---

# second-opinion — Codex 3. göz

Windows'ta tüm `codex` çağrılarına `-c 'windows.sandbox="unelevated"'` ekle (onsuz sandbox komutları "blocked by policy" ile reddeder ve repo okunamaz). Komutları **PowerShell aracıyla** çalıştır. Eleştiri modeli `gpt-6-astra`, orta efor.

**Yedek (her mod):** model yoksa ya da komut model nedeniyle başarısızsa model ve efor `-c`'leri olmadan (varsayılan modelle) **bir kez** daha dene ve bunu `vlad task log`'a yaz. Codex kurulu değilse (`codex --version` hata verir), yine başarısız olursa ya da bulut modunda Codex oturumu yoksa atla; `vlad task log <id> "Codex alınamadı: <neden>"` yaz ve kullanıcıya/plan raporuna "Codex eleştirisi (review) alınamadı: <neden>" de. Sessiz atlama yok.

## Mod `plan` — plan eleştirisi

Developer ve tester eleştirileriyle paralel. Taslağı ve spec raporunu geçici bir dosyaya yaz, eleştiri talimatını ver (uygulanabilirlik/test edilebilirlik, eksik arayüz, belirsiz görev, risk; madde madde; kod yazma):
```
codex exec -m gpt-6-astra -c model_reasoning_effort="medium" -c 'windows.sandbox="unelevated"' -s read-only -C <proje-yolu> -o <çıktı.md> "<plan taslağı + eleştiri talimatı>"
```
`<çıktı.md>`'yi oku, `vlad task log <id> "Codex eleştirisi: <kısa özet>"` yaz; bulguları son planı yazan architect agent'ına eleştiri olarak ver.

## Mod `review` — son kapı review'u

Ana branch'e merge/PR'dan önce çatının entegrasyon worktree'sinde (çok projeli çatıda her projenin worktree'sinde):
```
codex review -c model="gpt-6-astra" -c model_reasoning_effort="medium" -c 'windows.sandbox="unelevated"' --base <default_branch>
```
(`default_branch` proje kartında; `codex review`'de `-m` yok, `-c model=` kullan.) Bulguları kapıda göster. **Kritik/yüksek (P1) bulgu varsa merge/PR önerme**, düzeltme fazı öner. **Tur sınırı:** son kapıda en çok **2 düzeltme turu** (her tur = P1 yüzünden açılan düzeltme fazı + yeniden `codex review`). 2. turdan sonra P1 hâlâ çıkıyorsa merge durur ve kullanıcıya sorulur: "ana branch'e al + kalanları bulgu olarak izle" ya da "bir tur daha". **Gece modunda** (`vlad mode status`) bu kararı VLAD verir (yüksekte bekleme, düzelt: bir tur daha ya da bulguyla izleyerek al) ve gerekçesini sabah raporuna yazar. Orta/düşük/bilgi (P2) `vlad finding add` ile kaydedilip kapıda listelenir, tur açmaz.

## Mod `review` — ara kapı (faz merge'ünden önce)

Güvenlik incelemesiyle aynı tetikleyici (`/status`): faz auth/yetki/oturum/silmeye dokunuyorsa, uzak yürütme (remote/agent/ssh benzeri) içeriyorsa ya da büyük bir uygulama dilimiyse faz merge'ünden önce yalnız o fazın diff'i için, fazın worktree'sinde, tabanı entegrasyon dalı yaparak:
```
codex review -c model="gpt-6-astra" -c model_reasoning_effort="medium" -c 'windows.sandbox="unelevated"' --base vlad/<çatı-id>
```
Kritik/yüksek (P1) bulgu faz içinde değişiklik turuyla çözülür (fazı sürdüren çalışan; faz merge edilmeden); P2 bulgu `vlad finding add` ile kaydedilir, tur açmaz. Her ara düzeltme turu **ara** sayacına eklenir; son kapıdaki turlar **son** sayacına. Sayıları VLAD tutar ve son kapıda `/status` ölçüm satırını yazar. Yedek yolu ve loglama yukarıdaki gibi.

## Mod `blind-compare` — kör A/B

İki çıktıyı (plan, diff, metin) rastgele sırayla `A`/`B` olarak etiketle; hangisinin kimden geldiğini söyleme. `codex exec -s read-only` ile ölçütler (doğruluk, eksik, risk) üzerinden karşılaştırtıp tercihi ve gerekçeyi al; etiketleri ancak sonuç alındıktan sonra aç. Sonucu `vlad task log`'a yaz.

## Bulguları sunma

Codex çıktısını olduğu gibi yapıştırma: önem + `dosya:satır` + öneri biçiminde özetle, doğrulayabildiklerini ayır. Karar VLAD ve kullanıcıdadır; Codex bağlayıcı değildir.
