# VLAD sunucu ve mobil uygulama: tasarım

Tarih: 2026-10-24 · Durum: onaylandı (kullanıcı, 2026-10-24) · Kaynak: VLAD oturumu, kullanıcıyla brainstorming

## 1. Amaç ve neden

Kullanıcı VLAD'ı çoğu zaman telefondan yönetiyor. Bugünkü en büyük sürtünme, terminal gerektiren işlerin bilgisayar başına bağlı kalması:

- git ve sürüm işleri: etiketler (`v1.0.0` … `v2.0.1` hâlâ bekliyor), push;
- VLAD'ın yerel komutları.

Çalışanları telefondan izlemek de zor. Şu an yalnızca VLAD'ın sohbet mesajları görünüyor.

İkinci bir hedef bağlamla ilgili. Planlar, tasarım belgeleri ve raporlar proje repolarında ve `kb/`'de birikiyor. Çalışan prompt'ları şişiyor: 2026-10-24'te 82 KB'lik bir prompt `create_session`'ı yarıda kesti. Bulut çalışanları `kb/`'yi okuyamadığı için kart notları prompt'a gömülüyor.

Çözüm iki parçadan oluşuyor:
1. **VLAD sunucusu:** her zaman açık bir Linux makinesi. VLAD'ın hafızası (vault) orada durur, çalışanlar orada koşar, git/gh/vlad komutları orada çalışır.
2. **VLAD mobil (Android):** kararlar, çalışanların durumu, bildirimler ve VLAD'la sohbet.

Web uygulaması **ikinci aşamadır** (bkz. §9).

**Başarı:**
- Kullanıcı bilgisayarı açmadan bir faz PR'ını onaylayıp merge ettirebilir.
- Bir sürüm etiketini attırabilir.
- Bir çalışanın sorusunu cevaplayabilir.
- Karar beklendiğinde telefona bildirim gelir.

## 2. Hedefler, hedef dışı, karşı-hedefler

**Hedefler**
- Sunucuda VLAD'ın beyni: `kb/` tamamı Obsidian vault olarak tutulur. Taşınan proje belgeleri de buraya gelir (§4). Vault, GitHub'daki `iamhankaya/vlad` reposuyla senkron.
- Çalışanlar sunucuda kullanıcının Claude aboneliğiyle koşar:
  - proje repolarını çeker;
  - kod yazar, test ve gate koşar;
  - branch push eder, PR açar.
- Aynı anda 2–3 çalışan (sunucu kapasitesine göre, §6).
- Android uygulaması:
  - ana ekranda senden beklenenler ve çalışanlar;
  - sabit VLAD sohbet kutusu;
  - bildirimler;
  - Projeler ve Hafıza sekmeleri.
- Codex bağlantısı:
  - merge kapısından önce ikinci göz incelemesi;
  - destekliyorsa görsel üretimi.

**Hedef dışı (bu aşamada)**
- iPhone uygulaması.
- Web uygulaması (ikinci aşama).
- Çok kullanıcı. Tek kullanıcı, tek sahip.
- Uygulamadan kod düzenleme.

**Karşı-hedefler (teknik olarak çalışsa da başarısızlık sayılır)**
- Uygulama ya da sunucu, kullanıcının **açık onayı olmadan** dışarıya etki eden bir eylem yapar: push, PR, merge, etiket, dış yayın. CLAUDE.md'deki yetki sınırları aynen geçerlidir. Tek istisna, kullanıcının kayıtlı yetki devirleridir (§7.3).
- Sunucu GitHub/Claude kimlik bilgilerini dışarıya açar ya da eşleşmemiş bir cihaz herhangi bir veri görür.
- Oracle'a özgü bir şeye bağlanıp mini PC / Raspberry Pi'ye taşınamaz hale gelmek.
- Bildirim spamı. Yalnız §5.4'teki durumlarda bildirim gider.

## 3. Kısıtlar

- **Barındırma:**
  - Şimdilik Oracle Cloud Always Free, kullanıcının mevcut hesabı. Medialog VM'i 1 OCPU / 6 GB'a küçültülür; VLAD'a 3 OCPU / 18 GB ARM (Ampere A1, Ubuntu 24.04 aarch64) kalır.
  - İkinci Oracle hesabı açılmaz: ücretsiz katman kişi başına tektir.
  - İleride mini PC ya da Raspberry Pi'ye taşınacak. Bu yüzden kurulum tek betik ve tek kılavuzla yapılır, sağlayıcıya özgü servis kullanılmaz.
