import Link from "next/link";
import { invitationPreview } from "@/lib/onboarding/invite";
import { MIN_PASSWORD_LENGTH } from "@/lib/account";
import { Button, Notice, inputClass } from "@/components/ui";
import { acceptInviteAction } from "@/app/actions/invite";

export const dynamic = "force-dynamic";

/**
 * One-time owner invitation acceptance. The token is a capability: it is looked
 * up by its hash, expires, and can be used once. The invitee chooses their own
 * password; no initial password is ever generated or shown.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const flags = await searchParams;
  const token = flags.token ?? "";
  const preview = token ? await invitationPreview(token) : null;
  const expired = preview ? preview.expiresAt.getTime() < Date.now() : false;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
          {preview?.organizationName ?? "Procurement"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Set up your owner account</h1>

        {flags.error ? (
          <div className="mt-4">
            <Notice tone="danger" title="Could not accept the invitation">
              {flags.error}
            </Notice>
          </div>
        ) : null}

        {!preview ? (
          <div className="mt-4 space-y-3">
            <Notice tone="danger" title="This invitation link is not valid">
              Ask your platform administrator for a new owner invitation.
            </Notice>
            <Link href="/login" className="text-xs text-accent hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : preview.used ? (
          <div className="mt-4 space-y-3">
            <Notice tone="warn" title="This invitation was already used">
              Sign in with the password you chose, or use the password-reset link if you need a new one.
            </Notice>
            <Link href="/login" className="text-xs text-accent hover:underline">
              Back to sign in
            </Link>
          </div>
        ) : expired ? (
          <Notice tone="warn" title="This invitation has expired">
            Ask your platform administrator for a new owner invitation.
          </Notice>
        ) : (
          <form action={acceptInviteAction} className="panel mt-4 space-y-4 p-5 shadow-panel">
            <input type="hidden" name="token" value={token} />
            <div className="rounded-control border border-line bg-elevated/40 px-3 py-2 text-xs text-soft">
              Invitation for <span className="font-medium text-ink">{preview.email}</span> in{" "}
              <span className="font-medium text-ink">{preview.organizationName}</span>.
              <span className="mt-1 block text-[11px] text-muted">
                This link is single use and expires {preview.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC.
              </span>
            </div>
            <label className="block text-xs font-medium text-soft">
              Your name
              <input name="name" defaultValue={preview.name} required minLength={2} className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs font-medium text-soft">
              Choose a password
              <input
                name="password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                className={`${inputClass} mt-1`}
              />
            </label>
            <label className="block text-xs font-medium text-soft">
              Confirm password
              <input
                name="confirmPassword"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                className={`${inputClass} mt-1`}
              />
            </label>
            <p className="text-[11px] text-muted">
              Use at least {MIN_PASSWORD_LENGTH} characters with letters and numbers. The owner account can approve
              supplier requests and customer quotations, so keep this password private.
            </p>
            <Button variant="primary" className="w-full">
              Create owner account
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
