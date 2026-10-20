---
slug: diskpilot
name: DiskPilot
path: C:\dev\diskpilot
exposure: local
local_only: true
local_only_reason: WPF masaüstü uygulaması; bulutta (Linux) derlenip çalıştırılamaz
stack:
  - csharp
  - dotnet
  - wpf
status: active
autonomy: commit
last_activity: 2026-10-19T15:22:00+03:00
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
- 2026-10-19: Düzeltme fazı T20261019-04 başladı; doğrulama -05 ve denetim -06 bekliyor. (T20261016-02)
- 2026-10-19: Denetim: 17 bulgu, 1 yüksek (öneri listesi Tab ile erişilemiyor). (T20261019-03)
- 2026-10-19: Doğrulama: `SHQueryRecycleBin` x64'te hep 0 (gerçek hata), recycler testleri paralelde kararsız. (T20261019-02)
- 2026-10-19: Kabul düzeltmeleri: 43 kırmızıdan 36'sı yeşil, 7 "testin kendisi yanlış". (T20261019-01)
- 2026-10-19: Uygulama: Core/Platform/WPF; birim testleri yeşil. (T20261018-04)
- 2026-10-19: Kabul testleri: 439 test. (T20261018-03)
- 2026-10-18: Tasarım (DESIGN.md) ve sözleşme fazları bitti. (T20261018-01, T20261018-02)
- 2026-10-18: Plan kabul edildi; pipeline designer + sözleşme fazlarıyla yeniden yapılandırıldı. (T20261016-04)
- 2026-10-18: Spec kabul edildi; Windows.old yalnızca bilgi, normal kullanıcı. (T20261016-03)
- 2026-10-16: Proje açıldı, kapsam ve teknoloji kararları alındı.

## Açık konular
- `SHQueryRecycleBin` x64'te (0,0) dönüyor; K5 Geri Dönüşüm boyutu gerçek sistemde 0 (T20261019-02, düzeltme T20261019-04'te).
- `ShellRecyclerRealTests` paralel assembly koşusunda kararsız (T20261019-02).
- 7 kabul testi için "testin kendisi yanlış" önerisi ve 2 RealDisk testi (S1_2 FreeBytes yarışı, S2_7) (T20261019-01/-02).
- Denetim B1 (yüksek): öneri listesine Tab ile erişilemiyor; ayrıca 6 orta, 6 düşük bulgu (T20261019-03).
- Koyu tema ve Windows yüksek kontrast çalışırken doğrulanmadı (T20261019-03).
- Görev 11b spike: Geri Dönüşüm'e sığmayan öğe, NukeOnDelete, kilitli/uzun yollar gerçek davranışı doğrulanacak.
- S1.2 (±%5) yalnızca yönetici taramasında; normal kullanıcıda "Hesaplanamayan alan" satırı.

