import type { Command } from "commander";
import { def, out, readInput, type Opts } from "../cli-util.js";
import { listRolesWithWarnings } from "../roles/store.js";

export function registerRole(program: Command): void {
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
