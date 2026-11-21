import Link from "next/link";
import { Button, Notice, inputClass } from "@/components/ui";
import { verifyMfaAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Two-factor verification</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Enter your authenticator code</h1>
        <p className="mt-2 text-sm text-muted">
          This account requires a second factor. The six-digit code changes every 30 seconds; a recovery code also works once.
        </p>
        <form action={verifyMfaAction} className="panel mt-5 space-y-4 p-5 shadow-panel">
          {error ? <Notice tone="danger" title="Could not verify">{error}</Notice> : null}
          <input type="hidden" name="token" value={token ?? ""} />
          <div>
            <label htmlFor="code" className="mb-1 block text-xs font-medium text-soft">
              Authenticator or recovery code
            </label>
            <input
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              className={inputClass}
              placeholder="123456"
            />
          </div>
          <Button variant="primary" className="w-full" disabled={!token}>
            Verify and sign in
          </Button>
          {!token ? <Notice tone="warn" title="Challenge missing">Sign in again to receive a new challenge.</Notice> : null}
        </form>
        <p className="mt-4 text-center text-xs text-muted">
          <Link href="/login" className="text-accent hover:underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
