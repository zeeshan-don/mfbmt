import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const url = (process.env.BACKUP_DATABASE_URL ?? "").trim();
if (!url) {
  console.error("BACKUP_DATABASE_URL is required. Never point this at production without an explicit, separate backup URL.");
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//i.test(url)) {
  console.error("BACKUP_DATABASE_URL must be a PostgreSQL URL.");
  process.exit(1);
}
const outDir = path.resolve(process.cwd(), "backups");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(outDir, `mfbmt-${stamp}.dump`);
const result = spawnSync("pg_dump", ["-d", url, "-Fc", "-f", outFile], { stdio: "inherit" });
if (result.status !== 0) {
  console.error(`pg_dump failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}
console.log(`Backup written to ${outFile}`);