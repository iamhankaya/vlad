---
slug: watchparty
name: WatchParty
path: C:\dev\watchparty
stack:
  - csharp
  - dotnet
  - aspnet-core
  - signalr
  - typescript
  - react
  - vite
  - terraform
  - aws
status: active
autonomy: commit
last_activity: 2026-10-15T23:11:31+03:00
last_scanned: 2026-10-15T22:49:05+03:00
---

## Özet
Senkron birlikte izleme lobileri (YouTube veya MP4 URL) ve sohbet. .NET 10 backend (ASP.NET Core minimal API + SignalR, bellek içi durum) ve React 19 + TypeScript + Vite frontend. Ek özellikler: MP4 altyazı, yazıyor göstergesi, tamponlayan izleyiciyi bekleme, WebRTC mesh sesli sohbet (en fazla 6 kişi) ve tarayıcıdan S3'e doğrudan parçalı video yükleme (kişi başı yükleme anahtarıyla). AWS'ye Terraform (EC2 + CloudFront + S3) ve PowerShell deploy script'leriyle yayınlanıyor. Kod yorumları, commit'ler, arayüz ve hata mesajları Türkçe.

## Mimari notlar
- Sunucu tek doğruluk kaynağı; tüm lobi durumu `InMemoryLobbyStore`'da, hiçbir şey kalıcı değil (yeniden başlatma lobileri düşürür).
- SignalR hub `LobbyHub` (`/hubs/lobby`); REST: `POST/GET /api/lobbies`, `/api/health`, `/api/uploads/*`.
- Frontend `LobbyConnection` arayüzü: gerçek SignalR + `lib/mock.ts` (backend olmadan çalışan sahte sunucu). Hub kuralları ve sınırlar backend, `types.ts` ve `mock.ts`'de kopyalı; birlikte güncellenmeli.
- `SyncEngine` oynatıcıyı her 500 ms sunucu durumuna çeker; oynatıcı olayları sunucuya gönderilmez (yalnızca tamponlama raporu).
- Video dosyası sunucudan geçmez: tarayıcı presigned S3 multipart URL'lerine yükler; anahtarlar `deploy\upload-keys.ps1` ile SSM üzerinden yönetilir.
- Testler: xUnit entegrasyon (`WatchParty.Api.Tests`), vitest (frontend), `backend/e2e/e2e.mjs` (çalışan backend'e karşı), `deploy/tests/remote-deploy.test.sh` (deploy script'i). Altyapı `infra/` (Terraform), deploy `deploy/`.

## Açık konular
`docs/BACKLOG.md`'den öne çıkanlar:
- `upload-keys.ps1` her işlemde servisi yeniden başlatıp lobileri düşürüyor; anahtarları dosyadan sıcak yükleme (`IOptionsMonitor`) ya da işlemleri tek yeniden başlatmada toplama gerekli.
- `upload-keys.ps1` çıktısında Türkçe karakter bozulması (SSM UTF-8 / konsol kod sayfası).
- Yükleme boyut sınırları imzalı Content-Length olmadığı için tavsiye niteliğinde.
- `PlaybackState` sürüm numarası yok; yayınlar ters sırada ulaşabilir.
- Bekleme küçükleri: "hayalet" bekleme, temizlenmeyen tekrar sayaçları.

## Son aktivite
- 2026-10-15 gece: Deploy sağlık kontrolündeki ara deneme hataları gizlendi, başarısızlıkta son hata loglanıyor; backlog maddesi kapandı. `master`'a merge edildi, push yok. (görev T20261015-02)
- 2026-10-15 gece: Kök `README.md` eklendi. `master`'a merge edildi, push yok. (görev T20261015-01)
- 2026-10-15: Sesli sohbet (WebRTC, perfect negotiation, bekçi, iOS ses bağlamı) ve tarayıcıdan video yükleme (S3 multipart, anahtar doğrulama) master'a birleştirildi.
- 2026-10-15 akşam: Backlog'a anahtar işlemlerindeki yeniden başlatma ve script çıktı kodlaması sorunları eklendi.
