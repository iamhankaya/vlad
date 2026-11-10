---
name: second-opinion
description: Codex ile bağımsız 3. göz alır — architect planı eleştirisi (mod plan), son kapıda ana branch öncesi kod review'u (mod review) ya da iki çıktının kör A/B karşılaştırması (mod blind-compare). Kullan - /delegate plan fazında eleştiri adımında, /status son kapıda merge/PR'dan önce, iki çözümü karşılaştırırken.
---

# second-opinion — Codex 3. göz

Windows'ta tüm `codex` çağrılarına `-c 'windows.sandbox="unelevated"'` ekle (onsuz sandbox komutları "blocked by policy" ile reddeder ve repo okunamaz). Komutları **PowerShell aracıyla** çalıştır. Eleştiri modeli `gpt-6-astra`, orta efor.

**Yedek (her mod):** model yoksa ya da komut model nedeniyle başarısızsa model ve efor `-c`'leri olmadan (varsayılan modelle) **bir kez** daha dene ve bunu `vlad task log`'a yaz. Codex kurulu değilse (`codex --version` hata verir), yine başarısız olursa ya da bulut modunda Codex oturumu yoksa atla; `vlad task log <id> "Codex alınamadı: <neden>"` yaz ve kullanıcıya/plan raporuna "Codex eleştirisi (review) alınamadı: <neden>" de. Sessiz atlama yok.

**Codex yedeği (resmi kural):** Codex kurulu değilse, limite takıldıysa ya da yukarıdaki yeniden denemeden sonra hâlâ hata veriyorsa atlamak yerine aynı moda karşılık **bağımsız reviewer agent'ı** çalıştır: Agent aracı, `reviewer` tipi, model `fable` (kullanılamıyorsa `sonnet`). Agent'a yalnız diff (`review`), plan metni (`plan`) ya da iki çıktı (`blind-compare`) verilir; VLAD'ın önceki kararları, kendi yargısı ve bağlam özeti verilmez. Sonuç bir **taslak girdidir**: bulguları VLAD doğrular; karar yine VLAD'ındır (P1 durdurma ve tur kuralları aynen geçerli). Çalıştırdığında önce `vlad task log <çatı-id> "Codex yedeği: <neden> → <model> reviewer"` yaz; son kapıda ölçüm satırındaki tur sayısı (`Codex turları: ara=<n> son=<n>`) yedek reviewer turlarını da sayar (aynı `Codex ara turu`/`Codex son turu` notları yazılır). Reviewer agent'ı da çalışmazsa eski kural: atla, `Codex alınamadı: <neden>` yaz, kullanıcıya söyle.

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
(`default_branch` proje kartında; `codex review`'de `-m` yok, `-c model=` kullan.) Bulguları kapıda göster. **Kritik/yüksek (P1) bulgu varsa merge/PR önerme**, düzeltme fazı öner. **Tur sınırı:** son kapıda en çok **2 düzeltme turu** (her tur = P1 yüzünden açılan düzeltme fazı + yeniden `codex review`). 2. turdan sonra P1 hâlâ çıkıyorsa merge durur ve kullanıcıya sorulur: "ana branch'e al + kalanları bulgu olarak izle" ya da "bir tur daha". **Gece modunda** (`vlad mode status`) bu kararı VLAD verir (P1 gerçekse düzeltme turu açar; toplam 4 turu aşmaz, sonra ana branch'e almadan durur ve sabah raporuna taşır; kalan P1 yoksa bulgu olarak izleyerek alır) ve gerekçesini sabah raporuna yazar (sabah raporu bayat proje özetlerini de listeler: `vlad status --summary --json` → `staleSummaries`). Orta/düşük/bilgi (P2) `vlad finding add` ile kaydedilip kapıda listelenir, tur açmaz.

## Mod `review` — ara kapı (faz merge'ünden önce)

Tetikleyici `/status`'taki "Ara Codex kapısı" maddesinde tek yerde tanımlıdır (güvenlik incelemesi tetikleyicisi + uzak yürütme + 500+ satırlık uygulama dilimi). Faz merge'ünden önce yalnız o fazın diff'i için, fazın worktree'sinde, tabanı entegrasyon dalı yaparak:
```
codex review -c model="gpt-6-astra" -c model_reasoning_effort="medium" -c 'windows.sandbox="unelevated"' --base vlad/<çatı-id>
```
Kritik/yüksek (P1) bulgu faz içinde değişiklik turuyla çözülür (fazı sürdüren çalışan; faz merge edilmeden); P2 bulgu `vlad finding add` ile kaydedilir, tur açmaz. Faz başına en çok 2 ara düzeltme turu (güvenlik değişiklik turundan ayrı sayılır); sonra P1 sürerse faz merge edilmez, kullanıcıya sorulur. Her ara düzeltme turunda çatıya düz not düş: `vlad task log <çatı-id> "Codex ara turu: <faz-id>"`; son kapıdaki turlar için `Codex son turu`. Son kapıda `/status` bu notları sayıp ölçüm satırını yazar (bağlam kaybolsa da sayı kb'den çıkar). Faz başka makinede koşuyorsa (`vlad task list --json` makine alanı) ara kapı atlanır ve kapıda söylenir; son kapı beyindeki entegrasyon worktree'sinde yine koşar. Yedek yolu ve loglama yukarıdaki gibi.

## Mod `blind-compare` — kör A/B

İki çıktıyı (plan, diff, metin) rastgele sırayla `A`/`B` olarak etiketle; hangisinin kimden geldiğini söyleme. `codex exec -s read-only` ile ölçütler (doğruluk, eksik, risk) üzerinden karşılaştırtıp tercihi ve gerekçeyi al; etiketleri ancak sonuç alındıktan sonra aç. Sonucu `vlad task log`'a yaz.

## Bulguları sunma

Codex çıktısını olduğu gibi yapıştırma: önem + `dosya:satır` + öneri biçiminde özetle, doğrulayabildiklerini ayır. Karar VLAD ve kullanıcıdadır; Codex bağlayıcı değildir.
