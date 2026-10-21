import { NextResponse } from "next/server";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { updateGlobalSettings } from "@/lib/global-settings-file";
import { isPluginSourceCheckable } from "@/lib/plugin-updates";
import { invalidateOmpRuntime } from "@/lib/omp-runtime";
import {
  getPackageSource,
  hasEntrySettings,
  isDisabledPackage,
  loadGlobalPackageScope,
  loadProjectPackageScope,
  projectConfigDirs,
  projectSettingsCandidates,
  readDisabledExtensionIds,
  resolveInstalledPackagePath,
  type LoadedPackageScope,
  type PluginPackageEntry,
  type PluginPackageEntryObject,
} from "@/lib/plugin-package-settings";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginStandaloneExtensionInfo,
  PluginToggleResult,
  ProjectTrustStatus,
  PluginsBulkResponse,
  PluginsResponse,
} from "@/lib/api-types";

export const dynamic = "force-dynamic";

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

/** The two settings scopes of one request. */
interface PluginScopes {
  global: LoadedPackageScope;
  project: LoadedPackageScope;
}

const RESOURCE_FILTER_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const EXTENSION_FILE = /\.(ts|js)$/;

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

function settingsError(scopePath: string, error: unknown): string {
  return `${scopePath}: ${error instanceof Error ? error.message : String(error)}`;
}

function loadScopes(cwd: string, agentDir: string, projectTrusted: boolean): PluginScopes {
  return {
    global: loadGlobalPackageScope(agentDir),
    project: loadProjectPackageScope(cwd, projectTrusted),
  };
}

/**
 * Whether this request may change the project scope's plugin settings.
 *
 * omp-web's session trust gate looks at code-bearing folders (`.omp/tools`,
 * `.mcp.json`, …) and lets a folder that only ships a `settings.json` through.
 * This route writes that file, so a folder which configures plugins needs an
 * explicit decision first: writing a package into a folder the user never
 * trusted would turn the panel into a remote editor of project configuration.
 */
function projectPluginsTrusted(cwd: string, status: ProjectTrustStatus): boolean {
  if (!status.trusted) return false;
  if (status.decision === true) return true;
  return !projectSettingsCandidates(cwd).some((candidate) => existsSync(candidate));
}

const UNTRUSTED_PROJECT_ERROR = "Project resources must be trusted before modifying project plugins";
const NOT_CONFIGURED_ERROR = "Package is not configured";
/**
 * Disabling replaces an entry's resource lists, and omp-web keeps no copy, so a
 * package whose lists were filtered by hand cannot be restored by enabling.
 */
const FILTERED_PACKAGE_ERROR =
  "Has resource filters, which disabling would remove; use the package's own switch";

/**
 * Disables or re-enables the given packages of one scope in the settings list.
 * Returns the sources the scope does not configure, the ones left enabled
 * because disabling would drop their filters, and the list to write — omitted
 * when nothing changed, so a no-op toggle never rewrites the file.
 *
 * An entry already in the requested state is left exactly as it is, and
 * enabling keeps every key except the emptied resource lists (`autoload` on a
 * package entry, say), so neither drops what the entry configures.
 */
