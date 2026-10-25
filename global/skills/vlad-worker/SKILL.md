---
name: vlad-worker
description: VLAD tarafından başlatılmış bir çalışan session'ının protokolü. Başlangıç prompt'u "Sen bir VLAD çalışanısın" diyorsa veya VLAD_TASK_ID ortam değişkeni tanımlıysa, göreve başlamadan önce yükle ve adımları sırayla uygula.
---

# VLAD çalışan protokolü

> **Bulut çalışanı:** başlangıç prompt'u görevi satır içi veriyor ve "VLAD bulut protokolü" bölümü içeriyorsa bu skill'i yükleme; tek doğru kaynak prompt'taki "VLAD bulut protokolü"dür (`src/tasks/cloud.ts`). Aşağıdaki 0–7. adımlar yerel (Windows) çalışanlar içindir.

Sen VLAD'ın devrettiği tek bir görev üzerinde çalışan bir session'sın. Kullanıcıyla Türkçe konuş. **Doğruluk kaynağı görev dosyasıdır**; ilerlemeni, sorularını ve raporunu her zaman `vlad` CLI ile oraya yaz.

## 0. Görevini bul

- Görev ID'si ortamdadır: `VLAD_TASK_ID` (Bash: `echo $VLAD_TASK_ID`, PowerShell: `$env:VLAD_TASK_ID`).
- VLAD kökü: `VLAD_HOME` (yoksa `C:\dev\vlad`). Görev dosyası: `<VLAD_HOME>/kb/tasks/<id>.md`.
- `VLAD_TASK_ID` yoksa dur ve kullanıcıya görev ID'sini sor.

## 1. Oku

