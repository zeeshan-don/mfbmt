import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isDemoMode } from "@/lib/env";
import { db } from "@/lib/db";
import { loginAction } from "./actions";
import { Button, Notice, inputClass } from "@/components/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; workspace?: string }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect("/");
  const { error, workspace } = await searchParams;
  const organization = workspace
    ? await db.organization.findUnique({ where: { slug: workspace.trim().toLowerCase() } })
    : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
            {organization?.name ?? "MFBMT"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Procurement Intelligence</h1>
          <p className="mt-2 text-sm text-muted">
            Sign in to review enquiries, compare supplier offers and approve sourcing.
          </p>
        </div>

        <form action={loginAction} className="panel space-y-4 p-5 shadow-panel">
          {error ? (
            <Notice tone="danger" title="Could not sign in">
              {error}
            </Notice>
          ) : null}
          <div>
            <label htmlFor="workspace" className="mb-1 block text-xs font-medium text-soft">
              Workspace <span className="text-muted">(optional if your email belongs to one company)</span>
            </label>
            <input
              id="workspace"
              name="workspace"
              type="text"
              autoComplete="organization"
              defaultValue={workspace ?? ""}
              className={inputClass}
              placeholder="e.g. mfbmt"
            />
          </div>
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-soft">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className={inputClass}
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs font-medium text-soft">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
              placeholder="Your password"
            />
          </div>
          <Button variant="primary" className="w-full">
            Sign in
          </Button>
        </form>

        {isDemoMode ? (
          <div className="mt-4 rounded-card border border-line bg-surface px-4 py-3 text-xs text-muted">
            <p className="font-medium text-soft">Demo access</p>
            <p className="mt-1">
              Owner: <span className="text-ink">owner@mfbmt.local</span> / <span className="text-ink">ChangeMe123!</span>
            </p>
            <p>
              Staff: <span className="text-ink">staff@mfbmt.local</span> / <span className="text-ink">ChangeMe123!</span>
            </p>
            <p className="mt-1">Change these before using the system with real data. Workspace: mfbmt.</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
