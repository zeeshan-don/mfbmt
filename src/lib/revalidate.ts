import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { broadcastOrgRefresh } from "./realtime";

/**
 * Replaces a bare `revalidatePath` inside server actions: the acting user's
 * company still gets its cache invalidated, and every other open tab is told to
 * refresh through Pusher once the response has been sent.
 */
export function revalidateOrgPath(organizationId: string, path: string): void {
  revalidatePath(path);
  try {
    after(() => broadcastOrgRefresh(organizationId, path));
  } catch {
    // Called outside a request scope (for example from a script). Fall back to
    // a best-effort background publish.
    void broadcastOrgRefresh(organizationId, path);
  }
}