function setPackagesDisabled(
  current: readonly PluginPackageEntry[],
  sources: readonly string[],
  disabled: boolean,
  { keepEntrySettings = false }: { keepEntrySettings?: boolean } = {},
): { missing: Set<string>; kept: Set<string>; next?: PluginPackageEntry[] } {
  const missing = new Set(sources);
  const kept = new Set<string>();
  let changed = false;
  const next = current.map((entry): PluginPackageEntry => {
    const source = getPackageSource(entry);
    if (!sources.includes(source)) return entry;
    missing.delete(source);
    if (isDisabledPackage(entry) === disabled) return entry;
    if (disabled && keepEntrySettings && hasEntrySettings(entry)) {
      kept.add(source);
      return entry;
    }
    changed = true;
    if (disabled) {
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    if (typeof entry === "string") return source;
    const rest: PluginPackageEntryObject = { ...entry };
    delete rest.extensions;
    delete rest.skills;
    delete rest.prompts;
    delete rest.themes;
    return Object.keys(rest).length > 1 ? rest : source;
  });
  return changed ? { missing, kept, next } : { missing, kept };
}

/**
 * Write a scope's package list with the same lock the other settings keys use.
 * `updateGlobalSettings` is a generic locked read-modify-write of a
 * `settings.json` path; it merges into whatever else the file holds.
 */
async function writePackageScope(scope: LoadedPackageScope, next: readonly PluginPackageEntry[]): Promise<string | undefined> {
  try {
    await updateGlobalSettings(scope.path, (settings) => {
      settings.packages = [...next];
    });
    return undefined;
  } catch (error) {
    return settingsError(scope.path, error);
  }
}

/**
 * The bulk form of enable/disable behind the panel's "Enable all" /
 * "Disable all". Each package gets its own result, so one the route refuses
 * (an untrusted project, a package removed since the panel loaded, a filtered
 * package it would have to strip to disable) does not stop the rest.
 *
 * A settings file that cannot be read or written is charged to its scope: an
 * unreadable `settings.json` must never be reported as a successful toggle.
 */
async function setPackageListDisabled(
  scopes: PluginScopes,
  packages: readonly { source: string; scope: PluginScope }[],
  disabled: boolean,
  projectTrusted: boolean,
): Promise<PluginToggleResult[]> {
  const errors = new Map<string, string>();
  const settingsErrors = new Map<string, string>();
  for (const scope of ["global", "project"] as const) {
    const sources = packages.filter((pkg) => pkg.scope === scope).map((pkg) => pkg.source);
    if (sources.length === 0) continue;
    if (scope === "project" && !projectTrusted) {
      for (const source of sources) errors.set(keyFor(source, scope), UNTRUSTED_PROJECT_ERROR);
      continue;
    }
    const loaded = scope === "project" ? scopes.project : scopes.global;
    if (loaded.error) {
      settingsErrors.set(scope, loaded.error);
      continue;
    }
    // "Disable all" must not wipe filters the operator set up by hand.
    const { missing, kept, next } = setPackagesDisabled(loaded.entries, sources, disabled, {
      keepEntrySettings: true,
    });
    if (next) {
      const writeError = await writePackageScope(loaded, next);
      if (writeError) {
        settingsErrors.set(scope, writeError);
        continue;
      }
    }
    for (const source of missing) errors.set(keyFor(source, scope), NOT_CONFIGURED_ERROR);
    for (const source of kept) errors.set(keyFor(source, scope), FILTERED_PACKAGE_ERROR);
  }
  return packages.map((pkg) => {
    // A settings file that failed to load also reads as "not configured", so
    // its error wins. An untrusted project is never loaded and records none.
    const error = settingsErrors.get(pkg.scope) ?? errors.get(keyFor(pkg.source, pkg.scope));
    return error ? { ...pkg, error } : { ...pkg };
  });
}

function readPackageList(value: unknown): { source: string; scope: PluginScope }[] | null {
  if (!Array.isArray(value)) return null;
  const packages = new Map<string, { source: string; scope: PluginScope }>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || !("source" in item)) return null;
    const source = typeof item.source === "string" ? item.source.trim() : "";
    if (!source) return null;
    const scope = readScope("scope" in item ? item.scope : undefined);
    packages.set(keyFor(source, scope), { source, scope });
  }
  return [...packages.values()];
}

function addCount(counts: PluginResourceCounts, kind: keyof PluginResourceCounts): void {
  counts[kind] += 1;
}

function readDirEntriesSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function getResourceName(path: string, kind: PluginResourceKind): string {
  const file = basename(path);
  const ext = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && ext) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
    return file.slice(0, -ext.length);
  }
  return file;
}

/** `path` under `baseDir`, forward-slashed; the absolute path when it is outside. */
function relativePathFrom(baseDir: string, path: string): string {
  const rel = relative(baseDir, path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
}

function toResourceInfo(path: string, kind: PluginResourceKind, baseDir: string): PluginResourceInfo {
  return { kind, name: getResourceName(path, kind), path, relativePath: relativePathFrom(baseDir, path) };
}

/** Extensions a package folder declares in its `omp`/`pi` manifest. */
function declaredPackageExtensions(packageDir: string): string[] {
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const manifest = "omp" in parsed ? parsed.omp : "pi" in parsed ? parsed.pi : parsed;
    if (typeof manifest !== "object" || manifest === null || !("extensions" in manifest)) return [];
    if (!Array.isArray(manifest.extensions)) return [];
    return manifest.extensions
      .filter((item): item is string => typeof item === "string")
      .map((item) => resolve(packageDir, item))
      .filter((item) => existsSync(item));
  } catch {
    return [];
  }
}

/**
 * The modules of one `extensions/` folder, following omp's own discovery
 * (`discovery/helpers.ts`): top-level `*.ts`/`*.js` files, otherwise a
 * subdirectory's declared extensions or its `index.ts`/`index.js`.
 */
