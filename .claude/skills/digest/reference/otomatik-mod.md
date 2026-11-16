# digest — otomatik-mod (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## Otomatik mod

- **Otomatik mod:** kullanıcıya soru soramadığın her bağlamda (`/status`'un otomatik digest adımı, zamanlanmış görev, gece modu) geçerlidir. Kural: **soru sorma, emin olmadığını yazma, listeye ekle.** Şunlar kayda geçmez; bunun yerine `vlad digest pending add --text "<madde, kaynağıyla>" --task <id> --project <slug> --json` çalıştır:
  - adım 5'te "emin olmadığın karar" ("Bunu karar olarak kaydedeyim mi?" diye sorulacak olan);
  - adım 4'te kartın Açık konular'ına "kullanıcı kararı bekliyor" türü madde (3b kontrolü onay bulmadıysa bile yazma, listeye ekle);
  - adım 4b'de önemi belirsiz bulgu (önemi tahmin etme; `bilgi` yazma, listeye ekle).
  Emin olunan her şey (raporun açıkça söylediği sonuç, günlük, bulgular, kart, özet) normal yazılır.
- **Onay bekleyen liste:** `vlad digest pending list [--all] --json` / `done <id> --note "<karar>"`. Kullanıcı bir maddeye karar verince ilgili kaydı (karar/bulgu/kart) CLI ile yaz, sonra maddeyi kapat. `vlad status --summary` açık madde sayısını verir; `CLAUDE.md` Açılış maddeleri gösterir.
- **Güvenlik ağı:** olay tetikli yol (status) kaçırılırsa Mac beyin oturumu için günlük zamanlanmış görev: `docs/otomatik-digest.md`. Bulutta ve Windows'ta güvenlik ağı yoktur.
