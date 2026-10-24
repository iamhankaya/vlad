# VLAD mobil: token'lar (Material 3 tabanlı)

Compose'a çevrilebilir. Roller M3 `ColorScheme` adlarıyla birebir; `Color.kt` / `Type.kt` / `Shape.kt` / `Spacing.kt` bu tablolardan üretilir. Dinamik renk (Material You) **kapalı**: durum renkleri (kırmızı CI, bekliyor) cihaz duvar kağıdına göre kaymamalı. Tema sistemi izler (açık/koyu), uygulama içinde "Sistem / Açık / Koyu" seçilebilir.

Kaynak mockup: `mockups/index.html` aynı değerleri CSS değişkeni olarak kullanır (`--md-*`).

## Renk (açık / koyu)

| Token (M3 rolü) | Açık | Koyu | Kullanım |
|---|---|---|---|
| `primary` | `#0B6E6E` | `#5FD3D0` | Birincil buton, seçili sekme, bağlantı |
| `onPrimary` | `#FFFFFF` | `#00201F` | Birincil buton metni |
| `primaryContainer` | `#C6EFEC` | `#00504F` | Seçili sekme göstergesi, "Cevapla" tonlu buton |
| `onPrimaryContainer` | `#00201F` | `#C6EFEC` | primaryContainer üstü metin |
| `secondary` | `#4A6361` | `#B1CCC9` | İkincil vurgu, çalışan süresi |
| `onSecondary` | `#FFFFFF` | `#1C3533` | |
| `secondaryContainer` | `#CCE8E5` | `#324B49` | Filtre çipi seçili |
| `onSecondaryContainer` | `#05201F` | `#CCE8E5` | |
| `tertiary` | `#7A5200` | `#F5BC5C` | "Bekliyor / sınır" durumu, VLAD sorusu |
| `onTertiary` | `#FFFFFF` | `#432C00` | |
| `tertiaryContainer` | `#FFDEA8` | `#5E3F00` | Bekliyor etiketi arka planı |
| `onTertiaryContainer` | `#271700` | `#FFDEA8` | |
| `error` | `#B3261E` | `#F2B8B5` | Kırmızı CI, çakışma, hata |
| `onError` | `#FFFFFF` | `#601410` | |
| `errorContainer` | `#F9DEDC` | `#8C1D18` | Hata kartı/etiket arka planı |
| `onErrorContainer` | `#410E0B` | `#F9DEDC` | |
| `success` (özel) | `#1B6B3A` | `#7FD99B` | Merge edildi, CI yeşil, "bitti" |
| `onSuccess` (özel) | `#FFFFFF` | `#00391C` | |
| `successContainer` (özel) | `#CDEFD6` | `#0F4F29` | Yeşil etiket arka planı |
| `onSuccessContainer` (özel) | `#00210F` | `#CDEFD6` | |
| `background` | `#F6FAF9` | `#0E1514` | Ekran zemini |
| `onBackground` | `#161D1C` | `#DDE4E2` | |
| `surface` | `#F6FAF9` | `#0E1514` | Üst çubuk, sohbet kutusu |
| `onSurface` | `#161D1C` | `#DDE4E2` | Birincil metin |
| `surfaceVariant` | `#DAE5E3` | `#3F4947` | Çip/girdi zemini |
| `onSurfaceVariant` | `#3F4947` | `#BEC9C7` | İkincil metin (kontrast ≥ 4.5:1) |
| `surfaceContainerLow` | `#F0F5F4` | `#161D1C` | Çalışan satırı zemini |
| `surfaceContainer` | `#EAF0EE` | `#1A2120` | Kart zemini |
| `surfaceContainerHigh` | `#E4EAE9` | `#242B2A` | Bottom sheet, menü |
| `outline` | `#6F7977` | `#899391` | Girdi çerçevesi (≥ 3:1) |
| `outlineVariant` | `#BEC9C7` | `#3F4947` | Bölücü, kart çerçevesi |
| `scrim` | `#000000` @ 32% | `#000000` @ 60% | Sheet arkası |
| `inverseSurface` | `#2B3231` | `#DDE4E2` | Snackbar |
| `inverseOnSurface` | `#ECF2F0` | `#2B3231` | Snackbar metni |
| `codeSurface` (özel) | `#E4EAE9` | `#1F2625` | SHA, branch, diff alanı |

