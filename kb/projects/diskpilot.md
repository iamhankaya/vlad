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
last_activity: 2026-10-16T20:50:00+03:00
last_scanned: 2026-10-16T20:50:00+03:00
---

## Özet
Windows için disk kullanımı görselleştirme ve güvenli temizlik masaüstü uygulaması. Çıkış noktası: C: diskinde yalnızca 16 GB boş yer kalmış olması. .NET 10 + WPF (WinUI alternatifi mimar fazında değerlendirilir). Arayüz ve commit'ler Türkçe.

## Mimari notlar
- Henüz kod yok; iskelet commit'i (README, .gitignore).
- Kullanıcı kararları (2026-10-16): .NET 10 + WPF/WinUI; silme varsayılan olarak Geri Dönüşüm Kutusu'na, kalıcı silme ayrıca onaylı; sistem klasörleri korumalı.
- v1 kapsamı: klasör boyut ağacı + treemap; bilinen çöp (temp, Windows Update önbelleği, tarayıcı önbellekleri, Geri Dönüşüm Kutusu, eski log/dump); kullanılmayan dosya (uzun süredir erişilmemiş büyük dosyalar, kopyalar); geliştirici çöpü (node_modules, bin/obj, eski git worktree'leri, npm/nuget önbellekleri).

## Son aktivite
- 2026-10-16: Proje açıldı, kapsam ve teknoloji kararları alındı.

## Açık konular
- WPF mi WinUI 3 mü (mimar fazı).
- Tarama hızı: MFT okuma (yönetici yetkisi) mi, paralel dizin taraması mı.
