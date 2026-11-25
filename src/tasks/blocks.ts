/**
 * Standard blocks of a worker's launch prompt (local and cloud): authority, pipeline pre-integration
 * check and real-source protection. One source, so the local `buildPrompt` and the cloud prompt cannot drift.
 */
export type BlockCtx = {
  taskId: string;
  autonomy: "plan" | "commit" | "pr";
  parent: string | null; // pipeline task id; null = not a pipeline phase
  mode: "local" | "cloud";
  /** Repo skills named on the project card; listed for local workers only (a cloud worker clones the repo and sees them itself). */
  projectSkills?: string[];
  /** Open findings of the project near the task's area (chosen by the caller, `relatedOpenFindings`); local non-plan prompts only. */
  relatedFindings?: { id: string; severity: string; title: string }[];
  /** Per-machine gate environment (`machines[].gateEnv[project]`, values as written, `$VAR` unexpanded); local non-plan prompts only. */
  gateEnv?: Record<string, string>;
  /** Worker runs on a machine that is not the brain (multi-machine); local non-plan prompts only. */
  remote?: boolean;
};

/**
 * Double-quoted shell value: escape `"`, backtick, backslash and every `$` that is not a supported `$VAR`/`${VAR}`
 * (F-vlad-352), so `$(...)`, `$1`, `${VAR:-x}` stay literal like in `gateEnvOf`; `$VAR`/`${VAR}` expand in both.
 */
