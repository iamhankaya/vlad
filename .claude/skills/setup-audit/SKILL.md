---
name: setup-audit
description: VLAD kurulumunun periyodik denetimi — biten görevlerin ölçümlerinden, açık noktalarından ve sürtünme işaretlerinden eksik/fazla/skill adayı/yetki modu adayı/Claude mod adayı/kural önerisi/bulgu hijyeni çıkarır, her adayı sonraki düzeltmelere karşı doğrular, raporlar. Kullan - kullanıcı "/setup-audit", "kurulumu denetle", "neyi otomatikleştirmeliyiz" dediğinde.
---

# /setup-audit — kurulum denetimi

Kullanıcı `/setup-audit` dediğinde **onay sormadan** yürür (skill çağrısı onaydır). Kendisi hiçbir dosyayı, kuralı, rolü ya da skill'i **değiştirmez**; çıktısı yalnız rapor ve kullanıcının seçtikleri için görev taslağıdır.

**Madde zorunlu değil.** Hiçbir kategoride kanıtlı ve doğrulanmış aday yoksa o kategori için "madde yok" yaz. Kota, doldurma, "en az N öneri" yoktur; zayıf kanıtla madde üretmek, rapor boş kalmasından kötüdür.

## 1. Aralık

- `--since YYYY-MM-DD` verildiyse onu kullan.
- Yoksa son denetimin tarihi: `vlad task list --json --fields id,title,state,created --limit 200` çıktısında başlığı `Kurulum denetimi` ile başlayan ve `state` değeri `done` ya da `awaiting_approval` olan (iptal/yarım kalmış sayılmaz) en yeni görevin `created` günü. Hiç yoksa bugünden 14 gün öncesi. Aynı gün biten görevler iki denetimde de görünebilir; çift saydığın kanıtı öneride belirt.
- **Pencere kesilmesi:** `--limit` pencereyi kesebilir (en yeni N görev). Aralığın en eski görevi pencerede yoksa limiti yükselt ya da sayfala; `kb search` sayım için kullanılmaz (en fazla 8 sonuç).
- Aralığı kullanıcıya tek satırda söyle.

## 2. Görev

```
vlad task new --project vlad --kind research --role analyst --title "Kurulum denetimi <YYYY-MM-DD>" --body-file <geçici.md> --json
vlad task set <id> running
```
Gövde: aralık ve amaç (bir iki satır). Onay istenmez.

## 3. Veri toplama

