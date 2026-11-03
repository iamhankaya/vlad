# ponytail A/B deneyi: ölçüm geçerliliği

Deney (`vlad.config.json` `experiments.ponytail: "ab"`, D-vlad-060) şu an kapalıdır; yeniden açmak kullanıcıya kalır.

## Kesik prompt dönemi (T20261103-26)

2026-11-03 düzeltmesinden önce Windows launch/resume betiği prompt'u `claude … $p` ile geçiriyordu; Windows PowerShell 5.1
native argümandaki gömülü `"` işaretlerini kaçırmadığı için argüman ilk tırnakta bitiyordu (örnek: ~12,6 KB prompt'tan
çalışana 1898 karakter ulaştı). Etkisi: off kolunda (rol gövdesi satır içi) skill listesi ve VLAD standart blokları çalışana
hiç gitmedi; `task resume` prompt'ları da etkilendi.

- **Düzeltme:** `src/launcher/terminal.ts` `buildScript` prompt'u base64 ile gömer ve PowerShell < 7.3'te CommandLineToArgvW
  kurallarıyla kaçırır (7.3+ kendisi kaçırır). Launch, `--external`, `resume` ve uzak (Agent) betikleri aynı `buildScript`'i
  kullanır. Gerçek `powershell.exe` ile bayt bayt test: `test/launcher/prompt-bytes.test.ts`.
- **Ölçümden dışlama:** `PONYTAIL_AB_VALID_FROM` (`src/tasks/experiment.ts`) öncesinde oluşturulan kol görevleri
  `vlad audit setup`'ın `measures.by_ponytail` karşılaştırmasına girmez (toplamlar `measures.sums` yine hepsini sayar).
  Dışlanan bilinen görevler: T20261103-13, -15, -17, -21, -23, -25 (off kolu) ve aynı dönemdeki on kolu görevleri.
- **`vlad audit skills`:** off kolundaki görevlerde `ponytail` beklenmez (`audit setup` ile aynı kural).