- **Sunucu kurulumunu kullanıcı yapar** (Oracle VM, Tailscale hesabı, Firebase projesi). VLAD betik ve adım adım kılavuz yazar (Medialog `deploy/RUNBOOK.md` gibi).
- **Ağ:**
  - Sunucuda dışarıya açık port yok (SSH yalnız anahtarla; tercihen Tailscale içinden).
  - Uygulama sunucuya **Tailscale Funnel** üzerinden HTTPS ile ulaşır (`<makine>.<tailnet>.ts.net`). Telefona Tailscale kurulması gerekmez; kullanıcı zaman zaman başka bir VPN kullanıyor ve Android aynı anda tek VPN çalıştırır.
- **Bildirimler** Firebase Cloud Messaging (FCM) üzerinden gider; VPN'den bağımsızdır.
- **Mevcut VLAD sözleşmesi korunur:**
  - `kb/` yalnız `vlad` CLI ile yazılır;
  - görev durumları CLI ile değişir;
  - `kb:` commit'lerinin push'u önceden onaylıdır.
  - Sunucu tarafı bu CLI'ı çağırır; şema ve durum makinesini yeniden yazmaz.
- **Dil:** arayüz, bildirimler ve hata mesajları Türkçe.

## 4. Belge düzeni (vault)

**Repoda kalır:**
- kodun, testlerin ya da CI'ın doğrudan okuduğu belgeler (ör. ashen-bastion `docs/data-schema.md`, `docs/dev/skill-hooks.md`, `docs/design/v2.0.2/behavior-contract.md`, `docs/dev/user-verify/`);
- geliştiricinin her gün baktığı güncel başvuru belgeleri.

**Vault'a taşınır:**
- `kb/`'nin tamamı (zaten markdown; Obsidian'da olduğu gibi açılır);
- biten sürümlerin planları ve tasarım belgeleri, kapanış raporları, retrolar;
- devam eden sürümün planı.

**Çalışan erişimi:**
- Sunucudaki çalışan vault'u doğrudan okur. Prompt'a yalnız ilgili dosyanın yolu girer; tüm plan gömülmez.
- Bir çalışanın vault'tan yalnız kendi bölümünü çekebilmesi için arama ve okuma aracı gerekir (dosya yolu + başlık bazlı okuma; bkz. §10, yapıcıya bırakılan).

**Taşıma:** Proje başına bir defalık iş; her proje için ayrı görev olarak yapılır. Repodan silme kullanıcı onayıyla, tarihsel belgeye bağlantı bırakarak.

## 5. Mobil uygulama

