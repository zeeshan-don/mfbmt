import { describe, expect, it } from "vitest";
import { demoSeedProblem } from "../src/lib/demo-guard";

const POSTGRES = "postgresql://user:pass@host:5432/db";
const valid = {
  NODE_ENV: "development",
  DEMO_MODE: "true",
  SEED_DEMO_DATA: "true",
  DATABASE_URL: POSTGRES,
};

describe("demo seed guard", () => {
  it("allows an explicit opt-in outside production", () => {
    expect(demoSeedProblem(valid)).toBeNull();
  });

  it("fails closed when either opt-in is missing or unset", () => {
    expect(demoSeedProblem({ ...valid, DEMO_MODE: undefined })).toMatch(/DEMO_MODE/);
    expect(demoSeedProblem({ ...valid, SEED_DEMO_DATA: undefined })).toMatch(/DEMO_MODE/);
    expect(demoSeedProblem({ ...valid, DEMO_MODE: "false" })).toMatch(/DEMO_MODE/);
  });

  it("always rejects production even when every flag is true", () => {
    expect(demoSeedProblem({ ...valid, NODE_ENV: "production" })).toMatch(/production/i);
    expect(demoSeedProblem({ ...valid, VERCEL_ENV: "production" })).toMatch(/production/i);
    expect(demoSeedProblem({ ...valid, APP_ENV: "production" })).toMatch(/production/i);
  });

  it("requires the PostgreSQL demo database", () => {
    expect(demoSeedProblem({ ...valid, DATABASE_URL: "file:./dev.db" })).toMatch(/PostgreSQL/);
    expect(demoSeedProblem({ ...valid, DATABASE_URL: undefined })).toMatch(/PostgreSQL/);
  });
});
