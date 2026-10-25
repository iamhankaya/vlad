// Writes the chat agent's permission settings (the same rules `turnArgs` builds inline) to a file for the root-owned sandbox wrapper
// (deploy/bin/vlad-chat-turn). One source of truth: chatPermissions() in src/chat/sessionClient.ts.
// Usage: node scripts/gen-chat-settings.ts <kbDir> <protectDir>... > chat-settings.json
import { chatPermissions } from "../src/chat/sessionClient.ts";

const [kbDir, ...protect] = process.argv.slice(2);
if (!kbDir || !kbDir.startsWith("/")) {
  console.error("Kullanım: gen-chat-settings.ts <mutlak kb yolu> [<korunan mutlak yol>...]");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ permissions: chatPermissions(kbDir, protect) }, null, 2) + "\n");
