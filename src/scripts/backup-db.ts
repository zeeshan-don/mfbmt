import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { assertIsolatedDatabaseUrl } from "./safety";

const raw = (process.env.BACKUP_DATABASE_URL ?? "").trim();
if (!raw) {
  console.error("BACKUP_DATABASE_URL is required. Point it at the isolated test database, never production.");
  process.exit(1);
}

let guarded: { url: string; database: string };
try {
  guarded = assertIsolatedDatabaseUrl(raw, "backup-db");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const outDir = path.resolve(process.cwd(), "backups");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(outDir, `mfbmt-${guarded.database}-${stamp}.dump`);
const result = spawnSync(process.env.PG_DUMP_BIN || "pg_dump", ["-d", guarded.url, "-Fc", "-f", outFile], {
  stdio: "inherit",
});
if (result.error) {
  console.error(`pg_dump could not start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`pg_dump failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}
console.log(`Backup written to ${outFile} (credentials were not printed).`);
