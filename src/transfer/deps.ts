import { agentDir } from "../fleet/state.js";
import { agentEnv } from "../agent/ops/env.js";
import { readClipState } from "../clip/state.js";
import { createBackend } from "../clip/backend.js";
import { createClipSenders } from "../clip/senders.js";
import { loadConfig } from "../kb/config.js";
import { nowMs } from "../fleet/clock.js";
import type { Os } from "../fleet/types.js";
import { nativeAllowed } from "../platform/native.js";
import { createNotifier, type Notifier } from "../platform/notify.js";
import { createOriginMarker } from "../platform/origin.js";
import type { ClipDeps } from "../clip/types.js";
import { downloadsDir } from "./paths.js";
import type { AktarimDeps } from "./types.js";
import { selfName } from "../fleet/state.js";

export type { AktarimDeps } from "./types.js";

const silentNotifier: Notifier = { notify: async () => {} };

/**
 * Üretim bağımlılıkları (start.ts çağırır). `nativeAllowed()` false ise sessiz bildirici ve devre dışı pano döner:
 * hiçbir gerçek pano/bildirim/yardımcı süreç çağrısı yapılmaz.
 */
export function createProdDeps(): AktarimDeps {
  const cfg = loadConfig();
  const self = selfName();
  const kind = self === cfg.brain ? "brain-agent" : "worker-agent";
  const native = nativeAllowed();
  const os = process.platform as Os;
  const others = (cfg.machines ?? []).filter((m) => m.name !== self);
  const clip: ClipDeps = {
    backend: createBackend(process.platform),
    send: createClipSenders(() => agentEnv().transport, () => clip.peer),
    now: nowMs,
    isEnabled: () => { if (!native) return false; try { return readClipState().enabled; } catch { return false; } },
    log: (m) => process.stderr.write(`clip: ${m}\n`),
    rank: kind === "brain-agent" ? 1 : 0,
    peer: others.length === 1 ? others[0]!.name : null,
  };
  return {
    self, kind, cfg: () => loadConfig(), now: nowMs, env: () => agentEnv(),
    xfer: { downloads: () => downloadsDir(), stateDir: () => agentDir(), os, notifier: native ? createNotifier(os) : silentNotifier, now: nowMs, ...(native ? { markOrigin: createOriginMarker(os) } : {}) },
    clip,
  };
}
