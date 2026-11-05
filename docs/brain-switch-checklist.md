# Beyin geçişi kontrol listesi

Beyin makineyi değiştirirken (ör. Windows → Mac) kb'deki yazılmamış iş kaybolmasın diye (F-vlad-196, D-vlad-055/056).

## Eski beyinde (geçişten önce)
1. Çalışan yazma kalmadığından emin ol: `vlad status --summary` (aktif `running` görev varsa bitir ya da `vlad task release <id> --force`).
2. `vlad kb commit "<özet>" --push` — kb'yi vlad-kb'ye gönder.
3. `git -C <kbDir> status` **temiz** olmalı (çıktı boş). Kirliyse commit'le ya da neden kirli olduğunu çöz; temiz değilken geçme.
4. `git -C <kbDir> log origin/main..HEAD` boş olmalı (push edilmemiş commit yok).

## Yeni beyinde
1. kb klonunu çek: `git -C <kbDir> pull --ff-only`; HEAD eski beyinin son commit'iyle aynı olmalı.
2. `vlad.config.json`'da `brain` ve `machines` doğru; `vlad machine list` yeni beyini `[brain]` işaretler; `vlad machine ping <ad>` her işçide yanıt verir.
3. `vlad status --summary` çalıştır; `UYARI: kb'de commit'lenmemiş …` çıkmamalı.

## Beyin olmayan makinede kb kirliyse
Bu makinede `vlad status` / SessionStart satırı `UYARI: kb'de commit'lenmemiş N değişiklik …` verir: işçide kb salt okunurdur, yazılanlar beyine ulaşmaz.
1. Değişikliği kaybetme: `git -C <kbDir> switch -c kurtarma-<makine>` ve `git commit -am "kurtarma"`.
2. İçeriği **beyinde `vlad` CLI ile** yeniden yaz (kb dosyalarını elle düzenleme).
3. İşçide klonu `main`'e döndür ve güncelle: `git -C <kbDir> switch main && git pull --ff-only`.
