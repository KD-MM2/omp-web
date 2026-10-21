import { NextResponse } from "next/server";
import type { ToolSettingsResponse } from "@/lib/api-types";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readPowerShellToolEnabled,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";

export const dynamic = "force-dynamic";

// The only writer of the global `defaultTools` key's shell entry: the
// PowerShell switch in Settings swaps `bash` for `powershell` (Windows only)
// through the locked global-settings file. omp has no codemode, so the
// upstream route's codemode branches have no fork counterpart.

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

async function readToolSettings(): Promise<ToolSettingsResponse> {
  const powerShellEnabled = await readPowerShellToolEnabled();
  return { isWindows: process.platform === "win32", powerShellEnabled };
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const changes = body as { enabled?: unknown };
  if (typeof changes.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  try {
    await writePowerShellToolEnabled(changes.enabled);
    return NextResponse.json(await readToolSettings());
  } catch (error) {
    return errorResponse(error);
  }
}
