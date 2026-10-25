import { homedir } from "node:os";
import { join } from "node:path";
import { PairingCodes } from "./auth/pairing.ts";

const stateDir = process.env.VLAD_SERVER_STATE_DIR ?? join(homedir(), ".vlad-server");
const [cmd] = process.argv.slice(2);

if (cmd === "pair") {
  const { code, expires } = new PairingCodes(stateDir, Date.now).issue();
  console.log(`Eşleştirme kodu: ${code}`);
  console.log(`Geçerlilik: 10 dk (${new Date(expires).toISOString()}), tek kullanım, 5 yanlışta yanar.`);
} else {
  console.error("Kullanım: vlad-server pair");
  process.exit(cmd ? 2 : 0);
}