function discoverExtensionModulePaths(extensionsDir: string): string[] {
  const found: string[] = [];
  for (const entry of readDirEntriesSafe(extensionsDir)) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(extensionsDir, entry.name);
    let stats;
    try {
      stats = statSync(entryPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      if (EXTENSION_FILE.test(entry.name)) found.push(entryPath);
      continue;
    }
    const declared = declaredPackageExtensions(entryPath);
    if (declared.length > 0) {
      found.push(...declared);
      continue;
    }
    for (const indexName of ["index.ts", "index.js"]) {
      const indexPath = join(entryPath, indexName);
      if (existsSync(indexPath)) {
        found.push(indexPath);
        break;
      }
    }
  }
  return found;
}

/** omp's extension id from its path: the folder of an index module, else the stem. */
function extensionNameFromPath(extensionPath: string): string {
  const file = basename(extensionPath);
  if (file === "index.ts" || file === "index.js") return basename(dirname(extensionPath));
  const ext = extname(file);
  return ext && ext !== file ? file.slice(0, -ext.length) : file;
}

/**
 * Top-level extensions: what sits in `<agentDir>/extensions` (global scope) and
 * in the project's own config folders. `enabled` follows omp's
 * `disabledExtensions` ids, the same list its extension loader skips.
 */
function collectStandaloneExtensions(
  agentDir: string,
  cwd: string,
  projectLoaded: boolean,
  disabledIds: Set<string>,
): PluginStandaloneExtensionInfo[] {
  const roots: Array<{ configDir: string; scope: PluginScope }> = [
    { configDir: agentDir, scope: "global" },
  ];
  if (projectLoaded) {
    for (const configDir of projectConfigDirs(cwd)) roots.push({ configDir, scope: "project" });
  }
  const byPath = new Map<string, PluginStandaloneExtensionInfo>();
  for (const { configDir, scope } of roots) {
    for (const path of discoverExtensionModulePaths(join(configDir, "extensions"))) {
      if (byPath.has(path)) continue;
      const name = extensionNameFromPath(path);
      byPath.set(path, {
        kind: "extension",
        name,
        path,
        relativePath: relativePathFrom(configDir, path),
        scope,
        enabled: !disabledIds.has(`extension-module:${name}`),
      });
    }
  }
  return [...byPath.values()];
}

function collectPackageResources(installedPath: string | undefined): {
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
} {
  const counts = emptyCounts();
  const resources: PluginResourceInfo[] = [];
  if (!installedPath) return { counts, resources };
  for (const path of discoverExtensionModulePaths(join(installedPath, "extensions"))) {
    addCount(counts, "extensions");
    resources.push(toResourceInfo(path, "extension", installedPath));
  }
  for (const entry of readDirEntriesSafe(join(installedPath, "skills"))) {
    const skillPath = join(installedPath, "skills", entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(skillPath)) continue;
    addCount(counts, "skills");
    resources.push(toResourceInfo(skillPath, "skill", installedPath));
  }
  for (const kind of ["prompts", "themes"] as const) {
    for (const entry of readDirEntriesSafe(join(installedPath, kind))) {
      const path = join(installedPath, kind, entry.name);
      if (!entry.isFile()) continue;
      if (kind === "prompts" ? !entry.name.endsWith(".md") : !entry.name.endsWith(".css")) continue;
      addCount(counts, kind);
      resources.push(toResourceInfo(path, kind === "prompts" ? "prompt" : "theme", installedPath));
    }
  }
  return { counts, resources };
}

function getConfiguredVersion(source: string): string | undefined {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined;
  if (npmSpec) {
    const lastAt = npmSpec.lastIndexOf("@");
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    if (lastAt > packageNameEnd) return npmSpec.slice(lastAt + 1) || undefined;
    return undefined;
  }

  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

function readPackageMetadata(installedPath?: string): {
  packageName?: string;
  version?: string;
  description?: string;
} {
  if (!installedPath) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return {
      packageName: "name" in parsed && typeof parsed.name === "string" ? parsed.name : undefined,
      version: "version" in parsed && typeof parsed.version === "string" ? parsed.version : undefined,
      description: "description" in parsed && typeof parsed.description === "string"
        ? parsed.description
        : undefined,
    };
  } catch {
    return {};
  }
}

/** True when an entry narrows the package's resources to a subset. */
function isFilteredEntry(entry: PluginPackageEntry): boolean {
  return typeof entry === "object"
    && !isDisabledPackage(entry)
    && RESOURCE_FILTER_KEYS.some((key) => Array.isArray(entry[key]));
}

