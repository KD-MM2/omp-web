import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import { invalidateOmpRuntime } from "@/lib/omp-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { ModelsConfigReadError } from "@/lib/models-config-store";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";
import { parseJsonc } from "@/lib/jsonc";
export const dynamic = "force-dynamic";

/**
 * Custom provider config lives in `~/.omp/agent/models.yml`.
 *
 * omp reads `models.yml` first and falls back to `models.yaml`; a legacy
 * `models.json` is migrated to YAML on first load. Read whichever exists, but
 * always write back to `models.yml` so the CLI and omp-web agree on one file.
 */
const CANONICAL_FILE = "models.yml";
const READ_CANDIDATES = ["models.yml", "models.yaml", "models.json"] as const;

function getModelsPath(): string {
  const agentDir = getAgentDir();
  for (const candidate of READ_CANDIDATES) {
    const path = join(agentDir, candidate);
    if (existsSync(path)) return path;
  }
  return join(agentDir, CANONICAL_FILE);
}

function getWritePath(): string {
  return join(getAgentDir(), CANONICAL_FILE);
}

/**
 * Reads the active config with the same leniency as the SDK loaders: `models.json`
 * is JSONC (BOM, `//` comments, trailing commas), `models.yml`/`.yaml` is YAML.
 * An existing file whose contents cannot be used throws — reading it as empty
 * would let the next save delete every provider.
 */
function readModelsConfig(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  let parsed: unknown;
  try {
    const content = readFileSync(path, "utf8");
    if (!content.replace(/^\uFEFF/, "").trim()) return { providers: {} };
    parsed = path.endsWith(".json") ? parseJsonc(content) : parseYaml(content);
  } catch (error) {
    throw new ModelsConfigReadError(
      `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ModelsConfigReadError(`Failed to read ${path}: expected a config object`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Drop blank model rows (empty/whitespace string ids) before persisting, but
// keep non-string ids and non-object entries so schema errors elsewhere stay
// visible to the user instead of being silently rewritten.
function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

function writeModelsConfig(data: Record<string, unknown>): void {
  const path = getWritePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, stringifyYaml(sanitizeModelsConfig(data), { lineWidth: 0 }));
}

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "models config must be an object" }, { status: 400 });
    }
    const config = body as Record<string, unknown>;
    if (
      "providers" in config
      && (typeof config.providers !== "object" || config.providers === null || Array.isArray(config.providers))
    ) {
      return NextResponse.json({ error: "providers must be an object" }, { status: 400 });
    }
    // A text draft of contextWindow must be a whole positive token count before
    // anything touches disk; values already in the file pass as long as the
    // SDK itself tolerates them.
    const normalized = normalizeContextWindowOverrides(config);
    // Refuse to replace a current config this panel could not read: the draft
    // being saved was not built from it, so writing would discard its contents.
    readModelsConfig();
    writeModelsConfig(normalized);
    invalidateModelsCache();
    // The registry caches models.yml at construction; drop it so the next
    // request rebuilds against the edited providers.
    invalidateOmpRuntime();
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Unable to save models config" }, { status: 500 });
  }
}
