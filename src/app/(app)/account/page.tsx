import { requireUser } from "@/lib/auth";
import { cookies } from "next/headers";
import { Button, Card, CardHeader, Notice, PageHeader, inputClass } from "@/components/ui";
import {
  changePasswordAction,
  clearMfaRecoveryAction,
  confirmMfaAction,
  disableMfaAction,
  startMfaAction,
} from "@/app/actions/account";
import { MIN_PASSWORD_LENGTH } from "@/lib/account";
import { decryptSecret } from "@/lib/crypto";
import { mfaStatus } from "@/lib/mfa";

export const dynamic = "force-dynamic";

function readJsonCookie(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(decryptSecret(value));
  } catch {
    return null;
  }
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; mfa?: string; first?: string }>;
}) {
  const user = await requireUser();
  const flags = await searchParams;
  const status = await mfaStatus(user.id);
  const store = await cookies();
  const enrollment = readJsonCookie(store.get("mfbmt_mfa_enroll")?.value) as
    | { secret?: string; uri?: string }
    | null;
  const recoveryCodes = readJsonCookie(store.get("mfbmt_mfa_recovery")?.value) as string[] | null;

  return (
    <div className="space-y-6">
      <PageHeader title="Your account" description="Change your password, review access and protect sign-in with an authenticator." />

      {flags.saved ? <Notice tone="ok">Password changed. Other sessions were signed out.</Notice> : null}
      {flags.error ? <Notice tone="danger" title="Could not update your account">{flags.error}</Notice> : null}
      {flags.first ? <Notice tone="warn" title="Set a new password">Your initial password must be changed before you continue.</Notice> : null}
      {flags.mfa === "enabled" ? <Notice tone="ok" title="Two-factor authentication enabled">Save the recovery codes shown below. They are not shown again after this page expires.</Notice> : null}
      {flags.mfa === "disabled" ? <Notice tone="ok">Two-factor authentication has been disabled for this account.</Notice> : null}

      <Card>
        <CardHeader title="Account" />
        <div className="grid gap-2 px-4 py-3 text-xs text-soft sm:grid-cols-2">
          <p><span className="text-muted">Name:</span> {user.name}</p>
          <p><span className="text-muted">Email:</span> {user.email}</p>
          <p><span className="text-muted">Role:</span> {user.role === "OWNER" ? "Owner" : "Staff"}</p>
          <p><span className="text-muted">Two-factor:</span> {status.enabled ? "Enabled" : "Not enabled"}</p>
        </div>
      </Card>

      {recoveryCodes?.length ? (
        <Card>
          <CardHeader title="Recovery codes" description="Each code works once. Store them in a password manager or safe; do not email them." />
          <div className="px-4 py-4">
            <div className="grid gap-2 rounded-card border border-line bg-bg p-3 font-mono text-sm text-ink sm:grid-cols-2">
              {recoveryCodes.map((code) => <span key={code}>{code}</span>)}
            </div>
            <form action={clearMfaRecoveryAction} className="mt-3">
              <Button size="sm">I have saved the codes</Button>
            </form>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Two-factor authentication"
          description="Use any TOTP authenticator app. A six-digit code is required after your password."
        />
        <div className="space-y-4 px-4 py-4">
          {status.enabled ? (
            <form action={disableMfaAction} className="flex flex-wrap items-end gap-2">
              <label className="block text-xs text-soft">
                Current password
                <input name="password" type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} />
              </label>
              <Button size="sm" variant="danger">Disable two-factor</Button>
            </form>
          ) : enrollment ? (
            <div className="space-y-3">
              <p className="text-sm text-soft">Add this secret to your authenticator app, then enter the current six-digit code.</p>
              <div className="rounded-card border border-line bg-bg p-3 text-xs text-soft">
                <p><span className="text-muted">Secret:</span> <code className="break-all text-ink">{enrollment.secret}</code></p>
                {enrollment.uri ? <p className="mt-2 break-all"><span className="text-muted">Setup URI:</span> <code className="text-ink">{enrollment.uri}</code></p> : null}
              </div>
              <form action={confirmMfaAction} className="flex flex-wrap items-end gap-2">
                <label className="block text-xs text-soft">
                  Current code
                  <input name="code" inputMode="numeric" autoComplete="one-time-code" required className={`${inputClass} mt-1`} placeholder="123456" />
                </label>
                <Button size="sm" variant="primary">Enable two-factor</Button>
              </form>
            </div>
          ) : (
            <form action={startMfaAction} className="flex flex-wrap items-end gap-2">
              <label className="block text-xs text-soft">
                Current password
                <input name="password" type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} />
              </label>
              <Button size="sm" variant="primary">Set up two-factor</Button>
            </form>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Change password" description={`At least ${MIN_PASSWORD_LENGTH} characters, with letters and numbers.`} />
        <form action={changePasswordAction} className="grid gap-3 px-4 py-4 sm:grid-cols-3">
          <label className="block text-xs text-soft">
            Current password
            <input name="currentPassword" type="password" required autoComplete="current-password" className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-xs text-soft">
            New password
            <input name="newPassword" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-xs text-soft">
            Confirm new password
            <input name="confirmPassword" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={`${inputClass} mt-1`} />
          </label>
          <div className="sm:col-span-3">
            <Button size="sm" variant="primary">Change password</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
