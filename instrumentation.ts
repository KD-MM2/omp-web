import type { configureHttpDispatcher as ConfigureHttpDispatcher } from "@/lib/http-dispatcher";

type DispatcherModule = { configureHttpDispatcher: typeof ConfigureHttpDispatcher };

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole omp SDK, seconds on
  // Windows. Start that import now, unawaited so register() stays fast: it
  // overlaps the browser opening, and the routes reuse the cached module.
  // A failure is left for the routes' own import to report.
  import("@oh-my-pi/pi-coding-agent").catch(() => {});

  // Under `bun --bun next` undici is not the fetch stack, so the dispatcher
  // tuning only applies to real Node. Node 22 can load the local TypeScript
  // module directly; the dynamic string specifier keeps the Node-only undici
  // graph out of Next's browser/edge instrumentation bundles.
  if (typeof process.versions.bun === "string") return;

  const importRuntimeModule = Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<DispatcherModule>;
  const moduleUrl = `file://${encodeURI(process.cwd())}/lib/http-dispatcher.ts`;
  const { configureHttpDispatcher } = await importRuntimeModule(moduleUrl);
  await configureHttpDispatcher();
}
