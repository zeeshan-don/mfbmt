"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession } from "@/lib/auth";
import { rawDb } from "@/lib/db-base";
import { writeAudit } from "@/lib/audit";
import { verifyMfaChallenge } from "@/lib/mfa";

export async function verifyMfaAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();

  const result = await verifyMfaChallenge({ token, code, ip });
  if (!result.ok) {
    redirect(`/login/mfa?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result.error)}`);
  }

  await createSession(
    { id: result.userId, organizationId: result.organizationId },
    { ip, userAgent: headerList.get("user-agent") ?? undefined },
  );
  await rawDb.user.update({ where: { id: result.userId }, data: { lastLoginAt: new Date() } });
  const user = await rawDb.user.findUnique({
    where: { id: result.userId },
    select: { name: true, email: true, mustChangePassword: true },
  });
  await writeAudit({
    organizationId: result.organizationId,
    actorId: result.userId,
    actorLabel: user?.name ?? user?.email ?? "user",
    action: "auth.login_mfa",
    entityType: "User",
    entityId: result.userId,
    ip,
  });
  redirect(user?.mustChangePassword ? "/account?first=1" : "/");
}
