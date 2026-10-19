import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../lib/agent-client.ts", import.meta.url), "utf8");
const memorySource = await readFile(new URL("../lib/workspace-memory.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
const callbacks = new Map();
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === "useCallback") {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(ast));
  }
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === "runtimeIdRef.onIdentity") {
    callbacks.set("onIdentity", node.right.getText(ast));
  }
  ts.forEachChild(node, collect);
}
collect(ast);

// Run production callback bodies and modules, removing TypeScript syntax only.
// All identity/retry/storage decisions remain in production code. Each harness
// gets its own fetch and sessionStorage, without patching shared browser globals.
function callback(name, bindings) {
  assert.ok(callbacks.has(name), `Missing callback: ${name}`);
  const { outputText } = ts.transpileModule(`const callback = ${callbacks.get(name)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(bindings), `${outputText}\nreturn callback;`)(...Object.values(bindings));
}

function productionModule(source, bindings, dependencies = {}) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  const require = (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  };
  new Function("exports", "require", ...Object.keys(bindings), outputText)(
    exports, require, ...Object.values(bindings),
  );
  return exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const context = (label, identity = { sessionId: "b", runtimeId: "runtime:r1" }) => ({
  ...identity,
  context: {
    messages: [{ role: "user", content: label }],
    entryIds: [`${label}-entry`],
  },
  contextUsage: { percent: 73, contextWindow: 1000, tokens: 730 },
});

function harness() {
  const effects = [];
  const storage = new Map();
  const memory = productionModule(memorySource, {
    window: { sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); effects.push(["storage:set", key, value]); },
      removeItem: (key) => { storage.delete(key); effects.push(["storage:remove", key]); },
    } },
  });
  memory.rememberSessionContinuation("b", "runtime:r1");
  effects.length = 0;
  const ui = {
    Messages: [{ role: "user", content: "current messages" }],
    EntryIds: ["current-entry"],
    ContextUsage: { percent: 10, contextWindow: 1000, tokens: 100 },
    ActiveLeafId: "current-leaf",
  };
  const bindings = {
    mountedRef: { current: true },
    sessionIdRef: { current: "b" },
    runtimeIdRef: { current: "runtime:r1" },
    identityDraftKeyRef: { current: "b" },
    contextRequestRef: { current: 0 },
    eventSourceRef: { current: null },
    eventSourceSessionIdRef: { current: "b" },
    eventSourceRuntimeIdRef: { current: null },
    bashRunningRef: { current: false },
    opts: {},
    closeEvents: () => effects.push(["closeEvents"]),
    onSessionForked: (...args) => effects.push(["identity", ...args]),
    rememberSessionContinuation: memory.rememberSessionContinuation,
    clearSessionContinuation: memory.clearSessionContinuation,
    console: { error: (...args) => effects.push(["error", ...args]) },
    fetch: () => { throw new Error("Unexpected request"); },
  };
  for (const field of Object.keys(ui)) {
    bindings[`set${field}`] = (value) => {
      ui[field] = value;
      effects.push([field, value]);
    };
  }
  const client = productionModule(clientSource, { fetch: (...args) => bindings.fetch(...args) }, {
    "./workspace-memory": memory,
  });
  const commands = [];
  bindings.canApplySessionIdentity = client.canApplySessionIdentity;
  bindings.sendAgentCommand = (...args) => {
    const command = client.sendAgentCommand(...args);
    commands.push(command);
    return command;
  };
  bindings.followSessionIdentity = callback("followSessionIdentity", bindings);
  bindings.runtimeIdRef.onIdentity = callback("onIdentity", bindings);
  // Use an indirection only for fetch so responses can be scheduled per test.
  const callbackBindings = { ...bindings, fetch: (...args) => bindings.fetch(...args) };
  bindings.loadContext = callback("loadContext", callbackBindings);
  bindings.handleNavigate = callback("handleNavigate", bindings);
  return { bindings, commands, effects, memory, storage, ui };
}

function snapshot(h) {
  return structuredClone({
    sessionId: h.bindings.sessionIdRef.current,
    runtimeId: h.bindings.runtimeIdRef.current,
    storage: [...h.storage],
    ui: h.ui,
  });
}

for (const [label, identity] of [
  ["explicit null runtime", { sessionId: "b", runtimeId: null }],
  ["missing runtime", { sessionId: "b" }],
  ["old live runtime", { sessionId: "b", runtimeId: "runtime:r1" }],
]) {
  test(`navigation ignores delayed context with ${label} after its command reopens B/R2`, async () => {
    const h = harness();
    const expiredCommand = deferred();
    const oldContext = deferred();
    const contextRequested = deferred();
    const requests = [];
    h.bindings.fetch = async (url, options) => {
      requests.push({ url, command: options ? JSON.parse(options.body) : null });
      if (url === "/api/agent/runtime%3Ar1") return expiredCommand.promise;
      if (url === "/api/agent/b") {
        return response({ success: true, data: {}, sessionId: "b", runtimeId: "runtime:r2" });
      }
      assert.equal(url, "/api/sessions/runtime%3Ar1/context?deferThinking=1&deferMedia=1&leafId=old-leaf");
      return { ok: true, json: () => { contextRequested.resolve(); return oldContext.promise; } };
    };

    const navigating = h.bindings.handleNavigate("old-leaf");
    await contextRequested.promise;
    expiredCommand.resolve(response({
      error: "Runtime session expired", code: "runtime_expired", accepted: false, sessionId: "b",
    }, 404));
    await Promise.all(h.commands);
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
    assert.equal(h.memory.getSessionContinuation("b"), "runtime:r2");
    assert.equal(h.bindings.contextRequestRef.current, 1, "same-transcript reopening keeps the context request number");
    assert.deepEqual(requests, [
      { url: "/api/agent/runtime%3Ar1", command: { type: "navigate_tree", targetId: "old-leaf" } },
      { url: "/api/sessions/runtime%3Ar1/context?deferThinking=1&deferMedia=1&leafId=old-leaf", command: null },
      { url: "/api/agent/b", command: { type: "navigate_tree", targetId: "old-leaf" } },
    ]);
    const reopened = snapshot(h);
    h.effects.length = 0;

    // The response body completes only after the production expiry retry has
    // rebound the same transcript to R2 and persisted that continuation.
    oldContext.resolve(context("obsolete branch", identity));
    await navigating;
    assert.deepEqual(snapshot(h), reopened, "stale context must not clear R2 or replace its UI/storage");
    assert.deepEqual(h.effects, [], "stale context must not notify the parent or invoke any setter");
  });
}

test("an owned expired runtime still clears its continuation and applies historical context", async () => {
  const h = harness();
  const historical = context("historical", { sessionId: "b", runtimeId: null });
  h.bindings.fetch = async () => response(historical);
  assert.equal(await h.bindings.loadContext("b", null), true);
  assert.equal(h.bindings.runtimeIdRef.current, null);
  assert.equal(h.memory.getSessionContinuation("b"), undefined);
  assert.deepEqual(h.ui.Messages, historical.context.messages);
  assert.deepEqual(h.ui.EntryIds, historical.context.entryIds);
  assert.deepEqual(h.ui.ContextUsage, historical.contextUsage);
  assert.ok(h.effects.some(([kind, sessionId, runtimeId]) => kind === "identity" && sessionId === "b" && runtimeId === null));
});

test("a same-runtime context response still applies its messages, entry IDs and usage", async () => {
  const h = harness();
  const current = context("owned branch");
  h.bindings.fetch = async () => response(current);
  assert.equal(await h.bindings.loadContext("b", "owned-leaf"), true);
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r1");
  assert.equal(h.memory.getSessionContinuation("b"), "runtime:r1");
  assert.deepEqual(h.ui.Messages, current.context.messages);
  assert.deepEqual(h.ui.EntryIds, current.context.entryIds);
  assert.deepEqual(h.ui.ContextUsage, current.contextUsage);
  assert.equal(h.effects.some(([kind]) => kind === "identity" || kind === "storage:remove"), false);
});

test("an owned same-runtime relocation still follows its new transcript", async () => {
  const h = harness();
  const relocated = context("relocated", { sessionId: "c", runtimeId: "runtime:r1" });
  h.bindings.fetch = async () => response(relocated);
  assert.equal(await h.bindings.loadContext("b", "owned-leaf"), true);
  assert.equal(h.bindings.sessionIdRef.current, "c");
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r1");
  assert.equal(h.memory.getSessionContinuation("c"), "runtime:r1");
  assert.deepEqual(h.ui.Messages, relocated.context.messages);
});

test("a newer context request owns the UI even when the runtime stays the same", async () => {
  const h = harness();
  const older = deferred();
  const requested = deferred();
  const latest = context("latest branch");
  h.bindings.fetch = async (url) => {
    if (url.endsWith("leafId=old-leaf")) {
      return { ok: true, json: () => { requested.resolve(); return older.promise; } };
    }
    assert.ok(url.endsWith("leafId=latest-leaf"));
    return response(latest);
  };
  const loadingOld = h.bindings.loadContext("b", "old-leaf");
  await requested.promise;
  assert.equal(await h.bindings.loadContext("b", "latest-leaf"), true);
  assert.deepEqual(h.ui.Messages, latest.context.messages);
  const newest = snapshot(h);
  h.effects.length = 0;
  older.resolve(context("obsolete", { sessionId: "b", runtimeId: null }));
  assert.equal(await loadingOld, false);
  assert.deepEqual(snapshot(h), newest);
  assert.deepEqual(h.effects, []);
});

for (const superseded of ["different session selection", "unmount"]) {
  test(`context does not apply after ${superseded}`, async () => {
    const h = harness();
    const older = deferred();
    const requested = deferred();
    h.bindings.fetch = async () => ({
      ok: true, json: () => { requested.resolve(); return older.promise; },
    });
    const loading = h.bindings.loadContext("b", "old-leaf");
    await requested.promise;
    if (superseded === "unmount") h.bindings.mountedRef.current = false;
    else h.bindings.followSessionIdentity("c", "runtime:r2");
    const current = snapshot(h);
    h.effects.length = 0;
    older.resolve(context("obsolete", { sessionId: "b", runtimeId: null }));
    assert.equal(await loading, false);
    assert.deepEqual(snapshot(h), current);
    assert.deepEqual(h.effects, []);
  });
}
