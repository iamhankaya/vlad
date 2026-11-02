# Otomatik digest ve günlük güvenlik ağı (D-vlad-061)

## Olay tetikli yol (her yerde)

`/status` bir görevi `done` yaptığında (tek görev, pipeline fazı, son kapı) o görev için `/digest <id>` otomatik modda çalışır: günlük, bulgu, kart (Son aktivite / Açık konular), durum özeti, `vlad task digested`, `vlad kb commit … --push`. Kullanıcıya soru sorulmaz; emin olunmayan karar ve "kullanıcı kararı bekliyor" maddesi **onay bekleyen listeye** gider:

```
vlad digest pending add --text "<madde>" --task <görev-id> --project <slug>
vlad digest pending list [--all] --json
vlad digest pending done <id> --note "<karar>"
```

Liste `kb/digest-pending.json` içindedir (yalnız bu CLI yazar). `vlad status --summary` satırı `N onay bekleyen digest maddesi` gösterir; `CLAUDE.md` Açılış adımı bu maddeleri kullanıcıya sunar.

## Günlük güvenlik ağı (yalnız Mac beyin oturumu)

Olay tetikli yol atlanırsa (oturum kapandı, görev elle `done` yapıldı) işlenmemiş rapor birikir. Güvenlik ağı: Mac'teki VLAD beyin oturumuna günlük bir kez digest yaptıran zamanlanmış görev. **Bu görevi VLAD kurulumda kurar; digest fazı kurmaz.** Bulutta ve Windows'ta güvenlik ağı yoktur; olay tetikli yol her yerde çalışır.

### Prompt metni

```
Günlük digest güvenlik ağı. `vlad status --summary --json` çalıştır. İşlenmemiş rapor (inbox + done ama digested boş görev) 0 ise ve staleSummaries boşsa hiçbir şey yapma, "güncel" de. Aksi halde `/digest` skill'ini OTOMATİK MOD'da çalıştır: kullanıcıya soru sorma; emin olmadığın karar/"kullanıcı kararı bekliyor" maddelerini yazma, `vlad digest pending add` ile listeye ekle. Sonunda `vlad kb commit "digest <YYYY-MM-DD>" --push`. Kısa özet ver: işlenen rapor sayısı, onay bekleyen madde sayısı.
```

### Kurulum adımı

Beyin oturumunun ID'sini al (`vlad session register` ile kayıtlı ad; `mcp__claude-code-remote__get_session` ya da `list_sessions`). Sonra `create_trigger`:

- `persistent_session_id`: Mac beyin oturumunun ID'si (hedef oturumu uyandırır; `create_new_session_on_fire` kullanma, kb yerel klonuna yalnız beyin yazar, D-vlad-056).
- `cron_expression`: saat dilimini açık yaz, ör. her gün 09:07 İstanbul: `CRON_TZ=Europe/Istanbul 7 9 * * *` (dakika :00/:30 olmasın; 06–09 Pasifik saatleri gecikmeli). Saat dilimi yazılmazsa alanlar UTC sayılır.
- `name`: `Günlük digest güvenlik ağı`; `initiation`: `human_request` (kullanıcı kurulumu istediğinde).
- `prompt`: yukarıdaki metin.

Doğrulama: `list_triggers` ile `next_run_at` ve `persistent_session_id` kontrol edilir; ilk koşuda `last_run` bakılır. Kaldırmak: `update_trigger enabled=false` ya da `delete_trigger`.

Not: Mac beyin oturumu kapalıysa zamanlanmış mesaj oturum açılınca teslim edilir; `vlad kb commit --push` sonrası kb tek yazar kalır.
