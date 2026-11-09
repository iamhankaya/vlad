import { agentPart, launcherPart, macMainPart, memoryPart, toolsPart } from "./parts-env.js";
import { cliPart, configPart, globalSkillsPart, hooksPart, kbPart, permissionsPart, pluginsPart, repoSkillsPart } from "./parts-files.js";
import type { PartId, SetupPart } from "./types.js";

/** Uygulama sırası: bağımlılık (config → kb → agent anahtarları) gözetilir. */
export const PARTS: readonly SetupPart[] = [toolsPart, cliPart, configPart, kbPart, globalSkillsPart, repoSkillsPart, hooksPart, permissionsPart, pluginsPart, agentPart, launcherPart, macMainPart, memoryPart];
export const partById = (id: PartId): SetupPart => PARTS.find((p) => p.id === id)!;
