# ntfy fixture'ları

`docs-derived-*`: ntfy **belgelerinden** türetilmiş örnekler (gerçek yakalama DEĞİL). Kaynaklar:
- Yayın (JSON): https://docs.ntfy.sh/publish/#publish-as-json
- HTTP eylem düğmesi: https://docs.ntfy.sh/publish/#send-http-request
- Abonelik akışı (`/<topic>/json`, olaylar `open|keepalive|message|poll_request`): https://docs.ntfy.sh/subscribe/api/#json-stream

**Gerçek yanıt örneği yok.** Doğrulanamayanlar: JSON publish yanıt gövdesi, düğme POST'unun akışta `message` olarak görünmesi, `Cache`/`X-Delay`/`sequence_id` ayrıntıları, ntfy.sh limitleri, iOS `http` eylemi desteği. Gerçek yakalama doğrulama fazında (telefon) alınır, maskelenip `real-*.jsonl` olarak eklenir; `docs-derived-*` ile `real-*` karışmaz, mevcutlar değiştirilmez. Gerçek akış farklıysa kabul testleri ve fixture'lar yeniden yazılır.

Konu adları, kimlikler ve etiketler uydurmadır.
