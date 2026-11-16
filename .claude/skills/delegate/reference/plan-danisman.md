# delegate — plan-danisman (reference)

> `SKILL.md`'den taşındı; metin aynen korunmuştur. SKILL.md'deki tetikleyici satır bu dosyayı okumanı söyler.

## 6. Plan fazı: yaz–eleştir

`plan` fazı (architect, research) tek görev içinde sırayla yürür; "birlikte oturma" budur (spec §7):
1. `vlad task set <id> running --json`
2. **Taslak:** architect rolüyle arka plan agent'ı (5b'deki rol, skill ve `depends_on` cümleleriyle; girdi spec fazının raporu). Rolün `## Çıktı` başlıklarıyla taslak plan döndürür. Taslağı geçici dosyada tut; `vlad task log <id> "Plan taslağı hazır"`.
   Bu adımdaki tüm arka plan agent'larını (taslak, eleştiri, son plan) kullandıkları rolün modeliyle başlat, plan görevinin kendi `model`'i varsa (`effective_model`) onunla (Agent aracının `model` parametresi); ikisi de boşsa varsayılan.
3. **Eleştiri:** iki arka plan agent'ı paralel — biri `roles/developer.md`, biri `roles/tester.md` rol dosyasıyla. Prompt: spec raporu + taslak plan; "Rol dosyasından yalnızca rolün bakış açısını al; Yetki, iş akışı ve commit kuralları bu görevde geçerli değil. Kendi rolünün gözüyle eleştir: uygulanabilirlik/test edilebilirlik, eksik arayüz, belirsiz görev, risk; madde madde. Kod yazma, dosya değiştirme, skill yükleme." Her biri için `vlad task log <id> "<Developer|Tester> eleştirisi: <kısa özet>"`.
   **Codex eleştirisi (3. göz):** iki agent'la paralel, `second-opinion` skill'ini **Skill aracıyla yükle**, mod `plan` ile uygula (komutu elle kopyalama; komut, model, yedek ve loglama orada; Codex yoksa/limit/hata → `integrate` K4 reviewer yedeği). Skill yüklenemezse eleştiri adımı durur ve kullanıcıya söylenir.
4. **Son plan:** architect agent'ına taslak + eleştirileri (developer, tester, varsa Codex) ver; son planı ve `### Eleştiriler ve nasıl ele alındı` bölümünü yazdır.
5. Rapora yalnızca son plan girer (ara ürünler log'da kalır): `vlad task report <id> --file <plan.md> --json`, sonra 5b adım 5.

**Safeguard kesintisi:** architect/Sonnet agent'ı güvenlik filtresiyle kesilirse aynı taslağı kısa, temiz bir bağlamla yeniden iste (yalnız girdi raporu + görev dosyası). İkinci kesintide taslağı Codex tek başına yazsın (`second-opinion` skill'i) ve `vlad task log <id> "Safeguard kesintisi: <ne>"` düş.

## 7. Danışman yan görevleri

Danışman (`advisor`: finans, pazarlama, growth odakları) herhangi bir fazdan (taslakta ya da fazlar sürerken) danışılabilir. Kullanıcıya yan görevi kısa bir taslakla göster, onay al:
```
vlad task new --project <slug> --title "<başlık> — danışma: <konu>" --kind research --role <finans|pazarlama|growth> --parent <çatı-id> --phase danışma --body-file <danışma.md> --json
```
`--role` değeri `advisor`'ın odağıdır (eski slug alias; rol dosyası `advisor.md`). Bağımlılık verilmez; hemen 5b ile yürüt. Sonucu ilgili fazın bağlamına ekle: faz henüz oluşturulmadıysa özetini o fazın `## Bağlam`'ına yaz; oluşturulduysa `vlad task log <faz-id> "Danışma <yan-id>: <özet> — raporuna bak"`. Çalışanlar kardeş görevleri de okur.
