# kb-mini

Sentetik, sabit kb (gerçek kb'den veri taşımaz). `vlad` CLI ile üretildi: iki proje kartı (`alpha`: exposure/gate dolu, `legacy`: gate/exposure yok), görevler (running, blocked, stalled, awaiting_approval, done, cancelled, queued + pipeline çatısı/faz), bulgular (open/deferred/fixed), kararlar (geçerli/yerine-geçti/geçersiz/süreli 2099), günlük ve inbox raporu.
`schemas/` ve `roles/` kopyalanmaz; kullanan test bunları repodan alır. Gerçek kb'ye karşı opsiyonel kontrol: `VLAD_REAL_KB=1`.
