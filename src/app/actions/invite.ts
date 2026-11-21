"use server";

import { redirect } from "next/navigation";
import { acceptOwnerInvitation, invitationPreview } from "@/lib/onboarding/invite";

export async function acceptInviteAction(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (password !== confirm) {
    redirect(`/accept-invite?token=${encodeURIComponent(token)}&error=${encodeURIComponent("The passwords do not match.")}`);
  }
  const preview = await invitationPreview(token);
  if (!preview) {
    redirect("/accept-invite?error=This+invitation+link+is+not+valid.");
  }

  const result = await acceptOwnerInvitation({ token, password, name: name || undefined });
  if (!result.ok) {
    redirect(`/accept-invite?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/login?invited=1&workspace=${encodeURIComponent(preview.organizationSlug)}`);
}
