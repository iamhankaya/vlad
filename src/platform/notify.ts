import type { Os } from "../machines/types.js";
import { assertNative } from "./native.js";
import { notImplemented } from "./not-implemented.js";

// Sözleşme (aktarım S; gövde A1). Bildirim metni argv (Mac) ya da env (Windows) ile geçer; kabuk dizesine gömülmez.
export interface Notifier { notify(title: string, body: string): Promise<void> }
export interface NotifyCommand { file: string; args: string[]; env?: Record<string, string> }

export function notifyCommand(_os: Os, _title: string, _body: string): NotifyCommand { return notImplemented("notifyCommand"); }

/** `exec` verilmezse gerçek çalıştırıcı kullanılır ve önce `assertNative` ister (A1 bu sırayı korur). */
export function createNotifier(os: Os, exec?: (c: NotifyCommand) => Promise<void>): Notifier {
  return {
    async notify(title, body) {
      if (!exec) assertNative("bildirim");
      const c = notifyCommand(os, title, body);
      await (exec ?? (() => notImplemented("bildirim çalıştırıcısı")))(c);
    },
  };
}
