import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDirName, getPluginsDir } from "@oh-my-pi/pi-utils";
import { parse as parseYaml } from "yaml";
import { getGlobalSettingsPath } from "./global-settings-file";
import { parseNpmSource } from "./npm-source";

/**
 * The `packages` list of a settings file: the one place omp-web reads and
 * writes which plugin packages the user or a project has configured.
 *
 * pi's SDK owns that list behind a `SettingsManager`
 * (`getGlobalSettings().packages` / `setPackages()`), and the ported
 * `app/api/plugins` route still speaks that shape. omp 18 has no package list
 * at all: its `Settings` knows `extensions` and `disabledExtensions` but
 * nothing about package sources, and it migrates `settings.json` into
 * `config.yml` on first start. So omp-web keeps pi-web's storage contract —
 * the `packages` key of `<agentDir>/settings.json`, plus the project's own
 * settings file for the project scope — and changes it through the same locked
 * read-modify-write the other settings keys use, so an `omp` run and a panel
 * toggle cannot overwrite each other.
 */

/** A configured package: a bare source, or an entry with per-entry settings. */
export type PluginPackageEntryObject = { source: string } & Record<string, unknown>;
export type PluginPackageEntry = string | PluginPackageEntryObject;

/** The legacy pi folder, which earlier omp-web releases wrote packages into. */
const LEGACY_PROJECT_CONFIG_DIR = ".pi";

/** A package as the update checker and the panel want it. */
export interface ConfiguredPluginPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

export interface LoadedPackageScope {
  /** The settings file this scope reads and writes. */
  path: string;
  entries: PluginPackageEntry[];
  /** `"<path>: <message>"` when the file exists but could not be read or parsed. */
  error?: string;
  /** True for a project whose settings were not read at all because it is untrusted. */
  unloaded?: boolean;
}

function isPackageEntry(value: unknown): value is PluginPackageEntry {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "source" in value && typeof value.source === "string";
}

/** The source string of an entry, bare or wrapped. */
export function getPackageSource(entry: PluginPackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

/**
 * A package is disabled by emptying all four of its resource lists; the format
 * has no `enabled: false` flag.
 */
export function isDisabledPackage(entry: PluginPackageEntry): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0 &&
    Array.isArray(entry.skills) && entry.skills.length === 0 &&
    Array.isArray(entry.prompts) && entry.prompts.length === 0 &&
    Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

/**
 * An enabled entry that is an object: it filters the package's resources, or
 * sets `autoload`. Disabling replaces its resource lists, and nothing keeps a
 * copy, so enabling it again cannot bring the filters back.
 */
export function hasEntrySettings(entry: PluginPackageEntry): boolean {
  return typeof entry === "object" && !isDisabledPackage(entry);
}

/** The project's config folders: the fork's own, then the legacy pi folder. */
export function projectConfigDirs(cwd: string): string[] {
  return [join(cwd, getConfigDirName()), join(cwd, LEGACY_PROJECT_CONFIG_DIR)];
}

/** The project's settings files, the fork config folder first. */
export function projectSettingsCandidates(cwd: string): string[] {
  return projectConfigDirs(cwd).map((dir) => join(dir, "settings.json"));
}

/** The project settings file to read and write: the fork one, else a legacy one. */
export function projectSettingsPath(cwd: string): string {
  return projectSettingsCandidates(cwd).find((candidate) => existsSync(candidate))
    ?? join(cwd, getConfigDirName(), "settings.json");
}

function readPackagesFrom(settingsPath: string): { entries: PluginPackageEntry[]; error?: string } {
  if (!existsSync(settingsPath)) return { entries: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    if (!("packages" in parsed)) return { entries: [] };
    if (!Array.isArray(parsed.packages)) throw new Error("packages must be an array");
    return { entries: parsed.packages.filter(isPackageEntry) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entries: [], error: `${settingsPath}: ${message}` };
  }
}

export function loadGlobalPackageScope(agentDir: string): LoadedPackageScope {
  const path = getGlobalSettingsPath(agentDir);
  return { path, ...readPackagesFrom(path) };
}

/**
 * The project's packages. An untrusted project is never read: its settings are
 * project-controlled input, and the route must not write to a folder the user
 * has not trusted either.
 */
export function loadProjectPackageScope(cwd: string, projectTrusted: boolean): LoadedPackageScope {
  const path = projectSettingsPath(cwd);
  if (!projectTrusted) return { path, entries: [], unloaded: true };
  return { path, ...readPackagesFrom(path) };
}

/** The `<plugins>/node_modules` install omp's `PluginManager` maintains. */
export function resolveInstalledPackagePath(source: string, cwd: string): string | undefined {
  const npm = parseNpmSource(source);
  const candidates = npm
    ? [join(getPluginsDir(), "node_modules", npm.name), join(resolve(cwd), "node_modules", npm.name)]
    : [resolve(cwd, source)];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Every configured package, global scope first, project only when trusted. */
export function listConfiguredPackages(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): ConfiguredPluginPackage[] {
  const scopes: Array<{ scope: "user" | "project"; entries: PluginPackageEntry[] }> = [
    { scope: "user", entries: loadGlobalPackageScope(agentDir).entries },
  ];
  if (projectTrusted) scopes.push({ scope: "project", entries: loadProjectPackageScope(cwd, true).entries });
  return scopes.flatMap(({ scope, entries }) => entries.map((entry) => {
    const source = getPackageSource(entry);
    return { source, scope, installedPath: resolveInstalledPackagePath(source, cwd) };
  }));
}

/**
 * `disabledExtensions` ids, the setting omp's extension loader honors
 * (`extensibility/settings.ts`, matched as `extension-module:<name>` by
 * `extensibility/extensions/loader.ts`). Both storage locations are read: the
 * `settings.json` omp-web and older omp versions write, and the `config.yml`
 * omp migrates that file into on first start.
 */
export function readDisabledExtensionIds(settingsPaths: readonly string[]): Set<string> {
  const disabled = new Set<string>();
  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const text = readFileSync(settingsPath, "utf8");
      const parsed: unknown = settingsPath.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      if (!("disabledExtensions" in parsed) || !Array.isArray(parsed.disabledExtensions)) continue;
      for (const id of parsed.disabledExtensions) if (typeof id === "string") disabled.add(id);
    } catch {
      // An unreadable settings file must not empty the panel; its resources
      // just read as enabled, which is what an absent list means.
    }
  }
  return disabled;
}
