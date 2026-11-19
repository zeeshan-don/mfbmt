import "../lib/load-env";
import {
  parseDatabaseTarget,
  productionDatabaseHosts,
  stagingDatabaseProblem,
} from "../lib/db-target";

/**
 * Fail-closed guard for `prisma migrate deploy` against staging.
 *
 * It never connects to the database and never prints credentials. It exists so
 * a Preview/staging migration cannot target the production Neon endpoint, even
 * if DATABASE_URL is copy-pasted from Production.
 */
const raw = process.env.DATABASE_URL ?? "";
const problem = stagingDatabaseProblem(raw);

if (problem) {
  console.error("Refusing staging database operation.");
  console.error(`  ${problem}`);
  console.error(`  Known production hosts: ${productionDatabaseHosts().join(", ")}`);
  process.exit(1);
}

const target = parseDatabaseTarget(raw);
if (!target) {
  // stagingDatabaseProblem already rejects this, but keep the type narrow.
  console.error("Refusing staging database operation: unparseable DATABASE_URL.");
  process.exit(1);
}

console.log(`Staging database verified: host=${target.host} database=${target.database}.`);
console.log("Credentials were not printed.");
