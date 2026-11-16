# delegate — launch-ayrintilari (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## Çok makine

- **Çok makine** (`vlad.config.json`'da `machines` varken): kartın `machines` listesi (`vlad project set <slug> machines …`; sıra = tercih) görevin nereye yerleşebileceğini belirler. `launch` makineyi kartın sırası, kapasite (`maxParallel`) ve ulaşılabilirliğe göre kendisi seçer; belirli bir makine için `vlad task launch <id> --machine <ad> --json` (ad kartın listesinde olmalı). Pipeline'da çatı ilk fazın makinesine sabitlenir (pin); sonraki fazlar aynı makinede açılır. Uzak launch'ta beyin önce kb'yi commit+push eder, işçi senkronlar, sonra çalışan işçide açılır. Taslakta kartta `machines` varsa yerleşimi (otomatik ya da `--machine`) bir satırla göster. Makine ulaşılamazsa komut çıkış kodu **75** verir: görev `queued` kalır, `vlad machine ping <ad>` ile bak ve tekrar dene; belirsiz rezervasyon için `vlad task release <id>` (`/status`). `--external` uzak makinede desteklenmez.

## --external ve --dry-run

- `--external` (vlad-desktop gibi gömülü istemciler): worktree + branch + güven kaydı + `running` aynen yapılır, terminal AÇILMAZ; JSON'da `script` (Windows: `%TEMP%\vlad\<id>.ps1`; POSIX: `$TMPDIR/vlad/<id>.sh`), `command` ve `cwd` döner, pencereyi istemci açar. Bulut modunda reddedilir.
- `--dry-run` önizleme değildir: worktree + branch oluşturur ve görevi terminal açmadan `running` yapar (yalnızca test içindir). Bu yüzden "önce dry-run ile göster" diye kullanma.