### 5.1 Ana ekran ("Bugün")
Kullanıcının seçimi: taslak A'nın üst kısmı + taslak C'nin sohbet kutusu (taslaklar: https://claude.ai/artifact/PUDqRAovc6QayvADx3CCZ2).

1. **Senden bekleniyor** (en üstte, sayıyla). Kartlar ve eylemleri:
   - onay bekleyen kapı: Merge et / Rapor / Değişiklik iste;
   - çalışan sorusu ve test itirazı: Cevapla / Ayrıntı;
   - kırmızı CI ya da çakışma: Ayrıntı / VLAD'a sor;
   - VLAD'ın kullanıcıya getirdiği karar soruları (ör. denge seçenekleri).

   Her kartta proje, faz, kısa özet ve durum etiketi bulunur.
2. **Çalışanlar.** Her biri tek satır: görev adı, durum, süre, son adım (son `[VLAD:LOG]`). Uzun koşularda ilerleme gösterilir (ör. baseline %38).
3. **VLAD sohbet kutusu** (altta sabit). Yazılan mesaj sunucudaki kalıcı VLAD oturumuna gider ("etiketleri at", "S2'yi merge et", "medialog'da nerede kalmıştık"). Cevap aynı ekranda akar.

### 5.2 Diğer sekmeler (yalnız okunur)
- **Projeler:** proje kartları (özet, son aktivite, açık konular), açık bulgular (önem sırasıyla), aktif pipeline ağacı.
- **Hafıza:** vault'ta arama; günlük, kararlar, görev ve rapor dosyalarını okuma.

### 5.3 Eylem güvenliği
- Dışarıya etki eden her eylem (merge, push, PR, etiket, dış yayın, silme) kartta neyin olacağını açıkça yazar: hedef branch, PR numarası, head SHA.
- Bu eylemler **parmak izi / cihaz kilidi onayı** ister.
- Sunucu, eylemi başlatmadan önce head SHA'yı yeniden doğrular (bugünkü `expectedHeadSha` uygulaması).
- Sohbetten verilen komut da aynı onay akışına düşer: VLAD bir onay kartı üretir, kullanıcı karttan onaylar. Serbest metin "evet" tek başına dış eylemi tetiklemez.

### 5.4 Bildirimler
Yalnız şu durumlarda:
- karar bekleniyor (onay kapısı, soru / test itirazı, kırmızı CI ya da çakışma, VLAD'ın sorusu);
- bir faz bitti (rapor geldi ya da merge edildi).

Bildirime dokununca ilgili kart açılır. Aynı olay için tek bildirim gider.

### 5.5 Teknik
- Yalnız Android. Kotlin + Jetpack Compose. DiskPilot Mobile'ın proje düzeni ve derleme hattı örnek alınır.
- Debug APK CI artifact'ı olarak indirilir (ashen-bastion `export-debug` gibi).

## 6. Sunucu

**İçerik:**
- `vlad` CLI ve vault;
- git, `gh` (GitHub kimliği: ince ayarlı token ya da GitHub App, en az yetki; bkz. §10);
- Claude Code CLI (kullanıcının aboneliği);
- proje araç zincirleri. Bunlar ihtiyaç oldukça kurulur: Node, Godot headless (aarch64), .NET, Android SDK vb.

**Kalıcı VLAD oturumu:** Sohbet kutusunun ve olay işleme akışının bağlandığı, sunucuda sürekli yaşayan bir VLAD (Claude Code) oturumu.
- Bugünkü `/status`, `/digest` ve `/delegate` akışları burada koşar.
- Oturum kesilirse yeniden başlatılır. Durum zaten `kb/`'de olduğu için hiçbir şey kaybolmaz.

**Çalışanlar:**
- Yerel worktree'lerde ayrı Claude Code süreçleri olarak koşar. Bugünkü yerel launcher'ın Linux karşılığı; Windows PowerShell + WMI yerine Linux süreç yönetimi.
- `maxParallel` sunucu kapasitesine göre 2–3.
- Çalışanların `[VLAD:*]` işaretleri ve durumu uygulamaya buradan akar.

**API servisi:**
- Uygulamanın konuştuğu küçük bir HTTP servisi. Yalnız localhost'a bağlanır; dışarıya Funnel ile açılır.
- Okuma: `vlad status --json`, `task list`, kart, bulgu ve vault okuma.
- Eylem: onaylı eylemleri VLAD oturumu ya da CLI üzerinden yürütme, sohbet mesajı iletme.
- Bildirim: olay oluşunca FCM'e gönderme.

**Cihaz eşleştirme:**
- İlk kurulumda sunucu tek seferlik bir eşleştirme kodu üretir (terminalde ya da QR olarak).
- Telefon kendi anahtar çiftini üretir (Android Keystore) ve açık anahtarını kodla birlikte kaydeder.
- Sonraki her istek bu anahtarla imzalanır. Şifre yoktur.
- Eşleşmemiş istek hiçbir veri görmez. Cihaz sunucudan iptal edilebilir.

**Kurulum ve taşınabilirlik:**
- Tek kurulum betiği + kılavuz (Oracle adımları, Tailscale hesabı ve Funnel/HTTPS açma, Firebase projesi, Claude/GitHub girişleri).
- Mini PC / Pi'ye taşıma: aynı betik, vault ve worktree'lerin kopyalanması.

**Oracle boşta geri alma:** Oracle 7 gün boşta kalan Always Free VM'i durdurabilir. VLAD sürekli iş yaptığı için risk düşük; kılavuzda not edilir.

## 7. Codex ve yetki

### 7.1 İkinci göz
Bir faz merge kapısına gelince, merge önerilmeden önce Codex diff'i ve kapanış raporunu bağımsız olarak inceler. Bulguları kapı kartında Claude'un bulgularıyla yan yana gösterilir.
- Kritik veya yüksek bulgu varsa merge önerilmez (bugünkü güvenlik incelemesi kuralıyla aynı).
- Kalan bulgular `vlad finding add` ile kaydedilir.

### 7.2 Görsel üretimi
Codex bağlantısı görsel üretimini destekliyorsa:
1. VLAD istemi doğrudan gönderir.
2. Gelen görseli kendi kontrolünden geçirir: şeffaflık, kenar boşluğu, küçük boyutta okunurluk; bugünkü ikon kontrol betiği.
3. Görseli bir onay kartıyla kullanıcıya sunar.

Kullanıcı onaylamadan görsel repoya girmez. **Henüz doğrulanmadı:** bağlantı kurulunca test edilecek; desteklenmiyorsa bugünkü elle akış sürer.

### 7.3 Yetki devirleri
Kullanıcının verdiği kalıcı yetki devirleri (ör. "faz PR'larını CI yeşilse merge et") sunucuda da geçerlidir ve `kb/`'de kayıtlıdır. Bu devirlerle yapılan eylemler bildirimle haber verilir.

Devredilmeyenler her zaman kart onayı ister:
- release etiketi;
- dış yayın;
- silme;
- güvenlik etkili kararlar;
- kapsam değişikliği.

## 8. Aşamalar

1. **Mobil uygulama + sunucu tarafı yazılımı** (API servisi, eşleştirme, bildirim, Linux launcher). Kullanıcının isteği: önce uygulamalar planlanıp yapılır.
2. **Sunucu kurulumu** (kullanıcı; VLAD betik ve kılavuzu 1. aşamada yazar). Medialog küçültme dahil.
3. **Vault'a taşıma** (proje başına).
4. **Web uygulaması** (§9).

## 9. Web uygulaması (ikinci aşama, kapsam notu)

Mobildeki her şeye ek olarak:
- vault'taki planları ve tasarım belgelerini okuma ve **düzenleme**;
- bir çalışanın canlı terminalini izleme (kullanıcının ilgisi var, kesinleşmedi).

Ayrıntıları ayrı bir brainstorming'de konuşulacak.

## 10. Yapıcıya bırakılanlar

- API servisinin dili ve çatısı. Varsayılan: VLAD CLI ile aynı yığın (TypeScript/Node), CLI'ı alt süreç olarak çağırır.
- Uygulama–sunucu protokolü. REST + canlı akış için SSE ya da WebSocket.
- Vault arama/okuma aracının biçimi: MCP sunucusu mu, CLI alt komutu mu.
- Linux launcher'ın süreç yönetimi: systemd, tmux ya da doğrudan süreçler.
- GitHub kimliği: ince ayarlı PAT mi, GitHub App mi. En az yetki ilkesine uyarak.
- Uygulamanın ekran görsel dili. Taslaktaki düzen bağlayıcı, renk ve tipografi değil.

## 11. Kararlar (VLAD'ın çağrısı; kullanıcı kontrol etsin)

- **Ağır gate'ler CI'da:**
  - Sunucu ARM (aarch64). Android SDK derleme araçlarının resmi linux-arm64 sürümü yok; Godot dışa aktarımı ARM'da sınırlı.
  - Sunucudaki çalışan projenin hızlı kontrollerini (lint, birim/GUT testleri, `gate` dışa aktarım olmadan) yerelde koşar.
  - APK dışa aktarımı ve Android derlemesi GitHub Actions'ta kalır; çalışan CI sonucunu bekler.
  - VLAD mobil uygulamasının APK'sı da CI'da derlenir.
- **Yeni kayıt türleri CLI'a eklenir:**
  - Ana ekrandaki "kırmızı CI/çakışma", "VLAD sorusu", "sohbetten istenen eylem onayı" kartları ve çalışan ilerleme işareti `kb/`'de yeni şemalı kayıtlar olarak tutulur.
  - Yazma yine yalnız `vlad` CLI ile yapılır; böylece oturum yeniden başlasa ya da sunucu taşınsa da kaybolmaz.
  - "Şema ve durum makinesini yeniden yazmaz" kuralı, mantığı sunucuda ikinci kez yazmayı yasaklar; CLI'ı genişletmeyi yasaklamaz.
- **Vault iki bölge:**
  - `kb/` (yapılandırılmış hafıza) yalnız CLI ile yazılır.
  - `vault/docs/` (taşınan planlar, tasarımlar, raporlar) elle ve Obsidian'dan düzenlenebilir.
  - İkisi de `iamhankaya/vlad` reposunda, git ile senkron.
- **Codex yoksa:** İkinci göz incelemesi kapıyı kilitlemez. Codex erişilemezse kapı yalnız Claude incelemesiyle sürer ve kartta "Codex incelemesi yapılamadı" yazar.
- **Codex ilk aşamada zorunlu değil:** önce uygulama ve sunucu, sonra Codex.
- **Bildirim yolu:** Bugünkü `ListAgents`/`SendMessage` ve zamanlanmış görev bildirimleri sunucuda kalkar. Çalışan durumu yerel olay akışıyla VLAD oturumuna ve API servisine gelir. Bu iş kapsam içindedir.

## 12. Kullanıcı kararları (2026-10-24)

- **Sıkı kapı (güvenlik kararı, kullanıcı onaylı):**
  - Sunucudaki VLAD oturumu ve çalışanlar yalnız kendi `vlad/<id>` branch'lerine push edebilir ve PR açabilir. Ana branch'e push, merge, etiket ve release kimlik bilgileri bu oturumlara verilmez.
  - Bu eylemler yalnız API servisinin onay yolundan yürür. Ya cihazda parmak iziyle imzalanmış, head SHA'ya bağlı bir onay gerekir, ya da kayıtlı bir yetki devri.
  - Yetki devirleri yapılandırılmış kayıtlara dönüşür ve CLI ile yazılır. Kayıt alanları: kapsam (proje / pipeline), izin verilen eylem, koşul (ör. CI yeşil), bitiş.
  - API her eylemde devri kontrol eder ve kullanıcıya bildirim gönderir.
- **Abonelik: Claude Max 5x.**
  - Sürekli VLAD oturumu ve çalışanlar aynı kotayı paylaşır. Varsayılan `maxParallel` 2'dir.
  - Kullanım sınırına yaklaşılınca yeni faz başlatılmaz, `held_by_limit`'e düşer. Ana ekran bunu "sınır nedeniyle bekliyor" diye gösterir.
  - Sohbet kutusu, kalıcı oturuma ek bir oturum açmaz.
- **Codex:**
  - İlk deneme Claude'a eklenen Codex connector'ı ile yapılır. Hem ikinci göz incelemesi hem görsel üretimi bunun üzerinden denenir.
  - Görsel üretimi için hangi yol uygunsa (connector, Codex CLI ya da API) sonradan ona geçilir.
- **Ses lisansı:** Zyfen sesleri ElevenLabs ücretli plandan (kullanıcı teyidi).
- **Windows VLAD kalır** (kullanıcı kararı): bilgisayar başındayken Windows VLAD, değilken sunucu VLAD kullanılır; ikisi aynı anda kullanılmaz. Ayrıntı §13.

## 13. İki VLAD: Windows ve sunucu (VLAD'ın çağrısı)

Kullanıcı ikisini aynı anda kullanmaz. Yine de yanlışlıkla iki tarafın aynı anda yazmasını önlemek gerekir.

- **Etkin VLAD kaydı:**
  - `kb/`'de tek bir kayıt hangi makinenin "etkin VLAD" olduğunu tutar: makine adı, alındığı zaman, son nabız.
  - Açılan VLAD önce `master`'ı çeker ve kaydı alır. Kayıt başka makinedeyse ve nabzı tazeyse uyarır, kullanıcı "devral" demeden yazmaz. Uygulamada bu bir kart olarak görünür.
  - Devralma kaydı commit'lenip push edilir. Diğer makine bir sonraki yazmasından önce bunu görür ve salt okunur moda geçer.
- **Çalışanlar başlatıldıkları makinede koşar.**
  - Görev dosyası çalışanın makinesini (`host`) taşır.
  - Etkin VLAD değişince koşan çalışanlar durmaz. Raporları yine `kb/`'ye ve etkin VLAD'a akar.
  - Sunucudaki çalışanlar sunucunun API'sinden izlenir. Windows VLAD da `vlad status` ile onları görür, çünkü durum `kb/`'dedir.
- **Makineye göre yollar:**
  - Proje kartlarındaki `path` alanı makine başına eşlemeye dönüşür, `vlad.config.json`'da `roots` makine başına tutulur. Örnek: Windows'ta `C:\dev\<slug>`, sunucuda `/srv/vlad/projects/<slug>`.
  - Eksik yol, "bu makinede klon yok, klonla?" önerisi olarak görünür.
- **Senkron:** Her `kb` yazması öncesi `master` çekilir, sonrası push edilir (bugünkü bulut kuralı). Çakışmada yazma durur ve kullanıcıya gösterilir.
- **Windows launcher kalır:** PowerShell + WMI. Linux launcher eklenir; `launcher: auto` makineye göre seçer.

