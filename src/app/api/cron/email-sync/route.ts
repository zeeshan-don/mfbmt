import { NextResponse } from "next/server";
import { cronOrQStashAuthorized } from "@/lib/qstash";
import { syncEmailIntake } from "@/lib/email/sync";
import { rawDb } from "@/lib/db-base";
import { runWithTenant } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PATH = "/api/cron/email-sync";

/**
 * Manual / diagnostic mailbox sync for ONE explicitly named tenant.
 *
 * Routine mailbox polling is performed by the long-running worker, which enters
 * each active tenant's context before reading that tenant's mailbox. This
 * endpoint no longer has a QStash schedule: a tenant-less scheduler request must
 * never be able to synchronize an arbitrary tenant.
 */
async function tenantFromRequest(request: Request): Promise<
  | { ok: true; organizationId: string; slug: string }
  | { ok: false; error: string; status: number }
> {
  const url = new URL(request.url);
  let slug = url.searchParams.get("organization") ?? url.searchParams.get("organizationSlug");
  let organizationId = url.searchParams.get("organizationId");

  if (!slug && !organizationId && request.method === "POST") {
    const body = (await request.clone().json().catch(() => null)) as
      | { organization?: string; organizationSlug?: string; organizationId?: string }
      | null;
    slug = body?.organization ?? body?.organizationSlug ?? null;
    organizationId = body?.organizationId ?? null;
  }

  if (!slug && !organizationId) {
    return {
      ok: false,
      status: 400,
      error:
        "An explicit tenant is required. Pass ?organization=<slug> or ?organizationId=<id>. Routine mailbox sync runs in the worker per tenant; this endpoint is manual/diagnostic only.",
    };
  }

  const organization = await rawDb.organization.findFirst({
    where: slug ? { slug: slug.trim().toLowerCase() } : { id: organizationId as string },
    select: { id: true, slug: true, status: true },
  });
  if (!organization) return { ok: false, status: 404, error: "The requested organization was not found." };
  if (organization.status !== "ACTIVE") {
    return { ok: false, status: 409, error: `Organization ${organization.slug} is ${organization.status}.` };
  }
  return { ok: true, organizationId: organization.id, slug: organization.slug };
}

async function handle(request: Request) {
  const authorization = await cronOrQStashAuthorized(request, PATH);
  if (!authorization.ok) {
    return NextResponse.json({ error: authorization.error }, { status: authorization.status });
  }

  const tenant = await tenantFromRequest(request);
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status });
  }

  try {
    const result = await runWithTenant(
      { organizationId: tenant.organizationId, source: "internal" },
      () => syncEmailIntake({ trigger: "manual" }),
    );
    return NextResponse.json({
      ok: result.ok,
      organization: tenant.slug,
      processed: result.processed,
      skipped: result.skipped,
      failed: result.failed,
      detail: result.detail,
      source: authorization.source,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        organization: tenant.slug,
        error: error instanceof Error ? error.message : "Email sync failed.",
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
