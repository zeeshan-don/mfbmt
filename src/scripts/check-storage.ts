import { storageDriver, storageReadiness, testStorage } from "../lib/storage";

/**
 * Real storage round trip. Never prints credentials or object contents.
 * Run: npm run check:storage
 */
async function main() {
  const readiness = storageReadiness();
  console.log(`driver: ${storageDriver}`);
  console.log(`readiness: ${readiness.ok ? "ok" : "blocked"} (${readiness.mode})`);
  if (!readiness.ok) {
    console.error(`storage check FAILED: ${readiness.detail}`);
    process.exitCode = 1;
    return;
  }
  const result = await testStorage();
  console.log(`round trip: ${result.ok ? "PASS" : "FAIL"} — ${result.detail}`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error("storage check FAILED:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
