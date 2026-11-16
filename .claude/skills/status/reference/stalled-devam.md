# status — stalled-devam (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## Stalled görev: devam ve uzak makine

- **Devam:** önce `vlad task resume <id> --json` (yalnızca `running`/`stalled`). Hata verirse (worktree yok, yanlış branch, session yok) mesajı göster; **yanlış worktree'de devam ettirme**. Başarılıysa (sürdürme ve her `SendMessage` uyandırmasından sonra çalışan için `notify_when_idle: true` aboneliğini yeniden kur, `/delegate` 5a; idle bildirimi gelince görev dosyasını oku, durum değişmemişse çalışanı dürt):
  - `mode: "local"`: `dirty` doluysa kullanıcıya söyle; `stalled` ise `vlad task set <id> running --json`; kullanıcıya `worktree` yolunda devam etmesini ve `prompt`'u çalışana vermesini öner (`claude --resume <session_id>` ile birlikte; session_id yoksa `vlad task resume` çıktısındaki yönergeyi izle).
  - Gömülü istemci (vlad-desktop) için `vlad task resume <id> --external --json` devam prompt'lu betik yazar ve `script`/`command`/`cwd` döner (terminal açmaz). Çalışan penceresini kapatmak için `vlad task close-window <id>` (durum ve worktree değişmez). Yan etkisiz durum okuması: `vlad status --json --no-mark`.
  - `mode: "cloud"`: `stalled` ise `vlad task set <id> running --json`; `args` ile `send_message` çağır (`session_id`, `message`). Bu bir dış eylem değil, mevcut çalışana devam mesajıdır.
  Kesilen çalışanları (oturum limiti, çökme) bu yolla sürdür; yeni görev açma.
- **Uzak makine erişilemiyor:** `error: makine erişilemiyor: <ad>` ile `stalled` olan görevde önce `vlad machine ping <ad>`; makine dönünce `vlad task resume <id> --json` işçide `claude --resume` ile sürdürür (çıkış kodu 75 = geçici, tekrar dene). Makine kalıcı ölüyse `vlad task release <id> --force` rezervasyonu bırakır; yetim pencere riskini kullanıcıya söyle.
