---
slug: diskpilot-mobile
name: DiskPilot Mobile
path: C:\dev\diskpilot-mobile
repo: iamhankaya/diskpilot-mobile
default_branch: main
exposure: local
local_only: false
gate: "./gradlew lintDebug testDebugUnitTest assembleDebug (yalnızca CI/main);
  bulutta yerel kapı: ./gradlew -PskipAndroid=true :core:test"
stack:
  - kotlin
  - android
  - jetpack-compose
status: active
autonomy: commit
last_activity: 2026-10-22T12:00:00+03:00
last_scanned: null
---

## Özet
DiskPilot'un Android sürümü: depolama görselleştirme ve güvenli temizlik. Store'a çıkmaz; yalnızca kullanıcının telefonuna (Xiaomi Redmi Note 13 Pro) APK olarak kurulur. Kavramlar DiskPilot'tan alınır, kod paylaşılmaz. Arayüz ve commit'ler Türkçe.

## Mimari notlar
- Kullanıcı kararları (2026-10-22): ayrı proje; Android; store dışı kurulum; `tam` döngü.
- Önerilen yığın: Kotlin + Jetpack Compose; kesin karar spec/plan fazında.
- Store dışı olduğu için `MANAGE_EXTERNAL_STORAGE` ("Tüm dosyalara erişim") kullanılabilir; başka uygulamaların önbelleği silinemez (yalnızca bilgi + Ayarlar'a yönlendirme).
- Silme: medya → sistem çöp kutusu (`MediaStore.createTrashRequest`), medya dışı → `SİL` onaylı kalıcı silme (karantina spec'te kararlaşacak).
- Bulut container'ında emülatör yok; UI öz-kontrolü Robolectric/Roborazzi ekran görüntüsüyle, gerçek cihaz testi kullanıcıda.

## Son aktivite
- 2026-10-22: Proje açıldı; v1 pipeline T20261022-64 tanımlandı; repo `iamhankaya/diskpilot-mobile` (main, README) açıldı.

## Açık konular
- APK imzalama: kalıcı keystore (GitHub secret) önerildi; kullanıcı kararı bekliyor.

## Çalışma notları
- 2026-10-22: Android'e dokunan ilk dilimden sonra tam kapıyı (lintDebug testDebugUnitTest assembleDebug) bir kez koş: ya ağ izniyle (dl.google.com, maven.google.com) yerelde ya da onaylı tek CI koşusuyla; kör yazılmış :app main kapısına bırakılmaz.
- 2026-10-22: Compose test kodunda üye fonksiyonlar (onNode, onAllNodes) import edilmez; derlenemeyen ortamda kullanılan her test API'sinin (ör. assertTouchHeightIsAtLeast yok) varlığı doğrulanır.
- 2026-10-22: CI testLogging en baştan exceptionFormat=FULL olur; Actions artifact'ları bulut proxy'sinden indirilemez (403), teşhis yalnız iş günlüğünden okunur.
- 2026-10-22: Robolectric'te odaklı TextField AppNotIdleException, AlertDialog ikinci semantik kök üretir: test harness'i baştan otomatik odak kapalı (LocalAutoFocusTextField=false, canFocus) ve çoklu kökte en üst pencereyi yakalayacak şekilde kurulur.
