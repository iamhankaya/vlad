// Sözleşme (T20261110-03, spec T20261110-02): `vlad setup` tipleri. Davranış yok; kabul/uygulama fazları bu şekle bağlanır.
// Değişiklik gerekirse `vlad task ask` ile sor. Anahtar/sır değeri hiçbir tipte, çıktıda ya da hata metninde taşınmaz.
import type { Os } from "../fleet/types.js";
import type { VladConfig } from "../kb/types.js";

/** `--check` çıkış kodları: 0 hepsi ok/n/a; 1 en az bir hata; 2 kullanım hatası (ör. etkileşimsizde eksik --answers). */
export const SETUP_EXIT = { ok: 0, failed: 1, usage: 2 } as const;
export type SetupExit = (typeof SETUP_EXIT)[keyof typeof SETUP_EXIT];

/** Kurulum parçaları (spec "Komut yüzeyi"); `--only` bu adları alır. */
export const PART_IDS = [
  "cli", "global-skills", "repo-skills", "permissions", "plugins", "hooks", "config", "kb", "agent", "launcher", "mac-main", "tools", "memory",
] as const;
export type PartId = (typeof PART_IDS)[number];

/** `eksik|eski|çakışan` hata sayılır; `n/a` bu platformda/kurulumda anlamsız. */
export type PartStatus = "ok" | "eksik" | "eski" | "çakışan" | "n/a";
export const FAILING_STATUSES: readonly PartStatus[] = ["eksik", "eski", "çakışan"];
/** error: hata → çıkış 1; warn: yalnız `--strict` ile; info: asla. */
export type Severity = "error" | "warn" | "info";

export interface ItemCheck { id: string; status: PartStatus; evidence: string; fix?: string }
export interface PartCheck {
  part: PartId;
  status: PartStatus;
  severity: Severity;
  /** Kısa, sırsız kanıt ("dist/cli.js var", "vlad-worker eski: karma farklı"). */
  evidence: string;
  /** Önerilen düzeltme komutu. */
  fix?: string;
  items?: ItemCheck[];
}
/** `vlad setup --check --json` çıktısı; şema: schemas/setup-check.schema.json. */
export interface SetupCheckResult {
  version: 1;
  platform: Os;
  role?: "brain" | "worker";
  strict: boolean;
  exit: 0 | 1;
  ok: boolean;
  /** Linux "deneysel" gibi bilgi satırları. */
  experimental?: string[];
  parts: PartCheck[];
}

/** Açık onay isteyen eylemler; `--yes` bunları ATLAMAZ, `--answers.confirm` içinde adıyla listelenmeli. */
export const CONFIRM_ACTIONS = ["kb-repo-create", "keygen", "agent-install", "mac-main-install", "permissions-write"] as const;
export type ConfirmAction = (typeof CONFIRM_ACTIONS)[number];

// ---- Envanter / manifest ---------------------------------------------------
export type Requirement = "zorunlu" | "isteğe bağlı" | "bilgi";
export type InventorySourceKind = "repo" | "vendor" | "npm" | "plugin" | "system" | "generated" | "user";
export type TargetScope = "claude-dir" | "vlad-home" | "kb" | "system";
/** Kontrolün nasıl yapılacağı (parça check() bunu yorumlar). */
export type InventoryCheck =
  | { kind: "file-exists" }
  | { kind: "content-hash"; against: string }
  | { kind: "json-contains"; keyPath: string; value?: unknown }
  | { kind: "command"; cmd: string; args: string[]; minVersion?: string }
  | { kind: "git-repo" }
  | { kind: "custom"; id: string };
export interface InventoryItem {
  /** `<parça>:<ad>` */
  id: string;
  part: PartId;
  label: string;
  source: { kind: InventorySourceKind; ref: string };
  /** Hedef yol (yok = sistem komutu vb.); `path` `~`/<VLAD_HOME> göreli, platforma göre çözülür. */
  target?: { scope: TargetScope; path: string };
  required: Requirement;
  platforms: readonly Os[];
  check: InventoryCheck;
}

