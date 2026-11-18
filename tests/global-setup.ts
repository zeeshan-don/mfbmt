import { execSync } from "node:child_process";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/mfbmt_test?schema=public";

/**
 * Prepares the isolated PostgreSQL test database.
 *
 * It is a dedicated database (mfbmt_test), never the development or production
 * database. The URL is checked before anything destructive runs, so a
 * misconfigured TEST_DATABASE_URL can never reset real data.
 */
export default function setup() {
  const url = TEST_DATABASE_URL;
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error("TEST_DATABASE_URL must be a PostgreSQL connection string for the isolated test database.");
  }
  if (/\/mfbmt_dev(\?|$)/.test(url) || /prod/i.test(url)) {
    throw new Error("Refusing to run tests against a development or production database. Use a dedicated test database.");
  }

  execSync("npx prisma migrate deploy", {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test" },
  });

  console.log("[tests] PostgreSQL test database ready (migrations applied).");
}
