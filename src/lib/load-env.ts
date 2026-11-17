/**
 * Node scripts (worker, seed, tests) are not started by Next.js, so .env is
 * loaded explicitly. Existing process.env values always win.
 */
if (!process.env.DATABASE_URL) {
  try {
    const loadEnvFile = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
    if (typeof loadEnvFile === "function") loadEnvFile();
  } catch {
    // Missing .env: validateConfig below will surface real configuration problems.
  }
}