// ---- Parça arayüzü ----------------------------------------------------------
export interface SetupContext {
  platform: Os;
  /** Kullanıcının HOME'u (test: geçici) ve Claude dizini (VLAD_CLAUDE_DIR ya da <home>/.claude). */
  home: string;
  claudeDir: string;
  vladHome: string;
  answers: SetupAnswers;
  dryRun: boolean;
  /** `--answers.confirm` (ve etkileşimli onaylar). */
  confirmed: ReadonlySet<ConfirmAction>;
  /** `--yes`: yalnız güvenli (yedekli ekleme/kopya) parçalarda onay atlar. */
  yes: boolean;
}
export interface ApplyAction { what: string; target?: string; kind: "write" | "skip" | "backup" | "run" | "print" }
export interface ApplyResult {
  part: PartId;
  /** false = "zaten güncel" (idempotens: check() ok ise hiçbir şey yazılmaz). */
  changed: boolean;
  actions: ApplyAction[];
  /** `settings.json.bak-<YYYYMMDDTHHmmss>` gibi alınan yedekler. */
  backups: string[];
  /** Onay/ön koşul yoksa atlanma nedeni. */
  skipped?: string;
}
export interface SetupPart {
  id: PartId;
  /** Salt okuma; ağ yok. */
  check(ctx: SetupContext): Promise<PartCheck>;
  /** Önce check() koşar; ok ise yazmaz. Kullanıcı ayarını silmez/ezmez; çakışanı `çakışan` raporlar. */
  apply(ctx: SetupContext): Promise<ApplyResult>;
  /** Yalnız VLAD'ın yazdığı girdileri geri alır. */
  uninstall?(ctx: SetupContext): Promise<ApplyResult>;
}

// ---- Cevap dosyası (--answers) ---------------------------------------------
export type KbMode = "local" | "github-new" | "existing" | "path";
export type ModelName = "haiku" | "sonnet" | "opus";
export interface SetupAnswers {
  role?: "brain" | "worker";
  machines?: "single" | "multi";
  machine?: { name?: string; agent?: { host?: string; port?: number; bind?: string } };
  /** Sır DEĞERİ asla: yalnız üretim yöntemi. */
  keys?: "generate" | "stdin";
  kb?: { mode?: KbMode; dir?: string; remote?: string; push?: boolean };
  cloud?: { kb?: "inline" | "readonly" };
  roots?: string[];
  worktreeDir?: string;
  ignore?: string[];
  models?: { main?: ModelName; roles?: ModelName; research?: ModelName };
  ctx?: { worker?: string; main?: string };
  limits?: { maxParallel?: number };
  launcher?: VladConfig["launcher"];
  autonomy?: VladConfig["defaultAutonomy"];
  experiments?: { ponytail?: "ab" };
  plugins?: string[];
  perms?: boolean;
  claudedirs?: boolean;
  mainsession?: boolean;
  agentboot?: boolean;
  digest?: { daily?: boolean };
  lang?: "tr";
  confirm?: ConfirmAction[];
}
export type AnswerValidation = { ok: true; answers: SetupAnswers } | { ok: false; errors: string[] };
export interface ValidateOptions { platform: Os; allowUnsupported?: boolean }

export type QuestionType = "choice" | "text" | "number" | "boolean" | "list" | "secret";
export type QuestionWrites = "config-local" | "local-json" | "claude-settings" | "kb" | "script" | "none";
export interface Question {
  /** `--answers` anahtarı (iç içe yol noktalı: `kb.mode` → {"kb":{"mode":...}}). */
  id: string;
  prompt: string;
  type: QuestionType;
  choices?: readonly string[];
  /** Arkadaş kurulumu varsayılanı (insan okur metin; mevcut config varsa o varsayılan olur). */
  default?: string;
  writes: QuestionWrites;
  /** true: kullanıcının mevcut değerine yalnız açık seçimle dokunulur (ör. ana oturum modeli). */
  neverOverwrite?: boolean;
}

// ---- Config overlay ---------------------------------------------------------
/** `vlad.config.local.json`: tracked `vlad.config.json` üstüne sığ birleşim; `null` anahtarı siler. Birleşim config şemasına göre doğrulanır. */
export type LocalConfigOverlay = { [K in keyof VladConfig]?: VladConfig[K] | null };
