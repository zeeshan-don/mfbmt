import "./load-env";
import { z } from "zod";

/**
 * Central environment access. Server-only. Values are validated once and
 * optional integrations report themselves as unconfigured rather than crashing
 * the application.
 */
const schema = z.object({
  DATABASE_URL: z.string().default("file:./dev.db"),
  APP_URL: z.string().default("http://localhost:3000"),
  AUTH_SECRET: z.string().min(16).default("insecure-development-secret-change-me"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().default(""),
  NODE_ENV: z.string().default("development"),
  WORKER_POLL_MS: z.coerce.number().default(3000),
  WORKER_SECRET: z.string().default(""),
  BUSINESS_TIMEZONE: z.string().default("Asia/Dubai"),
  DEMO_MODE: z.string().default("false"),
  SEED_DEMO_DATA: z.string().default("false"),

  AI_PROVIDER: z.string().default("none"),
  AI_API_KEY: z.string().default(""),
  AI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  AI_MODEL: z.string().default("gpt-4o-mini"),
  AI_VISION_MODEL: z.string().default(""),

  META_APP_SECRET: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  META_GRAPH_API_VERSION: z.string().default("v21.0"),

  EMAIL_INTAKE_PROVIDER: z.string().default("none"),
  GMAIL_CLIENT_ID: z.string().default(""),
  GMAIL_CLIENT_SECRET: z.string().default(""),
  GMAIL_REDIRECT_URI: z.string().default(""),
  MICROSOFT_CLIENT_ID: z.string().default(""),
  MICROSOFT_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_TENANT_ID: z.string().default("common"),
  MICROSOFT_REDIRECT_URI: z.string().default(""),
  INBOUND_EMAIL_SECRET: z.string().default(""),
  COMPANY_EMAIL_FROM: z.string().default(""),
  EMAIL_FILTER: z.string().default("is:unread newer_than:2d"),
  EMAIL_FOLDER: z.string().default("inbox"),

  WEB_SEARCH_PROVIDER: z.string().default("none"),
  TAVILY_API_KEY: z.string().default(""),
  SERPER_API_KEY: z.string().default(""),
  BRAVE_SEARCH_API_KEY: z.string().default(""),
  SEARCH_MAX_RESULTS: z.coerce.number().default(8),
  SEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().default(15000),

  OCR_PROVIDER: z.string().default("auto"),
  EXCHANGE_RATE_PROVIDER: z.string().default("none"),
  EXCHANGE_RATE_API_KEY: z.string().default(""),
  FIXED_USD_AED: z.coerce.number().default(3.6725),
  STORAGE_ROOT: z.string().default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().default(15),
  UPLOAD_LINK_TTL_MINUTES: z.coerce.number().default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

export const env = parsed.data;

export const isDemoMode = env.DEMO_MODE === "true";
export const isProd = env.NODE_ENV === "production";

export function requireSecret(name: keyof typeof env): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Integration not configured: ${String(name)} is empty. Add it to .env before using this feature.`,
    );
  }
  return value;
}

export const integrationEnv = {
  whatsapp: () =>
    Boolean(
      env.META_APP_SECRET &&
        env.WHATSAPP_ACCESS_TOKEN &&
        env.WHATSAPP_PHONE_NUMBER_ID &&
        env.WHATSAPP_VERIFY_TOKEN,
    ),
  ai: () => env.AI_PROVIDER !== "none" && env.AI_API_KEY.length > 0,
  webSearch: () =>
    env.WEB_SEARCH_PROVIDER !== "none" &&
    ((env.WEB_SEARCH_PROVIDER === "tavily" && env.TAVILY_API_KEY) ||
      (env.WEB_SEARCH_PROVIDER === "serper" && env.SERPER_API_KEY) ||
      (env.WEB_SEARCH_PROVIDER === "brave" && env.BRAVE_SEARCH_API_KEY)),
  gmail: () => Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET),
  microsoft: () => Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),
  exchangeRate: () => env.EXCHANGE_RATE_PROVIDER !== "none",
};