- Görev dosyası: `## Tanım`, `## Kabul kriterleri`, `## Bağlam`, frontmatter'daki `project`, `autonomy`, `branch`.
- Proje kartı: `<VLAD_HOME>/kb/projects/<project>.md` (`Read` ile; kb ayrı repodur, kök `VLAD_KB_DIR` ya da `vlad.config.json`'daki `kbDir` ile çözülür, ayarsızsa `<VLAD_HOME>/kb`). Kartın `gate` alanı (projenin tek kapı komutu) ve `## Çalışma notları` bölümü kart dosyasından okunur; bu bilgiler için CLI listeleme komutu kullanılmaz. Çalışma notları bu projede öğrenilmiş derslerdir (test ortamı, tuzaklar, kalıplar); işe başlamadan oku ve uy.
- Rol: frontmatter'da `role` doluysa `<VLAD_HOME>/roles/<role>.md`'yi oku (başlangıç prompt'u da bu dosyayı söyler). Rolün sorumluluk, yetki ve çıktı kuralları bu protokolle birlikte geçerlidir; rol kuralı ile `autonomy` kuralı çelişirse **daha kısıtlayıcı** olan uygulanır. Kapanış raporunu rolün `## Çıktı` bölümündeki başlıklarla yaz (adım 6'daki başlıklar her durumda bulunur).
- Pipeline fazı: frontmatter'da `parent` doluysa bir pipeline'ın `phase` fazısın. `<VLAD_HOME>/kb/tasks/` altındaki `parent` alanı aynı olan görev dosyalarını `Read`/`Grep` ile tarayarak kardeş fazları gör; `depends_on`'daki her görevin `<VLAD_HOME>/kb/tasks/<dep-id>.md` dosyasındaki `## Kapanış raporu`'nu oku — fazın girdisi (spec, plan, test matrisi…) budur. Danışma fazlarının (`phase: danışma`) raporları da bağlamdır.
- Bu dosyaları **elle düzenleme**; yalnızca okursun.
- Çalıştığın klasör görevin worktree'sidir ve `vlad/<id>` branch'indesin (`git branch --show-current` ile doğrula). Pipeline fazındaysan branch'in ana branch'ten değil entegrasyon branch'i `vlad/<parent>`'tan açıldı; diff ve log tabanın odur (`git log --oneline vlad/<parent>..HEAD`).

## 2. Çalış (yetki seviyene göre)

- `autonomy: plan` → Yalnızca plan yaz, kod yazma. Planı `vlad task report` ile onaya sun (adım 6) ve dur.
- `autonomy: commit` / `pr` → Mevcut iş akışını kullan: brainstorming/plan → TDD → review. Kabul kriterlerinin her birini karşıla.

## 3. İlerleme kaydı

Önemli adımlarda (plan hazır, ilk testler geçti, review bitti vb.):
```
vlad task log <id> "<kısa Türkçe açıklama>"
```
Uzun süre sessiz kalma: kayıt `staleAfterHours`'tan eskirse görev `stalled` sayılır.

**Checkpoint kuralı:** oturum limiti veya çökme seni her an kesebilir. Her anlamlı adımda (test yeşile döndü, bir dosya/modül bitti, review düzeltmesi) WIP commit at (`git commit -m "wip: <ne>"`) ve `vlad task log <id> "kaldığım yer: <sonraki adım>"` yaz. Kaydedilmemiş iş bırakma.

**Devam mesajı gelince** (VLAD `vlad task resume` ile seni sürdürür): işe başlamadan önce `git branch --show-current` (`vlad/<id>` olmalı) ve `git status` çalıştır, çalışma dizininin görevin worktree'si olduğunu doğrula; ana dizinde veya başka branch'te çalışma. Kirli ağaç varsa incele, anlamlıysa WIP commit'le; sonra son "kaldığım yer" satırından devam et.

## 4. Soru sorma

**Test itirazı:** pipeline'da kabul testini yanlış buluyorsan raporda bırakma; sorunu `vlad task ask <id> "Test itirazı: <test yol:satır>, tester görevi <T…> — neden yanlış, önerin"` ile sor. VLAD tester'a yönlendirir ya da karar verir; testi kendin değiştirme.

Kullanıcı kararı gerektiren bir belirsizlikte tahmin yürütme:
```
vlad task ask <id> "<soru, seçenekleriyle>"
```
Ardından **bildirim gönder** (adım 7) ve cevabı bekle.

**Sunucu modu (Linux, `systemd-run` ile açılan headless çalışan):** `vlad task ask`'tan sonra turunu hemen bitir; süreç çıkar ve görev `blocked` kalır. Cevap `vlad task answer` ile yazılınca VLAD `vlad task relaunch <id>` ile oturumunu `--resume` eder ve cevabı prompt olarak verir; kaldığın yerden devam et. Çıktın `vlad worker tap` ile süzülür (`session_id`, son adım, kota); bunun için ek bir şey yapma. Cevap görev dosyasının `## Sorular` bölümüne `**Cevap:**` olarak yazılır; bildirim gelince veya kullanıcı söyleyince dosyayı yeniden oku.

## 5. Commit ve sınırlar

- Yalnızca `vlad/<id>` branch'inde commit'le.
- `autonomy: pr` ise: `git push -u origin vlad/<id>` ve `gh pr create`.
- **Asla merge etme. Asla başka bir branch'e push etme.** `autonomy: commit` veya `plan` ise hiç push etme.
- Pipeline fazında da aynı: entegrasyon branch'ine (`vlad/<parent>`) ya da ana branch'e asla merge etme, PR açma; entegrasyonu VLAD kullanıcı onayıyla yapar. `autonomy: pr` olsa bile yalnızca `vlad/<id>`'yi push et.

## 6. Kapanış raporu

**Entegrasyon öncesi kontrol (pipeline fazı, `parent` dolu):** rapordan önce entegrasyon branch'ini (`vlad/<parent>`) kendi branch'ine merge et (`git merge vlad/<parent>`; bu, kendi branch'ine güncel tabanı almaktır, entegrasyon branch'ine merge değildir), sonra lint + `gate` (yoksa tam test/build) koş. Çakışma veya kırmızı varsa kendi kapsamındaysa düzelt; değilse (başka fazın kodu, ortam) çözmeye çalışma, raporun `### Test sonuçları`'na kanıtıyla ve `### Açık noktalar`'a `- [yüksek] entegrasyon kontrolü kırmızı — …` olarak yaz. Merge'ü geri alma gerekirse `git merge --abort`. Faz kapısında sürpriz çıkmasın diye kapıdan önce koşulur.

Rapordan önce proje kartında `gate` alanı varsa (kart dosyasında `gate`, `Read` ile) o komutu worktree'de çalıştır ve sonucunu (komut, çıkış kodu, kırmızıysa özet) `### Test sonuçları`'na yaz. `gate` yoksa projenin bilinen build/test komutlarını çalıştır ve "gate tanımlı değil" diye not düş.

Bitince raporu Markdown olarak geçici bir dosyaya yaz. Başlıklar yalnızca `###` veya daha derin olmalı; `## ` ile başlayan satır görev dosyasının bölümünü böler:
```markdown
### Yapılanlar
### Test sonuçları
(çalıştırılan komutlar ve sonuçları; kartta `gate` varsa önce o)
### Kabul kriterleri
(her biri: karşılandı / karşılanmadı + neden)
### Açık noktalar
(ertelenen/çözülmeyen her nokta tek madde: `- [önem] başlık — ayrıntı`; önem: kritik|yüksek|orta|düşük|bilgi. `/digest` bunları bulgu kaydına geçirir)
```
ve:
```
vlad task report <id> --file <rapor.md>
```
Görev `awaiting_approval` olur. Ardından **bildirim gönder** (adım 7).

## Faz PR'ı (sunucu modu)

Sunucu modunda (Linux, `systemd-run` çalışanı) görev tamamlanınca PR'ı VLAD değil çalışan açar; kapanış raporundan **önce** şu sırayı uygula:

1. `git push -u origin vlad/<id>` (yalnız kendi branch'in).
2. PR aç: `gh pr create --base <taban> --head vlad/<id>`. Taban kuralı: pipeline fazında (`parent` dolu) taban entegrasyon branch'i `vlad/<çatı-id>`; son kapıda (çatı görev ya da `parent`'sız görev) taban projenin ana branch'i.
3. `vlad task pr <id> --number <N> --repo <owner/ad> --base <taban> [--url <PR adresi>]` ile PR'ı göreve kaydet.
4. `vlad task report <id> --file <rapor.md>` (adım 6).

PR açılamazsa (yetki, ağ) `vlad task pr` **çalıştırma**; nedenini raporun `### Açık noktalar`'ına yaz ve raporla devam et. Merge etme.

## 7. VLAD'a bildirim

Durum değiştiğinde (soru sordun, rapor yazdın):
1. VLAD'ın kayıtlı oturum adını `<kb>/vlad-session.txt` dosyasından `Read` ile oku ve `ListAgents` çalıştır.
2. Hedef adı seç:
   - Dosyadaki ad `ListAgents` listesinde varsa onu kullan.
   - Yoksa (dosya yok veya ad listede değil): `ListAgents`'ta adı `vlad-` ile başlayan session'lara bak (VLAD `C:\dev\vlad`'da çalışır). Tam olarak bir tane varsa onu kullan.
   - Hiçbiri yoksa veya birden fazla `vlad-` session'ı varsa bildirimi **sessizce atla**.
3. Hedef varsa:
   `SendMessage({to: "<ad>", message: "VLAD görev <id>: <state> — görev dosyasına bak"})`
   (`<state>`: `blocked`, `awaiting_approval` veya `failed`).

Bildirim yalnızca bir dürtmedir; asıl bilgi görev dosyasındadır. Bildirim gönderilemezse VLAD durumu `/status` ile dosyadan okur — bu bir hata değildir.

## Hata durumu

Görevi tamamlayamıyorsan (ortam bozuk, gereksinim imkânsız) nedenini `vlad task log <id> "…"` ile yaz, sonra `failed` durumuyla bildirim gönder (durumu VLAD yazar).

## Bulut modu (`create_session` ile açılan çalışan)

Bulut çalışanı bu skill'i kullanmaz: `kb/`, `vlad` CLI'ı ve görev dosyası yoktur; `kb/`'ye yalnızca VLAD yazar. Çalışan, prompt'unun sonundaki **"VLAD bulut protokolü"** bölümünü uygular (rol gövdesindeki "vlad-worker protokolünü uygula" ve Yetki'deki `kb/`/CLI/worktree adımları yerine geçer). İşaretler (`LOG`/`ASK`/`REPORT`/`FAIL`), `ANSWER` mesajı, push kuralı ve "son tur mesajında tüm işaretleri tekrar et" kuralı orada tanımlıdır; VLAD bunları `vlad task ingest` ile işler (tasarım: `docs/superpowers/specs/2026-10-20-vlad-cloud-design.md` §5).
