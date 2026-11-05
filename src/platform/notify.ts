import { execFile } from "node:child_process";
import type { Os } from "../machines/types.js";
import { assertNative } from "./native.js";

// Bildirim metni argv (Mac) ya da env (Windows) ile geçer; kabuk/betik dizesine gömülmez (enjeksiyon yok).
export interface Notifier { notify(title: string, body: string): Promise<void> }
export interface NotifyCommand { file: string; args: string[]; env?: Record<string, string> }

const MAC_SCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
const WIN_SCRIPT = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02')",
  "$t = $x.GetElementsByTagName('text')",
  "$t.Item(0).AppendChild($x.CreateTextNode($env:VLAD_TOAST_TITLE)) | Out-Null",
  "$t.Item(1).AppendChild($x.CreateTextNode($env:VLAD_TOAST_BODY)) | Out-Null",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('VLAD').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
].join("; ");

export function notifyCommand(os: Os, title: string, body: string): NotifyCommand {
  if (os === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT], env: { VLAD_TOAST_TITLE: title, VLAD_TOAST_BODY: body } };
  return { file: "osascript", args: [...MAC_SCRIPT.flatMap((l) => ["-e", l]), title, body] };
}

const run = (c: NotifyCommand) => new Promise<void>((resolve, reject) => {
  execFile(c.file, c.args, { env: { ...process.env, ...c.env }, timeout: 10_000, windowsHide: true }, (e) => (e ? reject(e) : resolve()));
});

/** Hata yutar (bildirim aktarımı bozmaz); `exec` verilmezse önce `assertNative` ister ve NativeDisabledError yutulmaz. */
export function createNotifier(os: Os, exec?: (c: NotifyCommand) => Promise<void>): Notifier {
  return {
    async notify(title, body) {
      if (!exec) assertNative("bildirim");
      try { await (exec ?? run)(notifyCommand(os, title, body)); } catch { /* bildirim başarısızlığı yutulur */ }
    },
  };
}
