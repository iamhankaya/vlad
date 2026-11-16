# delegate — model-dagitimi (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## Model dağıtımı

**Model dağıtımı:** her görev, `model` verilmezse rolünün modelinde çalışır (görevin modeli ?? rolün modeli ?? varsayılan). Taslağın faz tablosuna **Model** sütunu koy (rol modeli ya da seçtiğin sapma) ve kuralları uygula:
- **Varsayılan:** rolün modeli; sütuna rolün modelini yaz, `--model` geçirme.
- **Haiku:** mekanik/basit fazlarda (belge, eşitleme, arama, özet) seçebilirsin; **kod yazan fazda (developer `sözleşme`/`uygulama`, düzeltme) seçme**.
- **Opus:** yalnızca en kritik işlerde (ör. güvenlik etkili tasarım, geri alınamaz veri işlemi). Gerekçesini taslakta yaz ve kullanıcının **açık onayını** al; gerekçesiz `--model opus` CLI'da reddedilir (`--model-reason` zorunlu). Onay yoksa Opus seçme.
- Pipeline'da faz başına model sapması `--phase-model <faz>=<haiku|sonnet|opus>[:<gerekçe>]` ile verilir (opus için gerekçe zorunlu; modeli rolünkiyle aynı olan faza yazma).
- Seçilen model rolün modelinden farklıysa `vlad task new` komutuna `--model <haiku|sonnet|opus> [--model-reason "<gerekçe>"]` ekle; aynıysa ekleme.
