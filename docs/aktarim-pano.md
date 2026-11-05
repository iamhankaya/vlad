# Ortak pano (Mac ↔ Windows)

Plan: T20261105-04, uygulama fazı B (T20261105-08). Dosya gönderme için `docs/aktarim-dosya.md` (A1/A2), kurulum için `docs/aktarim.md` (C).

## Ne yapar

Her makinede çalışan VLAD Agent yerel panoyu yoklar (500 ms, yalnız `changeCount`/sıra numarası). Yeni bir yerel kopya görünce karşı Agent'a iter; karşı taraf kendi panosuna yazar.
Yalnız **iki** makine arasında çalışır (config'te kendinden başka tek makine); 2'den çok makinede kapalıdır ve Agent açılışta uyarı yazar.

| | |
|---|---|
| Metin | UTF-8, ≤ 1 MiB (`CLIP_MAX_TEXT_BYTES`). Geçersiz UTF-8 ve büyük metin gönderilmez/uygulanmaz. |
| Resim | PNG, ≤ 20 MiB ve IHDR `w*h ≤ 64 000 000`. Mac'te yalnız TIFF varsa PNG'ye çevrilir. Resim `clip-image` amaçlı `xfer-*` yüklemesiyle gider (İndirilenler'de iz ve bildirim yok). |
| Metin + resim birlikte | Yalnız metin senkronlanır. |
| Dosya kopyası (CF_HDROP vb.) | Senkronlanmaz (okunamayan içerik "yok" sayılır). |
| Gizli işaretli kopyalar | **Senkronlanır** (parola yöneticileri dahil; kullanıcı kararı, plan açık nokta 3). |

## Komutlar

```
vlad clip on | off | status [--json]
vlad clip get [--json] [--out <png>]      # YEREL panoyu okur (resim için --out gerekir)
vlad clip set [metin] | --file <yol|-> | --image <png>   # YEREL panoya yazar; açıksa Agent karşıya yayar
```
Durum `<VLAD_HOME>/.vlad-agent/clip.json` (`{"enabled":true}`; dosya yoksa açık). Her yoklamada okunur: `off` anında geçerlidir.
`off` iken içerik okunmaz/gönderilmez, yalnız sayaç ilerler (kapalıyken kopyalanan, açılınca gitmez). Alıcıda `off` ise itme reddedilir (`disabled`).

## Yankı ve "son yazan kazanır"

- **Yankı yok:** uzak değeri yazınca `lastSeq = seqAfter` olur; yazma ile yoklama tek kilit altındadır. `seqAfter`'a kadarki değişiklikler bizim yazımızdır. İçeriğe bakılmaz (CRLF dönüşümü, PNG yeniden kodlama, `bumpPerWrite:2` sonucu bozmaz). `seqAfter`'dan sonraki artış gerçek yerel olaydır: kullanıcı uzaktan geleni yeniden kopyalarsa gönderilir.
- **Sıralama:** `OrderKey = [eventTs, rank, counter]` (sözlük sırası). `rank` beyin 1, işçi 0 (eşit zamanda beyin kazanır); `counter` yerel monoton sayaç. Alıcı `lastWinner`'dan büyük olmayan anahtarı `stale` sayar. Yerel olay anahtarı, bilinen son anahtardan küçükse `lastWinner[0]+1`'e yükseltilir (Lamport; saat sapması/geri gitme yerel kopyayı ezdirmez).
- **Yerel kopya ezilmez:** uzak değer yazılmadan önce `changeCount` yoklama taban çizgisinden farklıysa (kullanıcı henüz gönderilmemiş bir şey kopyaladı) yazılmaz (`local_changed`); sonraki yoklama yerel değeri gönderir. Yazma anındaki yarış (`expectSeq`) backend'de de denetlenir.
- **Açılış:** Agent başlarken panoda var olan içerik taban çizgisidir, gönderilmez.
- **Olay zamanı:** alıcı `eventTs ≤ now + 120 sn` ister; geçmişte alt sınır yoktur. Gönderici bekleyen değeri ağ hatasında üstel geri çekilmeyle yeniden dener ve 10 dk'dan eskiyse atar (uyku/uyanma sonrası eski değer gitmez).

## Güvenlik ve kabul edilen riskler

- **Pano enjeksiyonu kabul edilen risktir:** karşı makineden gelen içerik panoya yazılır; kullanıcı yapıştırırsa uygulama onu yorumlar. VLAD içeriği yorumlamaz, dosyaya yazmaz, komut satırına/ortam değişkenine/kabuk dizesine koymaz.
- Panoya yazma yardımcıya yalnız **stdin'den base64** gider; yardımcı süreç argv'si sabittir (Windows: `-EncodedCommand` ile sabit betik; macOS: `osascript -l JavaScript -e <sabit betik>`).
- Yetki: `clip-push` ve `xfer-*` yalnız beyin↔işçi imzalı çağrılarına açıktır (`console`/`self` değil). Kimliği doğrulanmış karşı makine panoyu değiştirebilir; transport düz TCP/LAN varsayımıdır (imza HMAC, gizlilik yok): ağdaki bir dinleyici kopyalanan metni (parola dahil) görebilir.
- `clip-push` günlüğe (journal) girmez; içerik hiçbir günlüğe yazılmaz. Yalnız bayt sayısı ve 8 karakterlik özet ön eki Agent günlüğüne düşer.

## Bilinen sınırlar

- **Yoklama–yazma yarışı:** işletim sistemleri atomik karşılaştır-yaz sunmadığından `changeCount` denetimi ile yazma arasında kalan küçük pencere vardır.
- **Gecikmeli artış:** Windows'ta yazmadan sonra sayaç ayar süresini (150 ms, en çok 3 durulma okuması) aşarak artarsa tek bir sahte "yerel olay" görülebilir (resimde piksel özeti yoktur). Sonraki iş: piksel/metin özeti.
- **Kilitli/kopuk oturum:** Windows'ta kilitli ekran/RDP kopukken pano erişimi başarısız olabilir; yardımcı hata verirse yoklama o turu atlar (günlüğe bir kez yazılır), art arda 3 çöküşten sonra yardımcı yeniden denenmez (Agent yeniden başlatılana kadar).
- **Yardımcı CPU:** macOS'ta kalıcı JXA döngüsünde `changeCount` ~0,3 ms (200 çağrı 61 ms ölçüldü), süreç açılışı ~50 ms; yoklama maliyeti ihmal edilebilir.
- Windows betiği Mac'te çalıştırılamadı; gerçek makine doğrulaması V'nin elle listesindedir.

## Dosyalar

`src/clip/`: `sync.ts` (ClipSync), `receive.ts` (`clip-push` + `ClipImageSink`), `senders.ts` (gerçek `ClipSenders`), `index.ts` (`startClipSync`), `backend.ts` + `backend-win32.ts` + `backend-darwin.ts` + `helper.ts` (platform panosu, yardımcı süreç), `state.ts` (`clip.json`), `cli.ts`.
Testler: `test/aktarim/b-*.test.ts`, taklit yardımcı `test/aktarim/fixtures/fake-helper.mjs`.
