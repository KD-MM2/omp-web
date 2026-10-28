import { NextResponse } from "next/server";
import { realpathSync, statSync } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { normalizeDirectory } from "@/lib/directory-browser";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";


// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const normalizedCwd = normalizeDirectory(cwd);
    let canonicalCwd: string;
    try {
      const stat = statSync(normalizedCwd);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
      }
      canonicalCwd = realpathSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(canonicalCwd);
    // The UI keys worktree grouping and authorization scope on the server's
    // own project identity, not on the path it happened to send.
    const project = await resolveProject(canonicalCwd);
    return NextResponse.json({
      success: true,
      cwd: canonicalCwd,
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
