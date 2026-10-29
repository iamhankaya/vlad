---
name: ci-triage
description: autonomy pr çalışanının push sonrası CI'ı izleyip kırmızıyı sınıflaması ve tur kuralını uygulaması. Kullan - vlad/<id> dalını push ettikten sonra, CI kırmızı çıktığında ya da CI izlerken bellek/oturum uyarısı aldığında.
---

# ci-triage — CI izleme ve sınıflama

Yetki: yalnız `vlad/<id>` push edebilir ve CI'ı izleyebilirsin; başka dala push, `--force`, ana/entegrasyon dalına merge/PR yok.

1. **Run bul, tek izle:** `gh run list --branch vlad/<id> --limit 1` ile run'ı bul, `gh run watch <run-id> --exit-status --interval 60` ile **tek** kez izle (varsayılan 3 sn aralık paralel çalışanlarda GitHub API sınırını tüketir; 4+ paralel çalışan varsa `--interval 90`). Yoklama döngüsü kurma. Watch bitince (yeşil ya da kırmızı) aynı turda devam et: yeşilse raporu yaz ve bildirimi gönder (`vlad-worker` adım 6–7), kırmızıysa adım 2; "izliyorum" diye turu bitirme. Push ve `gh` komutlarını tek başına çalıştır (`cd`/`&&` zinciri izin kuralıyla eşleşmez).
2. **Kırmızıyı sınıfla:** `gh run view <run-id> --log-failed`. Sınıf: (a) kendi değişikliğin, (b) entegrasyon dalından gelen (senin değişikliğin olmayan), (c) ortam/altyapı, (d) Linux farkı (yerelde Windows'ta yeşil), (e) bayat kayıt dosyası.
3. **Tur kuralı:** kendi kırmızını düzeltip yeniden push edersin; aynı neden (aynı hata imzası, yeni run'da da) ikinci kez kırmızı çıkarsa dur ve `vlad task ask <id> "CI: <neden>, 2. tur"` sor. Entegrasyondan gelen kırmızı tur sayılmaz: düzeltmeye çalışma, raporun `### Açık noktalar`'ına yaz.
4. **Bırak:** bellek/oturum uyarısı ya da 20 dk sessizlik olursa izlemeyi bırak, `vlad task log <id> "CI: <run-id> izleniyor/bekliyor"` yaz ve raporla; boşta bekleyerek oturum tüketme.
5. **Linux farkı ön denetimi** (push'tan önce): betik dosyaları `100755` mi (`git ls-files -s`), kayıt dosyaları üretici betiğin çıktısıyla aynı mı (check modu), lint temiz mi, yol büyük/küçük harf ve ayırıcıları Linux'ta çalışır mı.
