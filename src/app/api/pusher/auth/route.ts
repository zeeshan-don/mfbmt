import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { authorizeOrgChannel, orgChannel } from "@/lib/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pusher private-channel authorisation. Only the caller's own org may subscribe. */
export async function POST(request: Request) {
  const user = await authorize();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const socketId = String(form.get("socket_id") ?? "");
  const channelName = String(form.get("channel_name") ?? "");
  if (!socketId || channelName !== orgChannel(user.organizationId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const auth = authorizeOrgChannel(socketId, channelName);
  if (!auth) {
    return NextResponse.json({ error: "Realtime is not configured" }, { status: 503 });
  }
  return NextResponse.json(auth);
}
