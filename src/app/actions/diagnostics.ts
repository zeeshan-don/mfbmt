"use server";

import { revalidateOrgPath } from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { authorizeOwner } from "@/lib/auth";
import { integrationKeys, type IntegrationKey } from "@/lib/constants";
import { runIntegrationDiagnostic } from "@/lib/integrations/diagnostics";

/** Owner-triggered, non-destructive provider check for the current tenant. */
export async function runDiagnosticAction(formData: FormData) {
  const user = await authorizeOwner();
  if (!user) redirect("/login");
  const key = String(formData.get("key") ?? "") as IntegrationKey;
  if (!integrationKeys.includes(key)) redirect("/integrations?error=Unknown+integration");

  const result = await runIntegrationDiagnostic(key);
  revalidateOrgPath(user.organizationId, "/integrations");
  redirect(`/integrations?checked=${encodeURIComponent(key)}&result=${encodeURIComponent(result.detail)}`);
}
