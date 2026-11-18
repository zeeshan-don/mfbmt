import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve(process.cwd(), "tests/server-only-stub.ts"),
      // Matches the tsconfig path alias so route handlers and server actions can
      // be imported directly by the end-to-end tests.
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
