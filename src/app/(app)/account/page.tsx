import { requireUser } from "@/lib/auth";
import { Button, Card, CardHeader, Notice, PageHeader, inputClass } from "@/components/ui";
import { changePasswordAction } from "@/app/actions/account";
import { MIN_PASSWORD_LENGTH } from "@/lib/account";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await requireUser();
  const flags = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader title="Your account" description="Change your password and review your access." />

      {flags.saved ? <Notice tone="ok">Password changed. Other sessions were signed out.</Notice> : null}
      {flags.error ? <Notice tone="danger" title="Could not change the password">{flags.error}</Notice> : null}

      <Card>
        <CardHeader title="Account" />
        <div className="grid gap-2 px-4 py-3 text-xs text-soft sm:grid-cols-2">
          <p><span className="text-muted">Name:</span> {user.name}</p>
          <p><span className="text-muted">Email:</span> {user.email}</p>
          <p><span className="text-muted">Role:</span> {user.role === "OWNER" ? "Owner" : "Staff"}</p>
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
