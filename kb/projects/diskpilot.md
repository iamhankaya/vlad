---
slug: diskpilot
name: DiskPilot
path: C:\dev\diskpilot
stack:
  - csharp
  - dotnet
  - wpf
status: active
autonomy: commit
last_activity: 2026-10-18T19:00:42+03:00
last_scanned: 2026-10-16T20:50:00+03:00
---

## Özet
Windows için disk kullanımı görselleştirme ve güvenli temizlik masaüstü uygulaması. Çıkış noktası: C: diskinde yalnızca 16 GB boş yer kalmış olması. .NET 10 + WPF. Arayüz ve commit'ler Türkçe.

## Mimari notlar
- Henüz kod yok; iskelet commit'i (README, .gitignore).
- Kullanıcı kararları (2026-10-16): .NET 10 + WPF/WinUI; silme varsayılan olarak Geri Dönüşüm Kutusu'na, kalıcı silme ayrıca onaylı; sistem klasörleri korumalı.
- v1 kapsamı: klasör boyut ağacı + treemap; bilinen çöp (temp, Windows Update önbelleği, tarayıcı önbellekleri, Geri Dönüşüm Kutusu, eski log/dump); kullanılmayan dosya (uzun süredir erişilmemiş büyük dosyalar, kopyalar); geliştirici çöpü (node_modules, bin/obj, eski git worktree'leri, npm/nuget önbellekleri).
- Plan (T20261016-04): WPF tek exe; UI'dan bağımsız Core; paralel dizin taraması (yönetici gerektirmez); silme Shell `IFileOperation` + Geri Dönüşüm; handle tabanlı son yol kontrolü; normal kullanıcı + "Yönetici olarak yeniden başlat". Spec: kategoriler K1–K14, korumalı yol listesi, `SİL` onaylı kalıcı silme (T20261016-03).
- Worktree'ler: `C:\dev\diskpilot-wt\<id>`; entegrasyon branch'i `vlad/T20261016-02`.

## Son aktivite
- 2026-10-18: Plan kabul edildi (8 varsayılan onaylı); pipeline designer + sözleşme fazlarıyla yeniden yapılandırıldı; tasarım (T20261018-01) ve sözleşme (T20261018-02) başladı. (T20261016-04)
- 2026-10-18: Spec kabul edildi; Windows.old yalnızca bilgi, normal kullanıcı. (T20261016-03)
- 2026-10-16: Proje açıldı, kapsam ve teknoloji kararları alındı.

## Açık konular
- Denetim fazı: WPF penceresi Playwright ile açılamaz; ekran görüntüsü için masaüstü otomasyonu gerekebilir (T20261018-06).
- Görev 11b spike: Geri Dönüşüm'e sığmayan öğe, NukeOnDelete, kilitli/uzun yollar gerçek davranışı doğrulanacak.
- S1.2 (±%5) yalnızca yönetici taramasında; normal kullanıcıda "Hesaplanamayan alan" satırı.
