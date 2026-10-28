import { NextResponse } from "next/server";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { resolveSessionPath, buildSessionContext, getHistoricalContextUsage, CONTEXT_DEFAULT_TAIL } from "@/lib/session-reader";
import { getRpcSession, getFinalRpcSessionId } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // Page upward: `before` is the oldest entry already loaded, so the next page
  // starts at its parent. `tail` bounds the visible window (routes cap at 1000).
  // A request without `tail` is capped too: unbounded responses made every
  // session open ship the whole branch to the browser, which OOM-kills mobile
  // webviews on long sessions. `hasMore`/`oldestEntryId` page the rest upward.
  const before = url.searchParams.get("before");
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Math.min(Number.isFinite(rawTail) && rawTail > 0 ? rawTail : CONTEXT_DEFAULT_TAIL, 1000);

  try {
    const directRpc = getRpcSession(id);
    const canonicalId = directRpc?.sessionId ?? getFinalRpcSessionId(id) ?? id;
    const rpc = directRpc ?? getRpcSession(canonicalId);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(canonicalId);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? await SessionManager.open(filePath!);
    const entries = sm.getEntries() as never;
    const context = buildSessionContext(entries, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
    });
    const contextUsage = await getHistoricalContextUsage(entries, leafId);

    return NextResponse.json({
      sessionId: liveRpc?.sessionId ?? sm.getSessionId(),
      runtimeId: liveRpc?.runtimeId ?? null,
      context,
      ...(contextUsage ? { contextUsage } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
