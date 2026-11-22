import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { assertIsolatedDatabaseUrl } from "./safety";

/**
 * Restores a dump into an explicitly isolated, empty database.
 *
 * Usage:
 *   RESTORE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_restore \
 *   BACKUP_FILE=backups/mfbmt-mfbmt_test-....dump npm run restore:db
 */
const raw = (process.env.RESTORE_DATABASE_URL ?? "").trim();
const file = (process.env.BACKUP_FILE ?? "").trim();
if (!raw || !file) {
  console.error("RESTORE_DATABASE_URL and BACKUP_FILE are required. Never point this at production.");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`Backup file not found: ${file}`);
  process.exit(1);
}

let guarded: { url: string; database: string };
try {
  guarded = assertIsolatedDatabaseUrl(raw, "restore-db");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = spawnSync(
  process.env.PG_RESTORE_BIN || "pg_restore",
  ["--clean", "--if-exists", "--no-owner", "--no-acl", "-d", guarded.url, file],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(`pg_restore could not start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`pg_restore failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}
console.log(`Restore completed into ${guarded.database} from ${file}. Verify counts before using it.`);
