import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { Button, Notice, inputClass } from "@/components/ui";
import { resetPasswordAction } from "@/app/actions/account";
import { MIN_PASSWORD_LENGTH } from "@/lib/account";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");
  const flags = await searchParams;
  const token = flags.token ?? "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">Procurement</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Choose a new password</h1>

        {flags.error ? (
          <div className="mt-4">
            <Notice tone="danger" title="Could not reset the password">{flags.error}</Notice>
          </div>
        ) : null}

        {!token ? (
          <p className="mt-4 text-sm text-muted">
            This page needs a reset link. <a href="/forgot-password" className="text-accent hover:underline">Request a new one</a>.
          </p>
        ) : (
          <form action={resetPasswordAction} className="panel mt-4 space-y-4 p-5 shadow-panel">
            <input type="hidden" name="token" value={token} />
            <label className="block text-xs font-medium text-soft">
              New password
              <input name="newPassword" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={`${inputClass} mt-1`} />
            </label>
            <label className="block text-xs font-medium text-soft">
              Confirm new password
              <input name="confirmPassword" type="password" required minLength={MIN_PASSWORD_LENGTH} autoComplete="new-password" className={`${inputClass} mt-1`} />
            </label>
            <Button variant="primary" className="w-full">Set password</Button>
          </form>
        )}
      </div>
    </main>
  );
}
