import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { SkillToggleResult } from "@/lib/api-types";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Uses omp's own skill discovery (the same `loadSkills` AgentSession startup
// runs), so `.omp/skills`, `~/.omp/agent/skills`, `.claude/skills`, plugin
// skills, and `.agents/skills` are all included with identical precedence.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch {
    return NextResponse.json({ error: "Unable to load skills" }, { status: 500 });
  }
}

/** Every root a SKILL.md edit may land in: the file browser's roots plus the
 *  skill homes the Settings panel can see but the browser cannot reach. */
async function getSkillEditRoots(): Promise<Set<string>> {
  const allowedRoots = new Set(await getAllowedFileRoots());
  allowedRoots.add(getAgentDir());
  // Globally installed skills live in ~/.agents/skills and are symlinked into
  // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
  // the real target sits outside getAgentDir(). Allow the global skills root
  // too (omp always treats ~/.agents/skills as trusted).
  const globalSkillsDir = path.join(homedir(), ".agents", "skills");
  if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
  return allowedRoots;
}

/** Edits one skill file, or returns the status and message that refused it. */
function toggleSkillFile(
  filePath: string,
  disableModelInvocation: boolean,
  allowedRoots: Set<string>,
): { status: number; error: string } | null {
  // Skills are SKILL.md or *.md files. The allowed roots also hold settings,
  // auth.json and project files, whose top a frontmatter edit would break.
  if (path.extname(filePath).toLowerCase() !== ".md") return { status: 400, error: "Not a skill file" };
  let resolvedFilePath: string;
  try {
    resolvedFilePath = realpathSync(filePath);
  } catch {
    return { status: 404, error: "file not found" };
  }
  if (!statSync(resolvedFilePath).isFile()) return { status: 400, error: "file must be a regular file" };
  if (!isExistingFilePathAllowed(resolvedFilePath, allowedRoots)) {
    return { status: 403, error: "Access denied" };
  }
  const content = readFileSync(resolvedFilePath, "utf8");
  const updated = setDisableModelInvocation(content, disableModelInvocation);
  // A skill already in the requested state keeps its file and mtime.
  if (updated !== content) writeFileSync(resolvedFilePath, updated, "utf8");
  return null;
}

// PATCH /api/skills — toggle disable-model-invocation on SKILL.md files.
// Body: { filePath, disableModelInvocation } for one skill, or
// { filePaths, disableModelInvocation } for the panel's "Enable all" /
// "Disable all". A batch edits each file on its own and reports every one, so
// a skill the route refuses does not stop the rest.
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      filePath?: unknown;
      filePaths?: unknown;
      disableModelInvocation?: unknown;
    };
    const { filePath, filePaths, disableModelInvocation } = body;

    if (filePaths !== undefined) {
      if (!Array.isArray(filePaths) || !filePaths.every((item) => typeof item === "string" && item)) {
        return NextResponse.json({ error: "filePaths must be a list of paths" }, { status: 400 });
      }
      if (typeof disableModelInvocation !== "boolean") {
        return NextResponse.json({ error: "disableModelInvocation must be a boolean" }, { status: 400 });
      }
      const allowedRoots = await getSkillEditRoots();
      const results: SkillToggleResult[] = [];
      for (const target of new Set(filePaths as string[])) {
        try {
          const refused = toggleSkillFile(target, disableModelInvocation, allowedRoots);
          results.push(refused ? { filePath: target, error: refused.error } : { filePath: target });
        } catch (e) {
          results.push({ filePath: target, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return NextResponse.json({ results });
    }

    if (typeof filePath !== "string" || !filePath.trim()) {
      return NextResponse.json({ error: "filePath required" }, { status: 400 });
    }
    if (typeof disableModelInvocation !== "boolean") {
      return NextResponse.json({ error: "disableModelInvocation must be boolean" }, { status: 400 });
    }
    const refused = toggleSkillFile(filePath.trim(), disableModelInvocation, await getSkillEditRoots());
    if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Unable to update skill" }, { status: 500 });
  }
}
