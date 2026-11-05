import { readFileSync, writeFileSync } from "node:fs";
import { createBackend } from "./backend.js";
import { readClipState, writeClipState } from "./state.js";
import { validPng, validUtf8 } from "./sync.js";
import { CLIP_MAX_IMAGE_BYTES, CLIP_MAX_TEXT_BYTES } from "./types.js";
import type { ClipboardBackend, ClipContent } from "./types.js";

// `vlad clip on|off|status|get|set`. get/set YEREL panoyu okur/yazar; ortak pano açıksa çalışan Agent değişikliği
// yoklamada görür ve karşıya yayar (set ayrıca bir gönderim yapmaz). Çıktı io.write ile (testte yakalanır).
export interface ClipCommandOpts { json?: boolean; file?: string; text?: string; image?: string; out?: string }
export interface ClipCliIo {
  backend?: ClipboardBackend;
  write?(s: string): void;
  probe?(): Promise<{ alive: boolean }>;
  stdin?(): Promise<Buffer>;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function runClip(sub: "on" | "off" | "status" | "get" | "set", o: ClipCommandOpts, io: ClipCliIo = {}): Promise<void> {
  const write = io.write ?? ((s: string) => { process.stdout.write(s); });
  const say = (obj: unknown, human: string) => write(o.json ? JSON.stringify(obj) + "\n" : human + "\n");

  if (sub === "on" || sub === "off") {
    writeClipState({ enabled: sub === "on" });
    say({ enabled: sub === "on" }, `ortak pano ${sub === "on" ? "açık" : "kapalı"}`);
    return;
  }
  if (sub === "status") {
    const { enabled } = readClipState();
    let agentRunning = false;
    try { agentRunning = (await (io.probe ?? (async () => (await import("../agent/start.js")).probeLocal()))()).alive; } catch { /* kimlik/config yok: çalışmıyor say */ }
    say({ enabled, agentRunning }, `ortak pano ${enabled ? "açık" : "kapalı"}; Agent ${agentRunning ? "çalışıyor" : "çalışmıyor (pano eşitleme için `vlad agent start`)"}`);
    return;
  }

  const backend = io.backend ?? createBackend(process.platform);
  try {
    if (sub === "get") {
      const { content } = await backend.read();
      if (!content) throw new Error("pano boş (metin ya da resim yok)");
      if (content.kind === "text") { const t = content.bytes.toString("utf8"); o.json ? say({ kind: "text", text: t }, "") : write(t); return; }
      if (!o.out) throw new Error("panoda resim var: --out <png> ver");
      writeFileSync(o.out, content.bytes);
      say({ kind: "image", out: o.out, bytes: content.bytes.length }, `resim yazıldı: ${o.out} (${content.bytes.length} bayt)`);
      return;
    }
    // set
    const srcs = [o.text !== undefined, o.file !== undefined, o.image !== undefined].filter(Boolean).length;
    if (srcs === 0) throw new Error("set: metin, --file <yol|-> ya da --image <png> ver");
    if (srcs > 1) throw new Error("set: yalnız birini ver: metin, --file ya da --image");
    let c: ClipContent;
    if (o.image !== undefined) {
      const b = readFileSync(o.image);
      if (b.length > CLIP_MAX_IMAGE_BYTES) throw new Error("set: resim 20 MiB'ı aşıyor");
      if (!validPng(b)) throw new Error("set: dosya geçerli PNG değil");
      c = { kind: "image", bytes: b };
    } else {
      const b = o.file !== undefined ? (o.file === "-" ? await (io.stdin ?? readStdin)() : readFileSync(o.file)) : Buffer.from(o.text!, "utf8");
      if (b.length > CLIP_MAX_TEXT_BYTES) throw new Error("set: metin 1 MiB'ı aşıyor");
      if (!validUtf8(b)) throw new Error("set: metin geçerli UTF-8 değil");
      c = { kind: "text", bytes: b };
    }
    const seq = await backend.changeCount();
    const w = await backend.write(c, seq);
    if (!w.written) throw new Error("set: pano yazma sırasında değişti; yeniden dene");
    say({ kind: c.kind, bytes: c.bytes.length }, `panoya yazıldı (${c.kind}, ${c.bytes.length} bayt)`);
  } finally {
    if (!io.backend) await backend.close().catch(() => {});
  }
}
