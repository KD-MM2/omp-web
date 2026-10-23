import { NextResponse } from "next/server";
import { getRpcSessionActivitySnapshot } from "@/lib/rpc-manager";
import { getSessionListVersion } from "@/lib/session-reader";
import { getSessionUiStateRevision } from "@/lib/session-ui-state";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionListVersion bumps when another process writes session files (the
// poll itself starts a throttled filename check); sessionUiStateRevision
// (null when unreadable) tells the sidebar its pins and archive changed
// elsewhere; it costs one stat while the file is unchanged.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      sessionUiStateRevision: getSessionUiStateRevision(),
      ...getRpcSessionActivitySnapshot(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