async function readPlugins(cwd: string): Promise<PluginsResponse> {
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  const scopes = loadScopes(cwd, agentDir, projectTrust.trusted);
  const diagnostics: PluginDiagnostic[] = [];
  if (scopes.global.error) {
    diagnostics.push({ type: "warning", message: `Could not read the global plugin settings: ${scopes.global.error}` });
  }
  if (scopes.project.error) {
    diagnostics.push({ type: "warning", message: `Could not read the project plugin settings: ${scopes.project.error}` });
  }

  const disabledSettings = [
    scopes.global.path,
    join(agentDir, "config.yml"),
    ...(projectTrust.trusted ? projectConfigDirs(cwd).flatMap((dir) => [join(dir, "settings.json"), join(dir, "config.yml")]) : []),
  ];
  const standaloneExtensions = collectStandaloneExtensions(
    agentDir,
    cwd,
    projectTrust.trusted,
    readDisabledExtensionIds(disabledSettings),
  );

  const totals = emptyCounts();
  const configured: Array<{ entry: PluginPackageEntry; scope: PluginScope }> = [
    ...scopes.global.entries.map((entry) => ({ entry, scope: "global" as PluginScope })),
    ...scopes.project.entries.map((entry) => ({ entry, scope: "project" as PluginScope })),
  ];
  const packages = configured.map(({ entry, scope }): PluginPackageInfo => {
    const source = getPackageSource(entry);
    const disabled = isDisabledPackage(entry);
    const installedPath = resolveInstalledPackagePath(source, cwd);
    if (!installedPath) {
      diagnostics.push({ type: "warning", source, message: "Configured package path was not found." });
    }
    const { counts, resources } = collectPackageResources(installedPath);
    for (const kind of RESOURCE_FILTER_KEYS) addCount(totals, kind);
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(installedPath);
    return {
      source,
      scope,
      canCheckForUpdates: isPluginSourceCheckable(source),
      filtered: isFilteredEntry(entry),
      disabled,
      installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      configuredVersion: getConfiguredVersion(source),
      description: packageMetadata.description,
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });
  totals.extensions += standaloneExtensions.filter((extension) => extension.enabled).length;

  return {
    packages,
    standaloneExtensions,
    totals,
    diagnostics,
    projectResourcesLoaded: projectTrust.trusted,
  };
}

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await readPlugins(cwd));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd }
// enable/disable also take { packages: [{ source, scope }] } in place of
// source/scope and add per-package `results` to the response.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      packages?: unknown;
      cwd?: string;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(body.cwd, agentDir);
    const canEditProjectPlugins = projectPluginsTrusted(body.cwd, projectTrust);

    if (body.packages !== undefined) {
      if (body.action !== "enable" && body.action !== "disable") {
        return NextResponse.json({ error: "packages is only supported by enable and disable" }, { status: 400 });
      }
      const packages = readPackageList(body.packages);
      if (!packages) {
        return NextResponse.json({ error: "packages must be a list of { source, scope }" }, { status: 400 });
      }
      const results = await setPackageListDisabled(
        loadScopes(body.cwd, agentDir, canEditProjectPlugins),
        packages,
        body.action === "disable",
        canEditProjectPlugins,
      );
      return NextResponse.json({ ...(await readPlugins(body.cwd)), results } satisfies PluginsBulkResponse);
    }

    const scope = readScope(body.scope);
    if (scope === "project" && !canEditProjectPlugins) {
      return NextResponse.json({ error: UNTRUSTED_PROJECT_ERROR }, { status: 403 });
    }
    const source = body.source?.trim();
    // omp installs plugins into one shared tree (`<agentDir>/plugins`), so
    // install/remove/update act on it whatever scope the panel was showing;
    // only the settings list is scope-split.
    const manager = new PluginManager(body.cwd);

    if (body.action === "install") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await manager.install(source);
    } else if (body.action === "remove") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await manager.uninstall(source);
    } else if (body.action === "update") {
      // omp has no in-place update: reinstalling the same spec re-resolves it.
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await manager.install(source, { force: true });
    } else if (body.action === "disable" || body.action === "enable") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      const disabled = body.action === "disable";
      const loaded = scope === "project"
        ? loadProjectPackageScope(body.cwd, true)
        : loadGlobalPackageScope(agentDir);
      if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: 500 });
      const { missing, next } = setPackagesDisabled(loaded.entries, [source], disabled);
      if (missing.has(source)) {
        return NextResponse.json({ error: NOT_CONFIGURED_ERROR }, { status: 404 });
      }
      if (next) {
        const writeError = await writePackageScope(loaded, next);
        if (writeError) return NextResponse.json({ error: writeError }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
    }

    return NextResponse.json(await readPlugins(body.cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally {
    // A package can add or drop a provider, and sessions build their runtime
    // from the loaded extensions; drop the cached one so the next request
    // sees what this toggle changed.
    invalidateOmpRuntime();
  }
}
