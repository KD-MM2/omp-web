import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readRegularFileText } from "./regular-file";
import type * as Undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
type UndiciModule = typeof Undici;

type DispatcherGlobal = typeof globalThis & {
  __ompWebHttpDispatcherConfigured?: boolean;
  __ompWebHttpDispatcherConfiguring?: Promise<void>;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const originalGlobalFetch = globalThis.fetch;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * The agent directory omp keeps its global `settings.json` in, resolved the
 * way the fork SDK's `getAgentDir()` resolves it (its `DirResolver`): a named
 * profile (`OMP_PROFILE`, else `PI_PROFILE`) wins and pins
 * `~/.omp/profiles/<name>/agent`; otherwise `PI_CODING_AGENT_DIR` is used
 * after `path.resolve()`; otherwise `~/.omp/agent`. Resolved here instead of
 * through the SDK because this module runs in Next.js instrumentation:
 * importing the SDK there costs about a second of startup time, while
 * `undici` costs a tenth of one. The opt-in XDG-migrated layout is not
 * mirrored; the SDK remains the source of truth for it.
 */
export function defaultAgentDir(): string {
  const profile = normalizeProfileName(process.env.OMP_PROFILE ?? process.env.PI_PROFILE);
  if (profile) return join(homedir(), ".omp", "profiles", profile, "agent");
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) return resolve(configured);
  return join(homedir(), ".omp", "agent");
}

/** `pi-utils`' normalizeProfileName(), minus the throw: invalid names fall back to the default profile. */
function normalizeProfileName(profile: string | undefined): string | undefined {
  const normalized = profile?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized) || normalized.includes("..") || normalized.endsWith(".")) {
    return undefined;
  }
  return normalized;
}


/**
 * The global `httpIdleTimeoutMs`, read the way the pi CLI reads it, so a Web UI
 * session gets the HTTP idle timeout the user configured instead of the
 * built-in default. Only the global file counts: the dispatcher is configured
 * once at startup, before any project is selected, so a project's
 * `.pi/settings.json` cannot apply here.
 *
 * A missing file, a file that does not parse, an absent key, or a value the CLI
 * would reject yields `undefined`, which leaves `configureHttpDispatcher`'s own
 * default in place.
 */
export function readHttpIdleTimeoutMs(agentDir: string = defaultAgentDir()): number | undefined {
  let text: string | undefined;
  try {
    text = readRegularFileText(join(agentDir, "settings.json"));
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;

  let settings: unknown;
  try {
    settings = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  if (typeof settings !== "object" || settings === null) return undefined;

  return parseHttpIdleTimeoutMs((settings as { httpIdleTimeoutMs?: unknown }).httpIdleTimeoutMs);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends Undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(
  undici: UndiciModule,
  origin: string | URL,
  options: object,
): Undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as Undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(
  undici: UndiciModule,
  origin: string | URL,
  options: object,
): Undici.Dispatcher {
  const dispatcherOptions = options as Undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(undici, origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: (factoryOrigin, factoryOptions) =>
        createUndiciClient(undici, factoryOrigin, factoryOptions),
    }),
  );
}

/**
 * Whether the process is running on Bun's runtime.
 *
 * Bun ships its own `undici` module: `setGlobalDispatcher` there does not affect
 * `fetch`, and `install` does not exist. Bun's native `fetch` already honors
 * `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` read at process start, so the
 * dispatcher dance is both ineffective and unnecessary under Bun — which is the
 * runtime `omp-web` actually serves on.
 */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === "string";
}

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): void | Promise<void> {
  if (dispatcherGlobal.__ompWebHttpDispatcherConfigured) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  if (isBunRuntime()) {
    dispatcherGlobal.__ompWebHttpDispatcherConfigured = true;
    return;
  }

  if (dispatcherGlobal.__ompWebHttpDispatcherConfiguring) {
    return dispatcherGlobal.__ompWebHttpDispatcherConfiguring;
  }

  const configuring = import("undici")
    .then((undici) => {
      const dispatcher = withUndiciErrorListener(
        new undici.EnvHttpProxyAgent({
          allowH2: false,
          bodyTimeout: normalizedTimeoutMs,
          headersTimeout: normalizedTimeoutMs,
          clientFactory: (origin, options) =>
            createUndiciClient(undici, origin, options),
          factory: (origin, options) =>
            createUndiciOriginDispatcher(undici, origin, options),
        }),
      );
      undici.setGlobalDispatcher(dispatcher);

      // Keep fetch and the dispatcher on the same undici implementation.
      // Preserve an intentional fetch override installed after module load.
      if (globalThis.fetch === originalGlobalFetch) {
        undici.install?.();
      }

      dispatcherGlobal.__ompWebHttpDispatcherConfigured = true;
    })
    .finally(() => {
      delete dispatcherGlobal.__ompWebHttpDispatcherConfiguring;
    });
  dispatcherGlobal.__ompWebHttpDispatcherConfiguring = configuring;
  return configuring;
}