Kontrast doğrulaması: tüm metin/zemin çiftleri ≥ 4.5:1, büyük metin ve ikon ≥ 3:1 (hesaplama tasarım sırasında WCAG formülüyle yapıldı; developer `ColorContrastTest` ile çiftleri doğrular, bkz. DESIGN.md §Erişilebilirlik).

Durum → renk eşlemesi (renk **tek başına** anlam taşımaz; her zaman ikon + metin etiketi):

| Durum | Rol | İkon |
|---|---|---|
| Onay bekliyor, soru, VLAD sorusu | `tertiary` (konteyner) | `help` / `gavel` |
| Kırmızı CI, çakışma, hata | `error` | `error` |
| Çalışıyor | `primary` | `sync` |
| Bekliyor (sınır, `held_by_limit`) | `tertiary` | `schedule` |
| Takıldı (`stalled`) | `error` | `warning` |
| Bitti, merge edildi, CI yeşil | `success` | `check_circle` |

## Tipografi

Yazı tipi: **Roboto Flex** değil, sistemde hazır gelen **Roboto** (ek indirme yok; taşınabilirlik). Teknik değerler (SHA, branch, görev ID): **Roboto Mono**. Tüm boyutlar `sp`; sistem yazı boyutu %200'e kadar ölçeklenir. Ağırlıklar M3 ile aynı.

| Token | Boyut / satır (sp) | Ağırlık | İzleme | Kullanım |
|---|---|---|---|---|
| `headlineSmall` | 24 / 32 | 400 | 0 | Ekran başlığı ("Bugün") |
| `titleLarge` | 22 / 28 | 400 | 0 | Ayrıntı ekranı başlığı |
| `titleMedium` | 16 / 24 | 500 | 0.15 | Kart başlığı, bölüm başlığı |
| `titleSmall` | 14 / 20 | 500 | 0.1 | Alt başlık, çalışan adı |
| `bodyLarge` | 16 / 24 | 400 | 0.5 | Sohbet mesajı, rapor metni |
| `bodyMedium` | 14 / 20 | 400 | 0.25 | Kart özeti, liste gövdesi |
| `bodySmall` | 12 / 16 | 400 | 0.4 | Zaman damgası, yardımcı metin |
| `labelLarge` | 14 / 20 | 500 | 0.1 | Buton metni |
| `labelMedium` | 12 / 16 | 500 | 0.5 | Çip, durum etiketi, sekme etiketi |
| `monoMedium` | 13 / 20 | 400 | 0 | SHA, branch, görev ID (Roboto Mono) |

Gövde metni 12 sp altına inmez. Kısa SHA 7 hane gösterilir; ayrıntı ve onay sheet'inde 12 hane.

## Boşluk (4 dp ızgara)

| Token | dp | Kullanım |
|---|---|---|
| `space1` | 4 | İkon–metin arası |
| `space2` | 8 | Çip arası, kart içi satır arası |
| `space3` | 12 | Kart iç dikey boşluk |
| `space4` | 16 | Ekran yan boşluğu, kart iç yatay boşluk |
| `space5` | 20 | Bölümler arası (küçük) |
| `space6` | 24 | Bölümler arası |
| `space8` | 32 | Boş durum ikonu üstü |
| `space12` | 48 | Asgari dokunma hedefi |
| `minTouch` | 48 × 48 | Her dokunulabilir öğe; görsel boyut küçükse hit-area genişletilir |
| `touchGap` | 8 | Bitişik hedefler arası asgari boşluk |

