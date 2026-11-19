/**
 * Database-target helpers shared by the runtime and the staging migration guard.
 *
 * These helpers never log, return or format a connection string: passwords and
 * query parameters must stay out of logs. Only the host and database name are
 * ever surfaced, because those are needed to prove which branch is targeted.
 */

const DEFAULT_PRODUCTION_HOSTS = [
  "ep-royal-recipe-bag133h2-pooler.c-8.eu-central-1.aws.neon.tech",
  "ep-royal-recipe-bag133h2.c-8.eu-central-1.aws.neon.tech",
];

export type DatabaseTarget = {
  host: string;
  database: string;
};

export function productionDatabaseHosts(): string[] {
  const configured = (process.env.PRODUCTION_DATABASE_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const hosts = configured.length > 0 ? configured : DEFAULT_PRODUCTION_HOSTS;

  // A Neon branch has pooled and unpooled endpoints with different hostnames.
  // Deny both forms even if only one was configured.
  return Array.from(
    new Set(hosts.flatMap((host) => [host, host.replace("-pooler", "")])),
  );
}

export function parseDatabaseTarget(raw: string): DatabaseTarget | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!url.hostname || !database) return null;
    return {
      host: url.hostname.toLowerCase(),
      database,
    };
  } catch {
    return null;
  }
}

/**
 * A staging target is valid only when:
 *   * it is a PostgreSQL URL;
 *   * its host is not any configured production host;
 *   * its host exactly matches STAGING_DATABASE_HOST, the explicitly configured
 *     staging branch endpoint.
 *
 * STAGING_DATABASE_HOST is intentionally non-secret. It prevents a copied
 * Preview DATABASE_URL from silently reverting to the production endpoint.
 */
export function stagingDatabaseProblem(raw: string): string | null {
  const target = parseDatabaseTarget(raw);
  if (!target) return "DATABASE_URL is not a valid PostgreSQL connection string.";

  if (productionDatabaseHosts().includes(target.host)) {
    return `DATABASE_URL points at the production host ${target.host}.`;
  }

  const expectedHost = (process.env.STAGING_DATABASE_HOST ?? "").trim().toLowerCase();
  if (!expectedHost) {
    return "STAGING_DATABASE_HOST is not set, so the staging target cannot be verified.";
  }
  if (target.host !== expectedHost) {
    return `DATABASE_URL host ${target.host} does not match STAGING_DATABASE_HOST ${expectedHost}.`;
  }

  return null;
}
