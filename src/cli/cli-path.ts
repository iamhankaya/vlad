import { fileURLToPath } from "node:url";

/** `import.meta.url` → filesystem path; `windows` forces Windows forms (`file:///C:/…`, UNC) for tests on any OS. */
export const cliPathFromUrl = (url: string, windows = process.platform === "win32"): string => fileURLToPath(url, { windows });
