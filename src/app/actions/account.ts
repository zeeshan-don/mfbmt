"use server";

import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { changeOwnPassword, requestPasswordReset, resetPasswordWithToken } from "@/lib/account";
import { encryptSecret } from "@/lib/crypto";
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa } from "@/lib/mfa";

const COOKIE_NAME = "mfbmt_session";
const ENROLL_COOKIE = "mfbmt_mfa_enroll";
const RECOVERY_COOKIE = "mfbmt_mfa_recovery";

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

export async function startMfaAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const password = String(formData.get("password") ?? "");
  const result = await beginMfaEnrollment({ userId: user.id, password, email: user.email });
  if (!result.ok) redirect(`/account?error=${encodeURIComponent(result.error)}`);
  const store = await cookies();
  store.set(ENROLL_COOKIE, encryptSecret(JSON.stringify({ secret: result.secret, uri: result.uri })), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/account",
    maxAge: 10 * 60,
  });
  redirect("/account?mfa=enroll");
}

export async function confirmMfaAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const code = String(formData.get("code") ?? "").trim();
  const result = await confirmMfaEnrollment({ userId: user.id, code, actorLabel: user.name });
  if (!result.ok) redirect(`/account?mfa=enroll&error=${encodeURIComponent(result.error)}`);
  const store = await cookies();
  store.delete(ENROLL_COOKIE);
  store.set(RECOVERY_COOKIE, encryptSecret(JSON.stringify(result.recoveryCodes)), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/account",
    maxAge: 5 * 60,
  });
  redirect("/account?mfa=enabled");
}

export async function disableMfaAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const password = String(formData.get("password") ?? "");
  const result = await disableMfa({ userId: user.id, password, actorLabel: user.name });
  if (!result.ok) redirect(`/account?error=${encodeURIComponent(result.error)}`);
  const store = await cookies();
  store.delete(ENROLL_COOKIE);
  store.delete(RECOVERY_COOKIE);
  redirect("/account?mfa=disabled");
}

export async function clearMfaRecoveryAction() {
  const store = await cookies();
  store.delete(RECOVERY_COOKIE);
  redirect("/account?mfa=enabled");
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
