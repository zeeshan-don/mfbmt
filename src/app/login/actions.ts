"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { login } from "@/lib/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const workspace = String(formData.get("workspace") ?? "").trim();
  if (!email || !password) redirect("/login?error=Enter+your+email+and+password.");

  const headerList = await headers();
  const result = await login(email, password, {
    ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: headerList.get("user-agent") ?? undefined,
    workspace: workspace || undefined,
  });

  if (!result.ok) redirect(`/login?error=${encodeURIComponent(result.error)}`);

  await writeAudit({
    actorId: result.user.id,
    actorLabel: result.user.name,
    action: "auth.login",
    entityType: "User",
    entityId: result.user.id,
  });

  const mustChange = await db.user.findUnique({ where: { id: result.user.id }, select: { mustChangePassword: true } });
  redirect(mustChange?.mustChangePassword ? "/account?first=1" : "/");
}
