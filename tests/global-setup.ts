import { execSync } from "node:child_process";
import path from "node:path";

/**
 * Creates an isolated SQLite database for the tests. It is completely separate
 * from the development database, so tests never see or change real records.
 */
export default function setup() {
  const root = process.cwd();
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: "file:./test.db",
      NODE_ENV: "test",
    },
  });
  console.log(`[tests] prepared SQLite test database at ${path.join(root, "prisma", "test.db")}`);
}
