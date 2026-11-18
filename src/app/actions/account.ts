"use server";

import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { changeOwnPassword, requestPasswordReset, resetPasswordWithToken } from "@/lib/account";

const COOKIE_NAME = "mfbmt_session";

export async function changePasswordAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  if (newPassword !== confirm) {
    redirect(`/account?error=${encodeURIComponent("The new passwords do not match.")}`);
  }

  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value ?? "";
  const keepSessionTokenHash = token ? createHash("sha256").update(token).digest("hex") : null;

  const result = await changeOwnPassword({
    userId: user.id,
    currentPassword,
    newPassword,
    keepSessionTokenHash,
    actorLabel: user.name,
  });
  if (!result.ok) redirect(`/account?error=${encodeURIComponent(result.error)}`);
  redirect("/account?saved=1");
}

export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const result = await requestPasswordReset(email);
  redirect(`/forgot-password?sent=1&message=${encodeURIComponent(result.message)}`);
}

export async function resetPasswordAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");
  if (newPassword !== confirm) {
    redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent("The passwords do not match.")}`);
  }
  const result = await resetPasswordWithToken({ token, newPassword });
  if (!result.ok) {
    redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result.error)}`);
  }
  redirect("/login?reset=1");
}
