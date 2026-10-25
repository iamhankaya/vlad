import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./files.ts";

export type DeviceRecord = {
  device_id: string;
  device_name: string;
  /** `session` key: signs request envelopes. SPKI DER base64url. */
  session_pub: string;
  /** `approval` key: signs challenges, grants and revocations (biometric-gated on the phone). */
  approval_pub: string;
  fcm_token?: string;
  created: string;
  revoked_at?: string;
};

/** Paired-device ledger (`devices.json`). Single writer: the API process; revoked devices are kept (their id must stay unique). */
export class DeviceLedger {
  private readonly file: string;
  private readonly byId = new Map<string, DeviceRecord>();
  private readonly revokeListeners: ((id: string) => void)[] = [];

  constructor(stateDir: string) {
    this.file = join(stateDir, "devices.json");
    for (const d of readJsonFile<{ devices: DeviceRecord[] }>(this.file)?.devices ?? []) this.byId.set(d.device_id, d);
  }

  get(id: string): DeviceRecord | undefined {
    return this.byId.get(id);
  }

  list(): DeviceRecord[] {
    return [...this.byId.values()];
  }

  hasKey(pub: string): boolean {
    return this.list().some((d) => d.session_pub === pub || d.approval_pub === pub);
  }

  /** Slug of the name with a numeric suffix on collision (`d-pixel-9`, `d-pixel-9-2`). */
  allocateId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "device";
    let id = `d-${slug}`;
    for (let n = 2; this.byId.has(id); n++) id = `d-${slug}-${n}`;
    return id;
  }

  add(rec: DeviceRecord): void {
    this.byId.set(rec.device_id, rec);
    this.save();
  }

  /** Idempotent. Returns false if the device does not exist. Listeners (SSE, challenges, grants: later slices) run after the write. */
  revoke(id: string, nowIso: string): boolean {
    const d = this.byId.get(id);
    if (!d) return false;
    if (!d.revoked_at) {
      d.revoked_at = nowIso;
      this.save();
      for (const cb of this.revokeListeners) cb(id);
    }
    return true;
  }

  onRevoke(cb: (id: string) => void): void {
    this.revokeListeners.push(cb);
  }

  private save(): void {
    writeJsonAtomic(this.file, { devices: this.list() });
  }
}
