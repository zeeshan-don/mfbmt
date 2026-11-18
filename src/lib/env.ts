import "./load-env";
import { z } from "zod";

/**
 * Central environment access. Server-only. Values are validated once; optional
 * integrations report themselves as unconfigured rather than crashing the app.
 *
 * Production is fail-closed: insecure defaults, demo mode, a SQLite URL or a
 * missing encryption key stop the server from starting instead of silently
 * running in an unsafe configuration.
 */
const schema = z.object({
  DATABASE_URL: z.string().default(""),
  APP_URL: z.string().default("http://localhost:3000"),
  AUTH_SECRET: z.string().default("insecure-development-secret-change-me"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().default(""),
  NODE_ENV: z.string().default("development"),
  WORKER_POLL_MS: z.coerce.number().default(3000),
  WORKER_SECRET: z.string().default(""),
  WORKER_STALE_MS: z.coerce.number().default(120_000),
  WORKER_HEARTBEAT_MS: z.coerce.number().default(20_000),
  BUSINESS_TIMEZONE: z.string().default("Asia/Dubai"),
  DEMO_MODE: z.string().default("false"),
  SEED_DEMO_DATA: z.string().default("false"),

  AI_PROVIDER: z.string().default("none"),
  AI_API_KEY: z.string().default(""),
  AI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().default("gpt-4o-mini"),
  AI_VISION_MODEL: z.string().default(""),
  /** Send messages from unknown senders to the AI provider. Off by default. */
  AI_FOR_UNKNOWN_SENDERS: z.string().default("false"),

  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().default(""),
  META_EMBEDDED_SIGNUP_CONFIG_ID_COEXISTENCE: z.string().default(""),
  META_GRAPH_API_VERSION: z.string().default("v23.0"),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  /** Legacy static credentials. Embedded Signup stores per-account credentials instead. */
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(""),

  EMAIL_INTAKE_PROVIDER: z.string().default("none"),
  EMAIL_AUTO_SYNC: z.string().default("true"),
  EMAIL_POLL_INTERVAL_MS: z.coerce.number().default(120_000),
  EMAIL_MAX_MESSAGES_PER_RUN: z.coerce.number().default(100),
  GMAIL_CLIENT_ID: z.string().default(""),
  GMAIL_CLIENT_SECRET: z.string().default(""),
  GMAIL_REDIRECT_URI: z.string().default(""),
  GMAIL_PUBSUB_TOPIC: z.string().default(""),
  GMAIL_PUBSUB_VERIFICATION_TOKEN: z.string().default(""),
  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_TENANT_ID: z.string().default("common"),
  MICROSOFT_REDIRECT_URI: z.string().default(""),
  GRAPH_WEBHOOK_CLIENT_STATE: z.string().default(""),
  GRAPH_SUBSCRIPTION_MINUTES: z.coerce.number().default(4200),
  INBOUND_EMAIL_SECRET: z.string().default(""),
  COMPANY_EMAIL_FROM: z.string().default(""),
  EMAIL_FILTER: z.string().default(""),
  EMAIL_FOLDER: z.string().default("inbox"),

  WEB_SEARCH_PROVIDER: z.string().default("none"),
  TAVILY_API_KEY: z.string().default(""),
  SERPER_API_KEY: z.string().default(""),
  BRAVE_SEARCH_API_KEY: z.string().default(""),
  SEARCH_MAX_RESULTS: z.coerce.number().default(8),
  SEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().default(15000),
  SEARCH_MAX_QUERIES: z.coerce.number().default(4),
  SEARCH_PAGE_FETCH_LIMIT: z.coerce.number().default(5),

  OCR_PROVIDER: z.string().default("auto"),
  OCR_LANGUAGES: z.string().default("eng"),
  OCR_PDF_MAX_PAGES: z.coerce.number().default(10),

  EXCHANGE_RATE_PROVIDER: z.string().default("none"),
  EXCHANGE_RATE_API_KEY: z.string().default(""),
  FIXED_USD_AED: z.coerce.number().default(3.6725),

  STORAGE_DRIVER: z.string().default("local"),
  STORAGE_ROOT: z.string().default("./storage"),
  S3_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default(""),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.string().default("false"),

  MAX_UPLOAD_MB: z.coerce.number().default(15),
  UPLOAD_LINK_TTL_MINUTES: z.coerce.number().default(10),
  AUTH_SESSION_DAYS: z.coerce.number().default(7),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const env = parsed.data;

export const isDemoMode = env.DEMO_MODE === "true";
export const isProd = env.NODE_ENV === "production";

const INSECURE_SECRETS = new Set([
  "insecure-development-secret-change-me",
  "replace-with-64-hex-characters",
  "changeme",
  "secret",
  "test-secret-value-not-for-production",
]);

export type ConfigProblem = { variable: string; problem: string };

/**
 * Problems that make a production deployment unsafe. An empty list means the
 * deployment may start. Development returns [] so local work is never blocked.
 */
export function productionConfigProblems(input: typeof env = env): ConfigProblem[] {
  if (input.NODE_ENV !== "production") return [];
  const problems: ConfigProblem[] = [];

  if (!input.DATABASE_URL) {
    problems.push({ variable: "DATABASE_URL", problem: "is required (a PostgreSQL connection string)." });
  } else if (!/^postgres(ql)?:\/\//i.test(input.DATABASE_URL)) {
    problems.push({
      variable: "DATABASE_URL",
      problem: "must be a PostgreSQL URL. SQLite files are not supported in production.",
    });
  }

  const authSecret = input.AUTH_SECRET ?? "";
  if (authSecret.length < 32 || INSECURE_SECRETS.has(authSecret)) {
    problems.push({
      variable: "AUTH_SECRET",
      problem: "must be at least 32 random characters and must not be a default example value.",
    });
  }

  const encryptionKey = input.CREDENTIAL_ENCRYPTION_KEY ?? "";
  if (encryptionKey.length < 32 || INSECURE_SECRETS.has(encryptionKey)) {
    problems.push({
      variable: "CREDENTIAL_ENCRYPTION_KEY",
      problem:
        "must be a separate secret of at least 32 random characters. Integration credentials are not encrypted with AUTH_SECRET in production.",
    });
  } else if (encryptionKey === authSecret) {
    problems.push({
      variable: "CREDENTIAL_ENCRYPTION_KEY",
      problem: "must be different from AUTH_SECRET so rotating one does not break the other.",
    });
  }

  if (input.DEMO_MODE === "true") {
    problems.push({ variable: "DEMO_MODE", problem: "must be false in production." });
  }
  if (input.SEED_DEMO_DATA === "true") {
    problems.push({ variable: "SEED_DEMO_DATA", problem: "must be false in production." });
  }
  if (!/^https:\/\//i.test(input.APP_URL)) {
    problems.push({ variable: "APP_URL", problem: "must be the public https URL used in links and OAuth callbacks." });
  }
  if (input.STORAGE_DRIVER === "s3") {
    for (const name of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!input[name]) {
        problems.push({ variable: name, problem: "is required when STORAGE_DRIVER=s3." });
      }
    }
  }
  return problems;
}

export function assertProductionConfig(): void {
  const problems = productionConfigProblems();
  if (problems.length === 0) return;
  throw new Error(
    `Refusing to start in production with an unsafe configuration:\n${problems
      .map((p) => `  - ${p.variable} ${p.problem}`)
      .join("\n")}`,
  );
}

// NOTE: the assertion is intentionally NOT run at module import time. Next.js
// sets NODE_ENV=production while collecting page data during `next build`, so a
// top-level throw would make production builds impossible on a machine that
// builds with development credentials. The check runs when a server or worker
// actually starts: see src/instrumentation.ts and src/worker.ts.

export function requireSecret(name: keyof typeof env): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Integration not configured: ${String(name)} is empty. Add it to .env before using this feature.`,
    );
  }
  return value;
}

/** Credentials needed to run Meta's Embedded Signup (app-level, not per account). */
export function whatsAppSignupConfig() {
  const missing: string[] = [];
  if (!env.META_APP_ID) missing.push("META_APP_ID");
  if (!env.META_APP_SECRET) missing.push("META_APP_SECRET");
  if (!env.META_EMBEDDED_SIGNUP_CONFIG_ID) missing.push("META_EMBEDDED_SIGNUP_CONFIG_ID");
  if (!env.WHATSAPP_VERIFY_TOKEN) missing.push("WHATSAPP_VERIFY_TOKEN");
  return { configured: missing.length === 0, missing };
}

export const integrationEnv = {
  /** App-level configuration only. A stored per-account connection is required too. */
  whatsappSignup: () => whatsAppSignupConfig(),
  ai: () => env.AI_PROVIDER !== "none" && env.AI_API_KEY.length > 0,
  webSearch: () =>
    env.WEB_SEARCH_PROVIDER !== "none" &&
    ((env.WEB_SEARCH_PROVIDER === "tavily" && Boolean(env.TAVILY_API_KEY)) ||
      (env.WEB_SEARCH_PROVIDER === "serper" && Boolean(env.SERPER_API_KEY)) ||
      (env.WEB_SEARCH_PROVIDER === "brave" && Boolean(env.BRAVE_SEARCH_API_KEY))),
  gmail: () => Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET),
  microsoft: () => Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  exchangeRate: () => env.EXCHANGE_RATE_PROVIDER !== "none",
  s3: () => env.STORAGE_DRIVER === "s3" && Boolean(env.S3_BUCKET),
  gmailPush: () => Boolean(env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUBSUB_VERIFICATION_TOKEN),
  graphPush: () => Boolean(env.GRAPH_WEBHOOK_CLIENT_STATE),
};
