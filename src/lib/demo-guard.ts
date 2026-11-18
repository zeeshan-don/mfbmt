/**
 * Demo seeding is fail-closed.
 *
 * Production is rejected regardless of any other flag, and non-production
 * requires BOTH explicit opt-ins. An unset value is not permission.
 */
export type DemoSeedEnvironment = {
  NODE_ENV?: string;
  APP_ENV?: string;
  VERCEL_ENV?: string;
  DEMO_MODE?: string;
  SEED_DEMO_DATA?: string;
  DATABASE_URL?: string;
};

export function demoSeedProblem(input: DemoSeedEnvironment): string | null {
  if (
    input.NODE_ENV === "production" ||
    input.APP_ENV === "production" ||
    input.VERCEL_ENV === "production"
  ) {
    return "Refusing to seed demo data in production. Use npm run provision:owner instead.";
  }
  if (input.DEMO_MODE !== "true" || input.SEED_DEMO_DATA !== "true") {
    return "Demo seeding requires DEMO_MODE=true and SEED_DEMO_DATA=true. This database was not touched.";
  }
  if (!/^postgres(ql)?:\/\//i.test(input.DATABASE_URL ?? "")) {
    return "Demo seeding requires the PostgreSQL DATABASE_URL for the demo environment.";
  }
  return null;
}