```
vlad audit setup --since <tarih> --json
```
Çıktı (salt okuma):
- `tasks` (sayı, rol/faz/model dağılımı), `measures.sums` (review_bulgusu, ci_tur, yeni_test, `satir_eklenen`/`satir_silinen`), `open_points` (önem dağılımı). `measures.by_ponytail` aynı toplamları görevin frontmatter'ındaki `experiment.ponytail` koluna (`on`/`off`) göre ayırır; deney kapandı (D-vlad-083), launch artık kol yazmaz: yalnız geçmiş görevler görünür, deney dışı görevler hiçbirinde yok.
- `permission_candidates` (`vlad task deny` ile kaydedilen, ≥2 görevde reddedilen araç+ret sınıfı; `kb/logs/denials.jsonl` da kaynak: `tool`, `pattern` = sınıf adı (ör. "heredoc yazımı", "git push", "rm", "gizli dosya yolu"; tam komut değil), `tasks`, `count`, `examples`, `samples` = en çok 3 ham komut): izin kuralı adayları; `settings.json` kuralı ya da mod penceresi olarak öner.
- `signals` (`test_itirazi`, `degisiklik_istegi`, `karar`, `izin_reddi`: görev sayısı, adet, örnek ID'ler). Sayımlar yapısal satırlardan gelir (`**Soru:**`, `### Önceki rapor #N`, zaman damgalı `[KARAR]`, satır başı `Ölçüm:`); şablon/alıntı metin sayılmaz. Bunları elle `kb search`/grep ile yeniden sayma.
- `cancelled` (iptal edilenler, gerekçesi yazılı/yazısız ID'ler).
- `skills.inventory` (ad, kaynak: `repo|global|vendor|user|plugin|role`, anan roller, yüklenme sayısı, ilk eklenme `added`), `skills.unused`, `skills.coverage` (rol×skill oranı: görev yalnız kural yürürlüğe girdikten sonra oluşturulduysa beklentiye girer; `skipped_before_rule` atlananlar), `skills.transcripts`.
- `rules` (`CLAUDE.md` ve rol dosyalarının son değişiklik tarihi, git geçmişinden).
- `weekly` (hafta başına [Pazartesi, UTC] görev başına oranlar: `review_bulgusu_per_task` ölçümlü görevlere, `degisiklik_istegi_per_task`/`izin_reddi_per_task` tüm görevlere bölünür; `findings_opened/closed`; `by_role`, `by_project` kırılımı; `rules_changed` = o hafta commit alan kural dosyaları). Değişikliğin etkisini kural haftasından önceki/sonraki haftalarla karşılaştırarak oku; tek haftalık sapmayı kanıt sayma.
- `suggestions` (önceki denetimlerin fikir olarak açtığı önerilerin durumu: `by_state`, `ideas[]` open/promoted/dropped). Aynı öneriyi yeniden yazma; hâlâ `open` olanı düşen/bekleyen olarak an.
- `findings` (`unresolved` yaşa göre; `by_severity`, `by_project`, `by_source`, `stale`).

**Kurulu Claude mod'ları** (CLI'da yok; salt okuma, agent ya da ana oturum okur): `~/.claude/settings.json` içindeki `enabledPlugins` anahtarlarından `@claude-mods` ile bitenler ve `~/.claude/plugins/marketplaces/claude-mods/mods/` altındaki dizinler (her mod bir dizin; `hooks/hooks.json` mod türünü ve tetiği verir). Bir aday kurulu bir mod'un yaptığı işle örtüşüyorsa yazılmaz.

**Veri sınırları** (raporun `### Açık noktalar`ına yaz, önerinde dayanak yapma): `coverage` satırında `since_unknown: true` ise skill rol dosyasında commit edilmemiş ya da git geçmişi yok demektir; o satırda tüm görevler ölçülmüş olur, oran şişkin olabilir, "eksik" önerisini tarihi elle doğrulamadan yazma. Kullanım çıplak ada göre eşleşir; iki plugin'de aynı çıplak adlı skill (`a:review`, `b:review`) birbirinin kullanımını gösterir, `unused` o durumda eksik raporlar. Plugin önbelleği `<pazar>/<plugin>/<sürüm>/skills` düzenini varsayar; başka düzendeki plugin envantere girmeyebilir.

Skill adları: plugin skill'leri `plugin:skill` biçimindedir; kullanıcının `~/.claude/skills`'i (`user`) ve plugin önbelleği (`plugin`) envantere girer. Kullanım karşılaştırması çıplak ada göre yapılır. `source: role` skill'i bir rol adlandırıyor ama hiçbir yerde kurulu değil demektir.

Ana bağlamı şişirme; ham veriyi okuyup yorumlamayı arka plan agent'larına ver, ana bağlama yalnız özet girer:
- **haiku:** sayım ve çıkarım (tablolar, dağılımlar, ID listeleri).
- **sonnet:** sınıflandırma ve örüntü arama (aşağıdaki kategoriler). Örnek ID'lerin kapanış raporlarını `vlad kb get <id> --section "## Kapanış raporu" --json` ile okutur.

Agent'lar kb'ye yazmaz; sonuç taslaktır, kanıt ID'lerini VLAD örnekleyerek doğrular.

`skills.unused` yalnız oturum kaydı bulunan görevlerden (`skills.transcripts`) ve VLAD oturumundan çıkar; kayıt sayısı azsa ya da görevlerin çoğunda kayıt yoksa "Fazla" önerisi yazma, bunu `### Açık noktalar`a veri sınırı olarak yaz.

Sinyal okuma: `ci_tur` ve `review_bulgusu` yüksekse tekrarlı bir kalıp var mı bak; `test_itirazi`/`degisiklik_istegi` yüksekse kabul/sözleşme fazı ya da rol talimatı zayıf olabilir; `izin_reddi` tekrarı izin kuralı ya da yetki modu penceresi adayıdır (somut kalıplar `permission_candidates`'ta); gerekçesiz iptaller kayıt hijyeni açığıdır.

## 4. Sınıflandırma

Her aday şu kategorilerden birine girer:

| Kategori | Ne |
|---|---|
| **Eksik** | Tekrarlı elle yapılan iş, CLI/komut/otomasyon boşluğu |
| **Fazla** | Kullanılmayan skill/rol/komut, ölü ya da çelişen kural (`skills.unused`, hiçbir rolün anmadığı skill) |
| **Skill adayı** | En az 3 görevde tekrarlanan aynı akış (kanıt: ≥3 görev ID'si) |
| **Yetki modu adayı (`vlad mode`)** | Tekrarlı yetki/izin pencereleri, aynı onayın sık istenmesi (`vlad mode` ile çözülebilir) |
| **Claude mod adayı** | VLAD ya da çalışanların tekrar tekrar elle gözlediği ya da yokladığı durumlar; mod ile görünür ya da anlık hale getirilebilir. Örnekler: tmux ekranı okuma, nabız cron'unun yakaladığı gecikmiş kapı, bağlam sıkıştırma ya da `API Error` sonrası boşta kalma, kullanıcıya bildirilmesi gereken olay. Kanıt: görev ID'leri; ilgili `İlerleme` satırları ("bekçi: dürtüldü", "tmux ile dürtüldü", "nabız") ve VLAD oturum davranışı da kanıttır. |
| **Kural/rol önerisi** | `CLAUDE.md` ya da `roles/` değişikliği; çalışma notu adayı |
| **Bulgu hijyeni** | Çok eski (`age_days`), aslında kapanmış ya da artık geçersiz açık/ertelenmiş bulgular; `vlad finding set` önerisi |

Tahmin yürütme: veride dayanağı olmayan aday yazma. ≥3 görev şartını sağlamayan "skill adayı" `Kural/rol önerisi` ya da `Eksik`'e iner.

**Yetki modu ile Claude mod ayrımı:** izin penceresi (`vlad mode`, `permission_candidates`, `izin_reddi`) **yetki modu** adayıdır; arayüze ya da davranışa dair tekrarlı gözlem (tmux, nabız, sıkıştırma sonrası boşluk, bildirim) **Claude mod** adayıdır. Aynı olay iki kategoriye birden girmez; izin/onay penceresi değilse, bir gözlem ya da bildirim ihtiyacıysa Claude mod'dur.

## 5. Doğrulama (zorunlu)

**Her aday maddeyi rapora yazmadan önce** kanıtın tarihinden **sonraki** düzeltmelere karşı kontrol et. Eski kanıtla çoktan kapanmış sorunu yeni diye sunmak bu denetimin en sık hatasıdır. Örnekler: bir bulgu sonradan `fixed` olmuş; bir kural/rol/skill sonradan eklenmiş; "ölçüm yok" denen yerde rol dosyası zaten ölçüm satırı istiyor.

Kontrol listesi (her aday için, ilgili olanlar):
1. **Bulgular:** `vlad finding list --project <slug> --json` ve `vlad kb get <F-id> --json`: durum `fixed`/`wontfix` mi, ne zaman (`updated`)?
2. **Kararlar:** `vlad decision list --project <slug> --all --json`: konuyu kapatan ya da yerine geçen karar var mı?
3. **Kural/rol/skill değişiklikleri:** `audit setup`'taki `rules` ve `inventory[].added` tarihleri; ayrıntı için `git -C <VLAD_HOME> log --since=<kanıt tarihi> --format="%h %cI %s" -- roles/ .claude/skills/ CLAUDE.md` (kuralın/rolün eklendiği commit tarihi).
4. **Sonraki görevler:** kanıt tarihinden sonra biten görevlerin kapanış raporları (`vlad task list --json --fields id,title,state,updated`, sonra `vlad kb get <id> --section "## Kapanış raporu"`): sorun tekrarlıyor mu, düzelmiş mi?
5. **Kurulu modlar (Claude mod adayı):** §3'teki kaynaklarda aynı işi yapan bir mod kurulu mu (`enabledPlugins` `@claude-mods` girdileri, `mods/` dizinleri, `hooks.json`)? Kurulu ise aday düşer ya da "kurulu mod'un kapsamını genişlet" olarak yeniden yazılır; mod kanıt tarihinden sonra kurulduysa bunu doğrulandı sütununa yaz.

Sonuç:
- Düzeltilmiş → madde **düşer** (isteğe bağlı olarak `### Açık noktalar`a ya da raporun sonunda "kapanmış" notu olarak tek satır).
- Kısmen düzeltilmiş → madde daralır, kalan kısmıyla yazılır.
- Hâlâ geçerli → rapora girer.

**Zaman uyumu:** eski görevi bugünkü kuralla ölçme. Skill/rol beklentisi, görevin yapıldığı tarihte yürürlükte olan kuralla karşılaştırılır; `skills.coverage` bunu zaten yapar (kuraldan önce oluşturulan görevler hariç). Başka bir kural için aynısını sen yap: kuralın eklendiği commit tarihinden sonra oluşturulan görevlerle sınırla. Bu sınırı maddenin `doğrulandı` sütununda belirt.

## 6. Rapor

Raporu geçici bir dosyaya yaz (`###` başlıklar; `## ` yok):
```
### Özet
(aralık, görev sayısı, ölçüm toplamları, sinyal sayıları)
### Öneriler
(kategoriye göre tablo: # | öneri | kanıt | etki | efor | öncelik | doğrulandı)
### Düşen adaylar
(doğrulamada elenenler: aday — neden düştü; yoksa "yok")
### Açık noktalar
(- [önem] başlık — ayrıntı; veri yetersizliği, oturum kaydı olmayan görevler)
```
Tablodaki **doğrulandı** sütunu zorunludur: ne kontrol edildi ve hangi tarihe kadar (ör. `F-vlad-093 open (10-31), decision list --all temiz, git log roles/ 10-28→11-01 değişiklik yok`). Boş ya da "doğrulandı" tek başına yazılmış satır geçersizdir; böyle bir madde rapora girmez. Kategori boşsa tabloya "madde yok" satırı yaz. Her öneride ayrıca **kanıt ID'leri** (görev/bulgu/karar; kanıtsız öneri yazma), **etki**, **efor** (S/M/L), **öncelik** (yüksek/orta/düşük) bulunur.

**Claude mod önerisi** için öneri hücresi dört alan taşır: **mod türü** (panel/band/status line/toast/hook/komut), **tetik** (ne zaman görünür ya da çalışır), **gösterdiği veri** ve **kaynak** (CLI komutu ya da dosya). Örnek: `status line | tetik: görev awaiting_approval olunca | veri: onay bekleyen sayısı | kaynak: vlad status --summary`.

```
vlad task report <id> --file <rapor.md>
```
Sonra kullanıcıya aynı öneri tablosunu sohbette göster ve hangilerinin uygulanacağını sor. **Öneriler fikir olarak izlenir:** rapordaki her öneri için `vlad idea add --project <slug> --title "<öneri>" --source <denetim-görev-id> --detail-file -` (kanıt, etki, efor ayrıntıda); sonraki denetim `suggestions`'ta durumlarını görür. Seçilenler `/delegate` ile görev olur, görev açılınca `vlad idea promote <I-id> --task <T>`; reddedilenler `vlad idea set <I-id> dropped --reason "<neden>"`; seçilmeyen ama düşmeyenler `open` kalır. Görev `awaiting_approval`'dan `/status` akışıyla kapanır.
