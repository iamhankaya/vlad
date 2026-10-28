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
};

export const BLOCKS_HEADING = "VLAD standart blokları:";

const realSource = (mode: BlockCtx["mode"]): string =>
  "Gerçek kaynak koruması: testleri, mutasyon denemelerini ve denetimleri geçici dizinde ve sahte kaynakla koş. " +
  `Kullanıcının gerçek dizinlerine, Geri Dönüşüm'üne, ana reponun \`node_modules\`/bağımlılık klasörlerine, ${
    mode === "local" ? "`~/.claude` ve `~/.codex` dosyalarına, " : ""
  }kayıt defterine ve canlı hesaplara dokunma, silme ya da boşaltma; silme gerektiren testte önce hedefin geçici dizin olduğunu doğrula (\`realpath\` ile).`;

const prLocal = (id: string): string =>
  `Yetki (autonomy pr): yalnız \`vlad/${id}\` dalını \`git push -u origin vlad/${id}\` ile push edebilir ve CI'ı ` +
  `\`gh run list --branch vlad/${id}\` / \`gh run watch <run-id> --exit-status\` ile izleyebilirsin. Yasak: başka dala push, \`--force\`, ana veya entegrasyon dalına merge/PR, ` +
  "ana dala dokunma, kb dosyalarını doğrudan düzenleme (yerelde yalnız `vlad task log/ask/report` CLI'ı). " +
  `Merge'süz PR (kaynak dal vlad/${id}) yalnız pipeline dışı görevde \`gh pr create --head vlad/${id}\`; pipeline fazında PR açma. ` +
  "CI: tek bir `gh run watch` kullan (yoklama döngüsü kurma); bellek/oturum uyarısı ya da 20 dk sessizlik olursa izlemeyi bırak, " +
  `\`vlad task log ${id} "CI: <run-id> izleniyor/bekliyor"\` yaz ve raporla; boşta bekleyerek oturum tüketme. ` +
  "CI tur kuralı: kırmızıyı düzeltip yeniden push edersin, ama aynı neden ikinci kez kırmızı çıkarsa dur ve " +
  `\`vlad task ask ${id} "CI: <neden>, 2. tur"\` sor; entegrasyon dalından gelen (kendi değişikliğin olmayan) kırmızı tur sayılmaz: ` +
  "düzeltmeye çalışma, raporun `### Açık noktalar`'ına yaz. Ayrıntı için `ci-triage` skill'ini yükle (yoksa bu kural yeterlidir).";

const commitLocal = (id: string): string =>
  `Yetki (autonomy commit): yalnız \`vlad/${id}\` dalında commit'le; push etme, PR açma, ana veya entegrasyon dalına merge etme. CI yoksa kapı komutunu yerelde koş.`;

const cloudAuthority = (id: string, a: string): string =>
  `Yetki (bulut, autonomy ${a}): yalnız \`vlad/${id}\`'ye commit + push. \`gh\` ve CI izleme senin işin değil: push'tan sonra CI sonucunu VLAD okur; ` +
  "görev `## Bağlam`'ında önceki CI günlükleri verildiyse işe başlamadan oku. Aynı kırmızı neden ikinci kez çıkarsa `[VLAD:ASK #n]` ile sor; " +
  "entegrasyon dalından gelen kırmızıyı düzeltmeye çalışma, `### Açık noktalar`'a yaz.";

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
    ? [`Projenin repo skill'leri: ${ctx.projectSkills.map((s) => `\`${s}\``).join(", ")}. Göreve uyanları Skill aracıyla yükle; yüklemediysen nedenini kapanış raporuna yaz.`]
    : [];
  return [authority, ...(parent ? [pipelineBlock(parent, mode)] : []), ...repoSkills, realSource(mode)];
}
