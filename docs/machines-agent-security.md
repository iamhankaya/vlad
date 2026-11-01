# VLAD Agent: güvenlik varsayımları (T20261101-24)

- **Konsol anahtarı tam yetkidir.** Konsol kimliği (`vlad remote`) katalogdaki her `vlad` komutunu beyinde çalıştırabilir; `project set <slug> gate|repo` gibi alanlar beyinde sonradan komut çalıştırdığından konsol anahtarı dolaylı komut çalıştırma yetkisi sayılmalıdır. Anahtarı yalnız vlad-desktop makinesinde tut. Alanları konsolda kısıtlamak kullanıcı kararıdır.
- **Düz TCP, şifreleme yok.** İstekler HMAC ile imzalıdır (kimlik, bütünlük, ±120 sn tazelik); gizlilik yoktur. Journal'lanmayan okuma `exec`'leri 120 sn içinde yeniden oynatılabilir. Agent yalnız loopback/RFC1918/link-local adrese bağlanır; özel ağ (LAN/VPN) varsay.
- **Anahtar dosyası** (`vlad.local.json`) 0600 / dizin 0700 yazılır; Windows'ta ACL kullanıcı profiline dayanır.
- Konsoldan dosya yolu okunamaz: dosya bayrakları yalnız `-` (stdin) kabul eder (katalog + `readInput` çift savunma).
