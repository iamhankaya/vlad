---
name: art-prompt
description: Karakter konsepti, portre ya da duruş gibi görseller için ChatGPT'ye verilecek istem hazırlar; kullanıcı görseli üretir, sen teslim kuralına göre dosyalarsın. Kullan - game-director/game-developer karakter ya da ana görsel gerektiren işte; Codex bu iş için kullanılmaz.
---

# art-prompt — ChatGPT için görsel istemi

Karakter konsepti/portre/duruş **Codex ile üretilmez**; istemi sen hazırlarsın, **kullanıcı ChatGPT'de üretir** (`vlad task ask` ile istemi ve beklenen teslimi ilet). Codex yalnız ikon/efekt/kod için, kısa animasyon/video için Gemini kalır.

1. **Brif:** oyun/proje, karakterin rolü, ton, paletin sınırları, kullanım yeri (portre, sprite referansı, duruş), boyut/oran. Eksikse `vlad task ask` ile sor; uydurma.
2. **Referans:** repodaki mevcut karakter/stil dosyaları ve kartın notları; yol listesi ver. Lisansı belirsiz dış görsel kullanma.
3. **İstem şablonu:** `Konu` (kim/ne, duruş), `Stil` (referansla uyumlu), `Palet`, `Işık/açı`, `Arka plan` (düz/şeffaf), `Çıktı` (oran/boyut), `Yapma` (metin, filigran, fazladan uzuv). Tek karakter için tek istem; seri için ortak "stil bloğu"nu baştan kilitle ki tutarlılık bozulmasın.
4. **Teslim:** kullanıcı görseli verince `art/source/<ad>/` altına `<ad>-<tür>-gpt-<n>.png` adıyla koy; istem ve tarihi aynı klasöre `PROMPT.md` olarak yaz (model notu: ChatGPT). Görseli kullanıcı kendisi ürettiği için ayrıca onay istenmez.
