# Mac CI runner (F-vlad-116)

GitHub self-hosted runner, Mac mini'de **ayrı, admin olmayan** kullanıcı hesabında. Betik: `scripts/mac/ci-runner.sh` (varsayılan `--dry-run`). Denetim: `scripts/mac/audit.sh` (`ci-user`, `ci-runner` satırları).

## Neden ayrı hesap
Runner, workflow'daki kodu çalıştırır. Beyin hesabında (`~/.claude`, `vlad.local.json` Agent anahtarları, kb, GitHub oturumu) çalışırsa bir workflow bunların hepsini okuyabilir. Ayrı hesap bu yüzeyi keser; runner'ın bu hesaptan beyin dizinlerine okuma izni olmamalı (`chmod 700` ev dizinleri varsayılandır, doğrula).

## Kullanıcı adımları (betik yapmaz)
1. **Hesap (§2):** `sudo sysadminctl -addUser vlad-ci -fullName "VLAD CI" -password -` (admin DEĞİL; parola istenir). `vlad-ci` kullanıcısı GUI oturumunda açık olmalı (runner kullanıcı LaunchAgent'ı olarak çalışır): Fast User Switching ile giriş yapıp açık bırak. Kontrol: `id -Gn vlad-ci` içinde `admin` yok.
2. **Araçlar:** Xcode (lisans: `sudo xcodebuild -license accept`), `xcode-select -p`. iOS imzalama sertifikaları/profilleri yalnız `vlad-ci` anahtar zincirine konur, beyin hesabının anahtar zincirinden kopyalanmaz.
3. **Sürüm ve sha256:** GitHub `actions/runner` sürüm sayfasından sürümü ve `osx-arm64` tarball'unun sha256'sını al.
4. **Kayıt token'ı:** repo > Settings > Actions > Runners > New self-hosted runner (1 saat geçerli, tek kullanımlık).
5. **Repo ayarları:** Actions > General > *Fork pull request workflows from outside collaborators*: **Require approval for all outside collaborators** (en az); fork PR'larda çalıştırmayı kapalı tut, repo **private** kalsın. Public repoda self-hosted runner kullanma.
6. **Workflow:** `runs-on: [self-hosted, macOS, vlad-ci]`; secret'ları yalnız güvenilen dalda (push/korumalı ortam) ver.

## Kurulum (vlad-ci hesabında)
```
# önce neyi yapacağını gör
scripts/mac/ci-runner.sh --repo-url https://github.com/<sahip>/<repo> --version <X.Y.Z> --sha256 <hex>
# uygula; token stdin'den (kabuk geçmişine/argv'ye yazılmasın)
pbpaste | scripts/mac/ci-runner.sh --repo-url ... --version ... --sha256 ... --apply --token-stdin
```
İdempotent: `.runner` varsa indirme/kayıt, `.service` varsa servis kurulumu atlanır. Betik root'ta, CI hesabı dışında ve admin grubundaki hesapta `--apply`'ı reddeder; sha256 uyuşmazsa hiçbir şey kurmaz.

## Ağır iş ve VLAD paralelliği
Runner ile VLAD çalışanları aynı makinenin CPU/RAM'ini paylaşır. iOS build sırasında `vlad.config.json` > `machines[mac].maxParallel` değerini düşür (ör. 2) ve build bitince geri al; değişiklik elle yapılır, betik config'e dokunmaz.

## Bilinen sınırlar
- `config.sh` token'ı yalnız argv ile alır; token kısa süre `ps`te görünür (tek kullanımlık, 1 saat). Betik token'ı komut çıktısına yazmaz.
- Runner güncellemesi (`--version`) elle yapılır: yeni sürüm + sha256 ile `svc.sh uninstall`, `.runner` kaldırma, yeniden kayıt; otomatik güncelleme GitHub tarafından yapılabilir.
- Gerçek GitHub'a kayıt, iOS build ve fork-PR ayarı bu depoda prova edilmedi (dış etki).
