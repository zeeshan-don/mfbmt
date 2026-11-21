import { NextResponse } from "next/server";
import { authorizeOwner } from "@/lib/auth";
import { integrationKeys, type IntegrationKey } from "@/lib/constants";
import { getIntegrationDiagnostics, runIntegrationDiagnostic } from "@/lib/integrations/diagnostics";
import { storageReadiness } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner-only, organization-scoped integration diagnostics.
 *
 * GET reads the stored status for the signed-in owner's organization. POST
 * performs one explicit, non-destructive provider check. Neither response
 * contains credentials.
 */
export async function GET() {
  const user = await authorizeOwner();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  return NextResponse.json(
    {
      organization: user.organizationSlug,
      integrations: await getIntegrationDiagnostics(),
      storage: { ...storageReadiness(), detail: undefined },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const user = await authorizeOwner();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { key?: string };
  const key = String(body.key ?? "") as IntegrationKey;
  if (!integrationKeys.includes(key)) {
    return NextResponse.json({ error: "Unknown integration." }, { status: 400 });
  }

  const result = await runIntegrationDiagnostic(key);
  return NextResponse.json({ key, ...result }, { headers: { "Cache-Control": "no-store" } });
}
