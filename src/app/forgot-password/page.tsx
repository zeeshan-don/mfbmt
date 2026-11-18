import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { Button, Notice, inputClass } from "@/components/ui";
import { requestPasswordResetAction } from "@/app/actions/account";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; message?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");
  const flags = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">MFBMT</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Reset your password</h1>
        <p className="mt-2 text-sm text-muted">
          Enter the email address of your MFBMT account. A single-use link is sent if the account exists.
        </p>

        {flags.sent ? (
          <div className="mt-4">
            <Notice tone="info" title="Check your email">{flags.message}</Notice>
          </div>
        ) : null}

        <form action={requestPasswordResetAction} className="panel mt-4 space-y-4 p-5 shadow-panel">
          <label htmlFor="email" className="block text-xs font-medium text-soft">
            Email
            <input id="email" name="email" type="email" required autoComplete="username" className={`${inputClass} mt-1`} />
          </label>
          <Button variant="primary" className="w-full">Send reset link</Button>
        </form>

        <p className="mt-4 text-xs text-muted">
          <a href="/login" className="text-accent hover:underline">Back to sign in</a>
        </p>
      </div>
    </main>
  );
}
