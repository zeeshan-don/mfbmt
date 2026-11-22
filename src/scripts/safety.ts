/**
 * Guard for destructive or data-copying maintenance scripts.
 *
 * A URL is accepted only when it points at localhost and its database name
 * clearly identifies a disposable/test environment. Production is always
 * refused, even if the hostname happens to be local (for example a tunnel).
 */
export function assertIsolatedDatabaseUrl(raw: string, action: string): { url: string; database: string } {
  if (!raw.trim()) throw new Error(`${action}: a database URL is required.`);
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${action}: refusing to run with NODE_ENV=production.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${action}: the database URL is not a valid URL.`);
  }
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    throw new Error(`${action}: only PostgreSQL URLs are supported.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`${action}: refusing a non-local database host (${host}).`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(?:^|_)(test|attack|e2e|stress|restore|backup)(?:$|_)/i.test(database)) {
    throw new Error(
      `${action}: refusing database "${database}". Its name must contain a disposable marker such as _test, _attack, _e2e, _stress, _restore or _backup.`,
    );
  }
  if (/prod|production|live/i.test(database)) {
    throw new Error(`${action}: refusing a database whose name looks like production.`);
  }
  return { url: raw, database };
}

export function scriptDatabaseUrl(): string {
  const url = (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "").trim();
  if (!url) throw new Error("Set TEST_DATABASE_URL (preferred) or DATABASE_URL to the isolated test database.");
  return url;
}