const escapeGateValue = (v: string): string => v.replace(/(["`\\])/g, "\\$1").replace(/\$(?!\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_])/g, "\\$");

/** Gate environment block: workers must not trip over a missing DB URL / PATH entry and report a fake red (T20261117-04). */
const gateEnvBlock = (env: Record<string, string>): string =>
  "Gate ortamı (bu makinede kapı komutu ve testler bu ortamla koşar; değerleri aynen ver, `$PATH` kabukta açılır; sudo ya da elle kurulum isteyen betiğe takılma, bu ortam yeter):\n" +
  Object.entries(env).map(([k, v]) => `export ${k}="${escapeGateValue(v)}"`).join("\n");

/** Prompt cap of the related-findings list and of a title in it (a big project must not bloat the prompt). */
export const RELATED_FINDINGS_MAX = 15;
const RELATED_TITLE_MAX = 100;

const relatedFindingsBlock = (list: NonNullable<BlockCtx["relatedFindings"]>): string => {
  const lines = list.slice(0, RELATED_FINDINGS_MAX).map((f) => {
    const t = f.title.replace(/\s+/g, " ").trim();
    return `- ${f.id} [${f.severity}] ${t.length > RELATED_TITLE_MAX ? `${t.slice(0, RELATED_TITLE_MAX - 1)}…` : t}`;
  });
  return (
    "Projenin açık bulguları (dokunduğun alanla ilgili olabilir; liste kısaltılmıştır, `vlad finding list --project <slug>` tamamını verir):\n" +
    lines.join("\n") +
    "\nDokunduğun alanda düzelttiğin bulgu varsa kapanış raporunda `### Kapatılan bulgular` altında tam ID (`F-<proje>-NNN`; aralık/kısaltma yok), sonuç (fixed / zaten düzelmiş) ve kanıtla (commit ya da dosya:satır) yaz; commit mesajında da tam ID kullan."
  );
};

export const BLOCKS_HEADING = "VLAD standart blokları:";

const realSource = (mode: BlockCtx["mode"]): string =>
  "Gerçek kaynak koruması: testleri, mutasyon denemelerini ve denetimleri geçici dizinde ve sahte kaynakla koş. " +
  `Kullanıcının gerçek dizinlerine, Geri Dönüşüm'üne, ana reponun \`node_modules\`/bağımlılık klasörlerine, ${
    mode === "local" ? "`~/.claude` ve `~/.codex` dosyalarına, " : ""
  }kayıt defterine ve canlı hesaplara dokunma, silme ya da boşaltma; silme gerektiren testte önce hedefin geçici dizin olduğunu doğrula (\`realpath\` ile).`;

const prLocal = (id: string): string =>
  `Yetki (autonomy pr): yalnız \`vlad/${id}\` dalını \`git push -u origin vlad/${id}\` ile push edebilir ve CI'ı ` +
  `\`gh run list --branch vlad/${id}\` / \`gh run watch <run-id> --exit-status --interval 60\` ile izleyebilirsin. Yasak: başka dala push, \`--force\`, ana veya entegrasyon dalına merge/PR, ` +
  "ana dala dokunma, kb dosyalarını doğrudan düzenleme (yerelde yalnız `vlad task log/ask/report` CLI'ı). " +
  `Merge'süz PR (kaynak dal vlad/${id}) yalnız pipeline dışı görevde \`gh pr create --head vlad/${id}\`; pipeline fazında PR açma. ` +
  "CI: tek bir `gh run watch --interval 60` kullan (yoklama döngüsü kurma; varsayılan 3 sn aralık GitHub API sınırını tüketir); bellek/oturum uyarısı ya da 20 dk sessizlik olursa izlemeyi bırak, " +
  `\`vlad task log ${id} "CI: <run-id> izleniyor/bekliyor"\` yaz ve raporla; boşta bekleyerek oturum tüketme. ` +
  "CI tur kuralı: kırmızıyı düzeltip yeniden push edersin, ama aynı neden ikinci kez kırmızı çıkarsa dur ve " +
  `\`vlad task ask ${id} "CI: <neden>, 2. tur"\` sor; entegrasyon dalından gelen (kendi değişikliğin olmayan) kırmızı tur sayılmaz: ` +
  "düzeltmeye çalışma, raporun `### Açık noktalar`'ına yaz. Kırmızıyı sınıflarken (`gh run view --log-failed`) kendi değişikliği / entegrasyondan gelen / ortam / Linux farkı / bayat kayıt dosyası ayrımını yap; push'tan önce betiklerin `100755` olduğunu ve kayıt dosyalarının üretici betikle eşleştiğini denetle (ayrıntı: `vlad-worker` skill'i, \"CI izleme\").";

const commitLocal = (id: string): string =>
  `Yetki (autonomy commit): yalnız \`vlad/${id}\` dalında commit'le; push etme, PR açma, ana veya entegrasyon dalına merge etme. CI yoksa kapı komutunu yerelde koş.`;

const cloudAuthority = (id: string, a: string): string =>
  `Yetki (bulut, autonomy ${a}): yalnız \`vlad/${id}\`'ye commit + push. \`gh\` ve CI izleme senin işin değil: push'tan sonra CI sonucunu VLAD okur; ` +
  "görev `## Bağlam`'ında önceki CI günlükleri verildiyse işe başlamadan oku. Aynı kırmızı neden ikinci kez çıkarsa `[VLAD:ASK #n]` ile sor; " +
  "entegrasyon dalından gelen kırmızıyı düzeltmeye çalışma, `### Açık noktalar`'a yaz.";

/** Remote worker rules (moved out of the vlad-worker skill: only a task placed on a non-brain machine needs them). */
const remoteBlock = (): string =>
  "Çok makine işçisi (bu makine beyin değil): kb klonun **salt okunurdur**; kb'ye yazma beyindedir. `vlad task log|ask|report|session` yerel VLAD Agent'a iletilir ve beyinde işlenir (`--file` rapor yine yerel dosyadan okunur). " +
  "Başka yazma komutu (`task set`, `finding add`, `kb commit`) işçide reddedilir: zorlama; gerekirse `vlad task ask` ile bildir. " +
  "Takılırsan (`stalled`) ya da görevi tamamlayamazsan `task set` çalışmaz: nedeni `vlad task log` ile yaz, gerekirse `vlad task ask` ile bildir (beyin `task set <id> running` ile geri alır). " +
  "Beyne ulaşılamazsa yazma yedek kuyruğa alınır (`kuyruğa alındı (seq N)`; hata değil, devam et); durum `vlad queue list`, şimdi dene `vlad queue flush`, başarısız girdi `vlad queue drop <seq>`; rapor kuyruktaysa `awaiting_approval` beyne ulaşana dek oluşmaz. " +
  "Yerel Agent çalışmıyorsa komut \"yerel VLAD Agent çalışmıyor (vlad agent status)\" ile geçici hata verir (çıkış 75); kullanıcıya söyle. " +
  "Görev klasörün (`worktree`) işçide; kb'yi işçideki klondan oku (beyin push ettiğinde `kb-sync` ile güncellenir).";

const SHARED_FILES =
  "Paylaşılan kayıt dosyalarında (test_map, registry, `contract.ts`) yalnız kendi satırlarını ekle; çakışırsa dosyayı üretici betikle yeniden üret, elle satır karıştırma.";

function pipelineBlock(parent: string, mode: BlockCtx["mode"]): string {
  // cloud: the local integration branch is not trusted (a fetch does not advance it, it may not exist)
  const merge = mode === "cloud"
    ? `\`git fetch origin vlad/${parent}\` ardından \`git merge FETCH_HEAD\` (fetch başarısızsa merge deneme, raporla)`
    : `\`git merge vlad/${parent}\``;
  return (
    // cloud: a markdown section of its own, as the earlier cloud prompt had it
    (mode === "cloud" ? "## Entegrasyon öncesi kontrol\n" : "") +
    `Pipeline fazı: dalın entegrasyon dalı \`vlad/${parent}\`'tan açıldı. Rapordan önce entegrasyon dalını **kendi dalına** al (${merge}; ` +
    "entegrasyon dalına merge değildir), sonra lint + proje `gate` komutu; çakışma/kırmızıysa kapsam dışıysa çözmeye çalışma, " +
    "`### Test sonuçları` ve `### Açık noktalar`'a `- [yüksek] entegrasyon kontrolü kırmızı — …` yaz. " +
    `Raporun \`### Test sonuçları\` bölümüne tam şu satırı yaz (\`task close\` bunu arar; eksik/başka biçimde kapanış durur): ` +
    `\`Entegrasyon öncesi kontrol: vlad/${parent} merge (<sha>) + lint + gate yeşil\` (<sha> = merge sonrası HEAD; kırmızıysa "yeşil" yerine sonucu yaz). ` +
    `Entegrasyon dalına merge/PR/push yok (kapıyı VLAD yürütür). ${SHARED_FILES}`
  );
}

/** Ordered blocks: authority, pipeline check, real-source protection. `plan` gets no merge/test-mutation instructions. */
export function standardBlocks(ctx: BlockCtx): string[] {
  const { taskId: id, autonomy, parent, mode } = ctx;
  if (autonomy === "plan") {
    return ["Yetki (autonomy plan): kod yazma, push/merge yok; yalnız raporla.", realSource(mode)];
  }
  const authority = mode === "cloud" ? cloudAuthority(id, autonomy) : autonomy === "pr" ? prLocal(id) : commitLocal(id);
  const repoSkills = mode === "local" && ctx.projectSkills?.length
    ? [`Projenin repo skill'leri: ${ctx.projectSkills.map((s) => `\`${s}\``).join(", ")}. İşe başlamadan hepsini Skill aracıyla yükle (zorunlu); yükleyemediysen nedenini kapanış raporuna yaz.`]
    : [];
  const related = mode === "local" && ctx.relatedFindings?.length ? [relatedFindingsBlock(ctx.relatedFindings)] : [];
  const gateEnv = mode === "local" && ctx.gateEnv && Object.keys(ctx.gateEnv).length ? [gateEnvBlock(ctx.gateEnv)] : [];
  const remote = mode === "local" && ctx.remote ? [remoteBlock()] : [];
  return [authority, ...(parent ? [pipelineBlock(parent, mode)] : []), ...remote, ...repoSkills, ...gateEnv, ...related, realSource(mode)];
}
