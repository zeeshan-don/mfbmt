/**
 * Runs once when a Next.js server starts (not during `next build`).
 *
 * Production must refuse to start with demo mode, a SQLite URL, an insecure
 * AUTH_SECRET or a missing/duplicated CREDENTIAL_ENCRYPTION_KEY. Doing this here
 * keeps `next build` usable in CI while still failing closed at runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRuntimeConfig } = await import("./lib/env");
  assertRuntimeConfig();
}