Ekran yan boşluğu 16 dp; ≥ 600 dp genişlikte içerik 560 dp ile sınırlanır, ortalanır.

## Köşe

| Token | dp | Kullanım |
|---|---|---|
| `shapeXS` | 4 | SHA/branch kod çipi |
| `shapeS` | 8 | Girdi, snackbar |
| `shapeM` | 12 | Kart |
| `shapeL` | 16 | Büyük kart, diff alanı |
| `shapeXL` | 28 | Bottom sheet üst köşeleri (M3 `ExtraLarge`) |
| `shapeFull` | 50% | Çip, buton, sohbet kutusu, durum etiketi |

## Yükselti ve gölge

Düz yüzeyler (`surfaceContainer*` tonu) + çerçeve; gölge yalnız yüzen öğelerde.

| Token | Değer | Kullanım |
|---|---|---|
| `elev0` | 0 dp, `outlineVariant` 1 dp çerçeve | Kart (bekleyen karar kartında `tertiary` 4 dp sol şerit) |
| `elev1` | 1 dp | Sabit sohbet kutusu (üst kenar gölgesi) |
| `elev3` | 3 dp | Bottom sheet, menü |
| `elev6` | 6 dp | Biyometrik öncesi tam ekran onay (yok; sistem diyaloğu) |

## Hareket

Yön ve süre M3 standardı; `Settings.Global.ANIMATOR_DURATION_SCALE = 0` veya "hareketi azalt" iken geçişler anında, yalnız opaklık (anlam taşıyan ilerleme animasyonları kalır).

| Token | Değer | Kullanım |
|---|---|---|
| `durShort` | 100–150 ms | Çip, buton basılı durumu |
| `durMedium` | 250 ms | Sheet açılış, kart genişleme |
| `durLong` | 400 ms | Sekme geçişi |
| `easeStandard` | `cubic-bezier(0.2, 0, 0, 1)` | Giriş/genel |
| `easeAccelerate` | `cubic-bezier(0.3, 0, 1, 1)` | Çıkış (çıkış girişten kısa: 0.7×) |
| `streamTick` | 30–60 ms/parça | Akan cevabın parça aralığı (metin kayması yok, yalnız ekleme) |

## Bileşen ölçüleri

| Öğe | Ölçü |
|---|---|
| Üst çubuk | 64 dp |
| Alt gezinme (NavigationBar) | 80 dp, 4 hedef (Bugün, Projeler, Hafıza, Ayarlar); etiketler hep görünür |
| Sohbet kutusu | min 56 dp, çok satırda en çok 5 satır (sonra kaydırma); gönder düğmesi 48 × 48 |
| Eylem butonu | yükseklik 48 dp (görsel 40 + dikey hit-area), min genişlik 64 dp |
| Durum etiketi | yükseklik 24 dp görsel, yalnız bilgilendirici (dokunulmaz) |
| Çip (filtre) | görsel 32 dp, hit-area 48 dp |
| İkon | 24 dp (liste 20 dp), düğme içinde 24 dp |
| Parmak izi simgesi (onay sheet) | 48 dp |

## Compose eşlemesi (özet)

- `ui/theme/Color.kt`: yukarıdaki iki sütun → `lightColorScheme(...)`, `darkColorScheme(...)`; `success*`, `codeSurface` → `VladColors` (`CompositionLocal`).
- `ui/theme/Type.kt`: tablo → `Typography(...)`; `monoMedium` → `TextStyle(fontFamily = FontFamily.Monospace)` (Roboto Mono bundle edilmezse sistem monospace).
- `ui/theme/Shape.kt`: `shapeXS/S/M` → `Shapes(extraSmall, small, medium, large, extraLarge)`.
- `ui/theme/Spacing.kt`: `object Spacing { val s1 = 4.dp … }`.
- Dinamik renk: `dynamicColor = false`.
