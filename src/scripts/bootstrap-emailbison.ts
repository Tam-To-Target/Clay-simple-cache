/**
 * Populate `emailbison_workspaces` (client → EmailBison workspace) from GTMOS,
 * so the suppression run knows which workspace blocklist to write for each client.
 *
 *   npm run emailbison:bootstrap             # DRY-RUN — print the map it would write
 *   npm run emailbison:bootstrap -- --execute  # write it
 *   npm run emailbison:bootstrap -- <slug>     # a single client (external_id)
 *
 * Mapping chain (robust — no name guessing on the happy path):
 *   GTMOS /api/internal/emailbison-tokens → { workspaceId, clientId(GTMOS uuid), workspaceName }
 *   GTMOS /api/internal/clients           → { id(GTMOS uuid) → slug }
 *   local Client.external_id == slug       (clientService.getByExternalId)
 * Fallback: if the GTMOS client isn't in the roster, case-insensitive match of
 * workspaceName ↔ local Client.name. Anything still unmatched is LOGGED, not guessed.
 *
 * The per-workspace API KEY is never stored here — only the id/name mapping.
 * Idempotent upsert on (client_id, workspace_id). Existing rows are not
 * auto-deactivated (workspace↔client rarely changes); flip `active` by hand if needed.
 */
import dotenv from "dotenv";
dotenv.config();

import prisma from "../db/prisma";
import { clientService } from "../services/client.service";
import { listWorkspaceKeys } from "../services/emailbison-token.service";
import { fetchClients } from "../services/sdr-launch.service";

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const onlySlug = args.find((a) => !a.startsWith("--"));

  if (!process.env.SDR_LAUNCH_INTERNAL_URL || !process.env.SDR_LAUNCH_INTERNAL_SECRET) {
    throw new Error("SDR_LAUNCH_INTERNAL_URL and SDR_LAUNCH_INTERNAL_SECRET must be set to reach GTMOS");
  }

  console.log(`EmailBison workspace bootstrap — ${execute ? "EXECUTE (writing)" : "DRY-RUN (no writes)"}\n`);

  // GTMOS uuid -> slug, for the primary mapping path.
  const roster = await fetchClients();
  const gtmosIdToSlug = new Map<string, string>();
  for (const c of roster) gtmosIdToSlug.set(c.id, c.slug);

  const workspaces = await listWorkspaceKeys();
  console.log(`GTMOS returned ${workspaces.length} client-mapped workspace(s).\n`);

  let upserted = 0;
  const unmatched: string[] = [];
  const skippedSlug: string[] = [];

  for (const ws of workspaces) {
    // 1) primary: GTMOS uuid -> slug -> local client
    let slug = gtmosIdToSlug.get(ws.clientId) ?? null;
    let local = slug ? await clientService.getByExternalId(slug) : null;

    // 2) fallback: case-insensitive workspace-name -> local client name
    if (!local && ws.workspaceName) {
      local = await prisma.client.findFirst({
        where: { name: { equals: ws.workspaceName, mode: "insensitive" } },
      });
      if (local) slug = local.external_id;
    }

    if (!local) {
      unmatched.push(`ws ${ws.workspaceId} "${ws.workspaceName ?? "?"}" (gtmos client ${ws.clientId})`);
      console.log(`  ✗ ws ${ws.workspaceId} "${ws.workspaceName ?? "?"}" — no local client match; skipped`);
      continue;
    }

    if (onlySlug && local.external_id !== onlySlug) continue;

    console.log(`  ● ${local.external_id.padEnd(20)} → ws ${ws.workspaceId} "${ws.workspaceName ?? ""}"`);
    if (execute) {
      await prisma.emailbisonWorkspace.upsert({
        where: { client_id_workspace_id: { client_id: local.id, workspace_id: ws.workspaceId } },
        update: { workspace_name: ws.workspaceName ?? null, active: true },
        create: {
          client_id: local.id,
          workspace_id: ws.workspaceId,
          workspace_name: ws.workspaceName ?? null,
          active: true,
        },
      });
      upserted++;
    }
  }

  console.log(
    `\nDone: ${execute ? `${upserted} workspace(s) upserted` : "DRY-RUN (nothing written) — re-run with --execute"}.`
  );
  if (skippedSlug.length) console.log(`Filtered out by slug filter: ${skippedSlug.length}`);
  if (unmatched.length) {
    console.log(`⚠ ${unmatched.length} workspace(s) had no local client (run dnc:bootstrap first?):`);
    for (const u of unmatched) console.log(`   - ${u}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("emailbison:bootstrap failed:", err?.message || err);
  process.exit(1);
});
