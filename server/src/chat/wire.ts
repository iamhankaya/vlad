import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { EventLedger } from "../events/ledger.ts";
import { ClaudeCliClient, SessionStore, sessionFileFor } from "./sessionClient.ts";
import { ChatTurnRunner } from "./turnRunner.ts";

/** What the checks look at; tests substitute it. */
export interface FsProbe {
  lstat(p: string): { uid: number; mode: number; isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; isSocket(): boolean };
  realpath(p: string): string;
}
const realFs: FsProbe = { lstat: (p) => lstatSync(p), realpath: (p) => realpathSync(p) };

/** The only client path the API will run (install.sh puts it there, root-owned). A configured path must equal it. */
export const CHAT_CLIENT_PATH = "/usr/local/libexec/vlad/chat-client";

/** Where systemd (vlad-chat.socket) listens; the client script connects here. */
export const CHAT_SOCKET = "/run/vlad-chat/turn.sock";

const NOT_OWNER_ONLY = 0o022; // group or other write

/**
 * F-vlad-024 (fail-closed): the chat turn runs as another uid in a systemd sandbox. The API only starts the chat when the client script that
 * hands the turn over is a root-owned file in root-owned directories (nothing the agent or the API user can swap) and the socket exists.
 * Returns why not, or null.
 */
export function chatSandboxProblem(
  clientPath: string, fs: FsProbe = realFs, socketPath: string = CHAT_SOCKET,
  o: { expected?: string; uid?: number } = {},
): string | null {
  if (!isAbsolute(clientPath)) return "VLAD_CHAT_CLIENT mutlak yol olmalı";
  if (clientPath !== (o.expected ?? CHAT_CLIENT_PATH)) return `VLAD_CHAT_CLIENT sabit yol olmalı: ${o.expected ?? CHAT_CLIENT_PATH}`;
  let real: string;
  try { real = fs.realpath(clientPath); } catch { return `VLAD_CHAT_CLIENT yok: ${clientPath}`; }
  if (real !== clientPath) return "VLAD_CHAT_CLIENT symlink içeremez";
  const st = fs.lstat(clientPath);
  if (!st.isFile() || st.uid !== 0 || (st.mode & NOT_OWNER_ONLY) !== 0) return "VLAD_CHAT_CLIENT root'a ait, grup/başkası yazamaz bir dosya olmalı";
  for (let d = dirname(clientPath); ; d = dirname(d)) {
    const ds = fs.lstat(d);
    if (!ds.isDirectory() || ds.uid !== 0 || (ds.mode & NOT_OWNER_ONLY) !== 0) return `üst dizin güvenli değil (root'a ait, grup/başkası yazamaz olmalı): ${d}`;
    if (d === dirname(d)) break;
  }
  let sock: ReturnType<FsProbe["lstat"]>;
  try { sock = fs.lstat(socketPath); } catch { return `sohbet soketi yok: ${socketPath} (vlad-chat.socket etkin mi?)`; }
  if (!sock.isSocket()) return `${socketPath} bir soket değil`;
  // the socket belongs to the API user and nobody else can connect (SocketUser=vladapi, SocketMode=0600)
  const uid = o.uid ?? process.getuid?.();
  if (uid !== undefined && sock.uid !== uid) return `${socketPath} bu kullanıcıya ait değil`;
  if ((sock.mode & 0o077) !== 0) return `${socketPath} grup/başkası erişebilir (0600 olmalı)`;
  return null;
}

export interface ChatWireOptions {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  kbDir: string;
  ledger: Pick<EventLedger, "append">;
  log: (msg: string) => void;
  fs?: FsProbe;
  socketPath?: string;
  /** Tests only. */
  expectedClient?: string;
  uid?: number;
}

/**
 * The production chat runner, or undefined (the chat routes then answer 501). Undefined unless `VLAD_CHAT_CLIENT` is set and the sandbox
 * passes {@link chatSandboxProblem}: there is no path that runs `claude` as the API user.
 */
export function createChatRunner(o: ChatWireOptions): ChatTurnRunner | undefined {
  const client = o.env.VLAD_CHAT_CLIENT;
  if (!client) return undefined;
  const problem = chatSandboxProblem(client, o.fs, o.socketPath, { expected: o.expectedClient, uid: o.uid });
  if (problem) {
    o.log(`sohbet kapalı (501): ${problem}`);
    return undefined;
  }
  return new ChatTurnRunner({
    client: new ClaudeCliClient({ bin: client, cwd: o.kbDir, protect: [o.stateDir], env: o.env }),
    sessions: new SessionStore(sessionFileFor(o.stateDir)),
    ledger: o.ledger,
    stateDir: o.stateDir,
    now: Date.now,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
  });
}
