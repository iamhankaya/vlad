import type { Command } from "commander";
import { join } from "node:path";
import { listRolesWithWarnings } from "../../roles/store.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerRole(program: Command, k: Kit): void {
  const { out, def } = k;
  const role = program.command("role").description("Uzman roller");
  def(role, "list", "roles/ altındaki rolleri listeler", (o: Opts) => {
    const { roles, warnings } = listRolesWithWarnings();
    out(
      o,
      { roles, warnings },
      [...roles.map((r) => `${r.slug}  ${r.kind}  ${r.title}`), ...warnings.map((w) => `uyarı: ${w}`)].join("\n"),
    );
  });
}
