# delegate — bulut (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

### 5a-cloud. Bulut modu (VLAD bulutta çalışıyorsa)

`vlad task launch` komutu `launcher: cloud` ise veya `auto` + `CLAUDE_CODE_REMOTE=true` ise bulut modundadır. Yerel worktree/terminal açılmaz; komut `create_session` argümanlarını JSON olarak döner ve görevi `running` yapar. Akış:

1. `vlad task launch <id> --json` çalıştır. Hata (kartta `repo` yok, `local_only`, dev değil) → görev `queued` kalır, `error` doludur; hatayı göster, ne yapılacağını sor.
2. `integration.needs_remote_create` doğruysa entegrasyon branch'ini `integration.branch` adıyla remote'ta oluştur (GitHub MCP `create_branch`, `integration.from` branch'inden; kullanıcı onayı pipeline taslak onayında alınmıştır). Alan her launch'ta remote'taki gerçek duruma göre (`git ls-remote`) hesaplanır; çatı görevin `branch` alanına bakılmaz. Remote'a erişilemezse `true` döner ve çıktıda `warnings` dolar: `create_branch` "zaten var" derse sorun değil, devam et.
   **`create_branch` başarısız olursa** (ve branch gerçekten yoksa): `create_session` çağırma; fazı `vlad task set <id> failed` yap (`running`'den `queued`'a dönemez), hatayı göster, yeni faz öner. Çatı görevin `branch` alanı launch tarafından yazılmaz, düzeltilecek bir şey kalmaz; sonraki faz yine remote'a bakar.
3. **`create_session`'dan önce `vlad kb commit "<özet>" --push` çalıştır** (çalışan kb'yi salt okuma klonlar; görev dosyası ve bağımlı raporlar remote'ta güncel olmalı). Sonra `create_session` çağır: `source_url`, `source_revision`, `outcome_branch`, `model`, `title`, `tags`, `permission_mode`, `prompt` alanlarını çıktıdan aynen ver; çıktıda `extra_allowed_tools` varsa onu da **aynen** geçir (çalışanın `add_repo` ile kb'yi klonlayabilmesi için; çocuk ebeveynin izinlerini aşamaz, bu yüzden listeyi değiştirme).
   **Çalışan `[VLAD:LOG] kb erişimi yok` derse** (iki denemede kb klonlanamadı): `vlad task log` düş, `vlad task set <id> failed`, sonra `vlad task set <id> queued`; `vlad.config.json`'da `cloudKb: "inline"` yap (görev metni prompt'a satır içi girer, bugünkü kip) ve 5a-cloud'u baştan çalıştır. Kullanıcıya nedenini söyle; ayarı iş bitince geri almayı öner.
4. Dönen session ID'sini yaz: `vlad task session <id> <session_id>`. `create_session` başarısızsa `vlad task set <id> failed` (görev `running`'den `queued`'a dönemez); hatayı göster, yeni görev öner.
5. Prompt VLAD'ın session ID'sini (`CLAUDE_CODE_REMOTE_SESSION_ID`) taşır; çalışan REPORT/ASK/FAIL yazınca VLAD'a 1 dk sonrasına tek seferlik zamanlanmış görev kurar ("VLAD görev <id>: <durum> — ingest et"). Bu hızlı yoldur; gelmezse `/status` hatırlatması yedektir (`get_session`/`list_events` → `vlad task ingest`). Kullanıcıya session'ı, branch'i (`vlad/<id>`) ve base'i göster.

Görev ID'leri bulutta günlük `51`'den başlar (yerel VLAD ile çakışmaz). Tasarım: `docs/superpowers/specs/2026-10-20-vlad-cloud-design.md`.
