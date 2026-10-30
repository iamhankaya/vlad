import type { Writable } from "node:stream";

/** A reader that closed the pipe early (`vlad … | head`, a UI that stopped listening) must not crash the CLI with EPIPE. */
export function swallowEpipe(stream: Writable): void {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
  });
}
