import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isBlockingExtensionUiRequest } from "../lib/browser-notifications.ts";
import { normalizeToolCalls } from "../lib/normalize.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true);
const callbacks = new Map();
const declarations = new Map();
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === "useCallback") {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(ast));
  }
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    declarations.set(node.name.text, node.getText(ast));
  }
  ts.forEachChild(node, collect);
}
collect(ast);

const callbackNames = [
  "closeEvents", "followSessionIdentity", "followRuntimeState", "cancelEventStreamGrace",
  "handleExtensionUiRequest", "handleAgentEvent", "connectEvents", "ensureEventsConnected", "applyContextUsage", "refreshContextUsage",
];
const helperNames = ["streamReducer", "EventStreamConnectionError"];
for (const name of callbackNames) assert.ok(callbacks.has(name), `Missing callback: ${name}`);
for (const name of helperNames) assert.ok(declarations.has(name), `Missing declaration: ${name}`);
// Compile the real callbacks together so their cross-callback calls, ordering and
// ownership guards stay production code. Only browser/network/React effects are doubles.
const { outputText } = ts.transpileModule([
  ...helperNames.map((name) => declarations.get(name)),
  ...callbackNames.map((name) => `const ${name} = ${callbacks.get(name)};`),
  `return { ${[...callbackNames, ...helperNames].join(", ")} };`,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });

const response = (data) => ({ ok: true, json: async () => data });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function track(promise) {
  const result = { status: "pending" };
  result.promise = promise.then(
    (value) => Object.assign(result, { status: "fulfilled", value }),
    (error) => Object.assign(result, { status: "rejected", error }),
  );
  return result;
}

function harness({ sessionId = "a", runtimeId = "runtime:r1" } = {}) {
  const sources = [];
  const effects = [];
  const requests = [];
  const replies = [];
  const timers = new Map();
  const state = { stream: { isStreaming: false, streamingMessage: null }, ExtensionDialog: null };
  let nextTimer = 0;
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = FakeEventSource.CONNECTING;
    closeCount = 0;
    constructor(url) { this.url = url; sources.push(this); }
    open() { this.readyState = FakeEventSource.OPEN; }
    frame(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
    close() { this.closeCount += 1; this.readyState = FakeEventSource.CLOSED; }
  }
  const bindings = {
    EventSource: FakeEventSource,
    isBlockingExtensionUiRequest,
    normalizeToolCalls,
    mountedRef: { current: true },
    sessionIdRef: { current: sessionId },
    runtimeIdRef: { current: runtimeId },
    identityDraftKeyRef: { current: sessionId },
    contextRequestRef: { current: 0 },
    contextUsageRequestIdRef: { current: 0 },
    promptRunIdRef: { current: 1 },
    modelSwitchPendingRef: { current: false },
    eventSourceRef: { current: null },
    eventSourceSessionIdRef: { current: null },
    eventSourceRuntimeIdRef: { current: null },
    eventConnectionAttemptRef: { current: null },
    eventStreamGraceGenerationRef: { current: 0 },
    eventStreamGraceActiveRef: { current: false },
    eventStreamGraceTimerRef: { current: null },
    handleAgentEventRef: { current: null },
    agentRunningRef: { current: false },
    sdkAgentActiveRef: { current: false },
    EVENT_STREAM_CONNECT_TIMEOUT_MS: 5_000,
    sessionHookMountedRef: { current: true },
    contextUsageAppliedIdRef: { current: 0 },
    opts: {},
    onSessionForked: (...args) => effects.push(["identity", ...args]),
    rememberSessionContinuation: (...args) => effects.push(["remember", ...args]),
    clearSessionContinuation: (...args) => effects.push(["clear", ...args]),
    onAttentionNeeded: (request) => effects.push(["attention", request]),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    // The fork polls the lightweight status URL (?systemPrompt=0); assertions track the path.
    agentStatusUrl: (id) => `/api/agent/${encodeURIComponent(id)}?systemPrompt=0`,
    fetch: async (url) => {
      requests.push(String(url).split("?")[0]);
      return replies.length ? replies.shift() : response({
        running: true,
        state: { sessionId: bindings.sessionIdRef.current, runtimeId: bindings.runtimeIdRef.current },
      });
    },
    dispatch: (action) => {
      effects.push(["dispatch", action]);
      state.stream = api.streamReducer(state.stream, action);
    },
  };
  for (const name of ["AgentRunning", "AgentPhase", "ExtensionDialog", "ExtensionCustomUi",
    "ExtensionStatuses", "ExtensionWidgets", "CurrentModelOverride", "ContextUsage"]) {
    bindings[`set${name}`] = (value) => {
      state[name] = typeof value === "function" ? value(state[name]) : value;
      effects.push([name, state[name]]);
    };
  }
  const api = new Function(...Object.keys(bindings), outputText)(...Object.values(bindings));
  bindings.handleAgentEventRef.current = api.handleAgentEvent;
  return {
    ...api, bindings, sources, effects, requests, replies, timers, state,
    runTimers(delay) {
      const selected = [...timers].filter(([, timer]) => timer.delay === delay);
      assert.ok(selected.length, `No timer scheduled for ${delay}ms`);
      for (const [id, timer] of selected) { timers.delete(id); timer.fn(); }
    },
  };
}

async function openRuntime(h, sessionId = "a", runtimeId = "runtime:r1") {
  const pending = track(h.connectEvents(sessionId));
  const stream = h.sources.at(-1);
  stream.open();
  stream.frame({ type: "connected", sessionId, runtimeId });
  await tick();
  assert.equal(pending.status, "fulfilled");
  assert.equal(pending.value.status, "connected");
  assert.equal(h.bindings.eventSourceRef.current, stream);
  return stream;
}

function assertOutputAndDialog(h, stream) {
  const message = { role: "assistant", content: [{ type: "text", text: "Replacement runtime is streaming" }] };
  const request = { type: "extension_ui_request", method: "confirm", id: "approval:r2", title: "Continue?", message: "Approve this step" };
  stream.frame({ type: "agent_start" });
  stream.frame({ type: "message_update", message });
  stream.frame(request);
  assert.equal(h.state.stream.isStreaming, true);
  assert.deepEqual(h.state.stream.streamingMessage, message);
  assert.deepEqual(h.state.ExtensionDialog, request);
  assert.deepEqual(h.effects.filter(([kind]) => kind === "attention"), [["attention", request]]);
}

for (const initialId of ["a", "b"]) {
  test(`expired OPEN ${initialId}→b stream reconnects through b before a prompt and delivers R2 output and UI`, async () => {
    const h = harness({ sessionId: initialId });
    const old = await openRuntime(h, initialId);
    h.replies.push(response({ running: false, state: { sessionId: "b" } }));
    let promptStarted = false;
    const sending = track(h.ensureEventsConnected(initialId).then(() => { promptStarted = true; }));
    await tick();
    assert.equal(old.readyState, 2, "expiry must close the old source even if it was OPEN");
    assert.equal(h.sources.length, 2, "expiry must reconnect instead of reusing old OPEN source");
    assert.equal(h.sources[1].url, "/api/agent/b/events");
    assert.equal(promptStarted, false);
    assert.equal(sending.status, "pending");
    const replacement = h.sources[1];
    replacement.open();
    await tick();
    assert.equal(promptStarted, false, "transport OPEN must not bypass the connected handshake");
    replacement.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
    await tick();
    assert.equal(sending.status, "fulfilled");
    assert.equal(promptStarted, true);
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
    assert.equal(h.bindings.eventSourceRef.current, replacement);
    // The initial connected frame and the reconnected one each read usage too;
    // the expiry discovery itself must be exactly one read of the old runtime.
    assert.deepEqual(h.requests, ["/api/agent/runtime%3Ar1", "/api/agent/runtime%3Ar1", "/api/agent/runtime%3Ar2"]);
    assertOutputAndDialog(h, replacement);
  });
}

for (const initialId of ["a", "b"]) {
  test(`expiry ${initialId}→b settles an old pending handshake immediately`, async () => {
    const h = harness({ sessionId: initialId });
    const oldAttempt = track(h.connectEvents(initialId));
    const old = h.sources[0];
    h.followSessionIdentity("b", null);
    await tick();
    assert.equal(oldAttempt.status, "fulfilled", "cancellation must not wait for the five-second timeout");
    assert.equal(oldAttempt.value.status, "closed");
    assert.equal(old.readyState, 2);
    assert.equal(h.timers.size, 0, "cancelled attempt must clear its timeout");
    const ensuring = track(h.ensureEventsConnected("b"));
    assert.equal(h.sources.at(-1).url, "/api/agent/b/events");
    const replacement = h.sources.at(-1);
    replacement.open();
    replacement.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
    await tick();
    assert.equal(ensuring.status, "fulfilled");
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  });
}

for (const phase of ["pending", "open"]) {
  test(`same-runtime A→B relocation preserves the ${phase} source`, async () => {
    const h = harness();
    const connection = track(h.connectEvents("a"));
    const original = h.sources[0];
    if (phase === "open") {
      original.open();
      original.frame({ type: "connected", sessionId: "a", runtimeId: "runtime:r1" });
      await tick();
    }
    h.followSessionIdentity("b", "runtime:r1");
    assert.equal(h.bindings.eventSourceRef.current, original);
    assert.equal(original.closeCount, 0);
    const ensuring = track(h.ensureEventsConnected("b"));
    await tick();
    assert.equal(h.sources.length, 1);
    if (phase === "pending") {
      assert.equal(ensuring.status, "pending");
      original.open();
      original.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
      await tick();
    }
    assert.equal(connection.status, "fulfilled");
    assert.equal(ensuring.status, "fulfilled");
    assert.equal(h.bindings.sessionIdRef.current, "b");
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r1");
    assert.equal(original.closeCount, 0);
  });
}

for (const phase of ["pending", "open"]) {
  test(`direct R1→R2 replacement invalidates the ${phase} R1 source`, async () => {
    const h = harness({ sessionId: "b" });
    const connection = track(h.connectEvents("b"));
    const old = h.sources[0];
    if (phase === "open") {
      old.open();
      old.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
      await tick();
    }
    h.followSessionIdentity("b", "runtime:r2");
    await tick();
    assert.equal(old.readyState, 2);
    assert.equal(h.bindings.eventSourceRef.current, null);
    if (phase === "pending") {
      assert.equal(connection.status, "fulfilled");
      assert.equal(connection.value.status, "closed");
    }
    const ensuring = track(h.ensureEventsConnected("b"));
    await tick();
    const replacement = h.sources.at(-1);
    assert.equal(replacement.url, "/api/agent/runtime%3Ar2/events");
    replacement.open();
    replacement.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
    await tick();
    assert.equal(ensuring.status, "fulfilled");
  });
}

test("queued messages from a superseded source cannot change identity, stream output or dialogs", async () => {
  const h = harness();
  const old = await openRuntime(h);
  h.followSessionIdentity("b", "runtime:r2");
  const current = await openRuntime(h, "b", "runtime:r2");
  assertOutputAndDialog(h, current);
  const before = structuredClone(h.state);
  h.effects.length = 0;
  // Keep invoking the detached callback, as a queued browser delivery can do.
  old.frame({ type: "connected", sessionId: "a", runtimeId: "runtime:r1" });
  old.frame({ type: "session_changed", sessionId: "stale", runtimeId: "runtime:r1" });
  old.frame({ type: "agent_start" });
  old.frame({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
  old.frame({ type: "extension_ui_request", method: "confirm", id: "stale", title: "Stale?" });
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.state, before);
  assert.equal(h.bindings.sessionIdRef.current, "b");
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.equal(h.bindings.eventSourceRef.current, current);
});

test("a fresh canonical null→R2 handshake retains its own source", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  const ensuring = track(h.ensureEventsConnected("b"));
  const current = h.sources[0];
  assert.equal(current.url, "/api/agent/b/events");
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
  await tick();
  assert.equal(ensuring.status, "fulfilled");
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.equal(h.bindings.eventSourceRef.current, current);
  assert.equal(h.bindings.eventSourceRuntimeIdRef.current, "runtime:r2");
  assert.equal(current.closeCount, 0);
});

for (const existingAttempt of [false, true]) {
  test(`${existingAttempt ? "pending reused" : "new"} OPEN stream times out without connected and never admits a prompt`, async () => {
    const h = harness({ sessionId: "b", runtimeId: null });
    if (existingAttempt) h.connectEvents("b");
    const ensuring = track(h.ensureEventsConnected("b"));
    await tick();
    const current = h.sources[0];
    current.open();
    h.runTimers(5_000);
    await tick();
    assert.notEqual(ensuring.status, "fulfilled", "OPEN without a connected frame cannot permit prompting");
    // A reused failed attempt may be retried once; that replacement must also
    // complete its own handshake rather than inheriting OPEN from the old one.
    if (ensuring.status === "pending") {
      assert.equal(h.sources.length, 2);
      h.sources[1].open();
      h.runTimers(5_000);
      await tick();
    }
    assert.equal(ensuring.status, "rejected");
    assert.equal(ensuring.error.name, "EventStreamConnectionError");
    assert.equal(ensuring.error.status, "timeout");
    assert.equal(h.bindings.eventSourceRef.current, null);
    assert.ok(h.sources.every((stream) => stream.readyState === 2));
  });
}

test("closeEvents immediately settles a pending attempt and clears all stream ownership", async () => {
  const h = harness();
  const pending = track(h.connectEvents("a"));
  h.closeEvents();
  await tick();
  assert.equal(pending.status, "fulfilled");
  assert.equal(pending.value.status, "closed");
  assert.equal(h.bindings.eventSourceRef.current, null);
  assert.equal(h.bindings.eventSourceSessionIdRef.current, null);
  assert.equal(h.bindings.eventSourceRuntimeIdRef.current, null);
  assert.equal(h.bindings.eventConnectionAttemptRef.current, null);
  assert.equal(h.timers.size, 0);
});

test("frames delivered after unmount are ignored even before source cleanup", async () => {
  const h = harness();
  const current = await openRuntime(h);
  h.effects.length = 0;
  h.bindings.mountedRef.current = false;
  current.frame({ type: "agent_start" });
  current.frame({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
  current.frame({ type: "extension_ui_request", method: "confirm", id: "late", title: "Late?" });
  assert.deepEqual(h.effects, []);
  assert.equal(h.state.stream.isStreaming, false);
  assert.equal(h.state.ExtensionDialog, null);
});

test("unmount cancels a pending ensure and cannot accept a queued connected frame", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  const ensuring = track(h.ensureEventsConnected("b"));
  const current = h.sources[0];
  h.bindings.mountedRef.current = false;
  h.closeEvents();
  h.effects.length = 0;
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
  await tick();
  assert.equal(ensuring.status, "rejected");
  assert.match(ensuring.error.message, /no longer active/);
  assert.equal(h.bindings.runtimeIdRef.current, null);
  assert.deepEqual(h.effects, []);
  assert.equal(h.timers.size, 0);
});

test("an ensure already awaiting R1 moves promptly to B after that handshake is cancelled", async () => {
  const h = harness();
  const oldAttempt = track(h.connectEvents("a"));
  const ensuring = track(h.ensureEventsConnected("a"));
  await tick();
  assert.equal(ensuring.status, "pending");
  assert.equal(h.sources.length, 1);
  h.followSessionIdentity("b", null);
  await tick();
  assert.equal(oldAttempt.status, "fulfilled");
  assert.equal(oldAttempt.value.status, "closed");
  assert.equal(h.sources.length, 2, "the awaiting ensure must continue without the old timeout");
  const current = h.sources[1];
  assert.equal(current.url, "/api/agent/b/events");
  assert.equal(ensuring.status, "pending");
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
  await tick();
  assert.equal(ensuring.status, "fulfilled");
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.equal(h.timers.size, 0);
});

test("an OPEN fire-and-forget source that timed out cannot satisfy a later ensure", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  const attempt = track(h.connectEvents("b"));
  const old = h.sources[0];
  old.open();
  h.runTimers(5_000);
  await tick();
  assert.equal(attempt.status, "fulfilled");
  assert.equal(attempt.value.status, "timeout");
  const ensuring = track(h.ensureEventsConnected("b"));
  await tick();
  assert.equal(ensuring.status, "pending", "a timeout is not a completed connected handshake");
  assert.equal(h.sources.length, 2);
  assert.equal(old.readyState, 2);
  const current = h.sources[1];
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
  await tick();
  assert.equal(ensuring.status, "fulfilled");
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
});

for (const connectedAgain of [false, true]) {
  test(`recoverable error followed by OPEN ${connectedAgain ? "and connected reuses" : "alone cannot reuse"} the source`, async () => {
    const h = harness({ sessionId: "b" });
    const original = await openRuntime(h, "b");
    original.readyState = 0;
    original.onerror();
    original.open();
    if (connectedAgain) original.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
    const ensuring = track(h.ensureEventsConnected("b"));
    await tick();
    if (connectedAgain) {
      assert.equal(ensuring.status, "fulfilled");
      assert.equal(h.sources.length, 1);
      assert.equal(original.closeCount, 0);
    } else {
      assert.equal(ensuring.status, "pending", "a reconnect must establish a fresh connected handshake");
      assert.equal(h.sources.length, 2);
      assert.equal(original.readyState, 2);
      const current = h.sources[1];
      current.open();
      current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
      await tick();
      assert.equal(ensuring.status, "fulfilled");
    }
  });
}

for (const transportOpen of [false, true]) {
  test(`state polling adopts its own ${transportOpen ? "OPEN" : "CONNECTING"} canonical stream and still waits for connected`, async () => {
    const h = harness({ sessionId: "b", runtimeId: null });
    let promptStarted = false;
    const sending = track(h.ensureEventsConnected("b").then(() => { promptStarted = true; }));
    const current = h.sources[0];
    if (transportOpen) current.open();
    const contextUsage = { percent: 20, contextWindow: 1000, tokens: 200 };
    h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2", contextUsage } }));
    await h.refreshContextUsage("b");
    await tick();
    assert.equal(current.closeCount, 0, "the state poll must not cancel its own canonical connection");
    assert.equal(h.bindings.eventSourceRef.current, current);
    assert.equal(h.bindings.eventSourceRuntimeIdRef.current, "runtime:r2");
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
    assert.deepEqual(h.state.ContextUsage, contextUsage, "the actual refresh callback must apply the state");
    assert.equal(sending.status, "pending");
    assert.equal(promptStarted, false);

    // A second poll is now addressed by R2. It must neither replace the source
    // nor count runtime discovery as a completed SSE handshake.
    h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2", contextUsage } }));
    await h.refreshContextUsage("b");
    await tick();
    assert.deepEqual(h.requests, ["/api/agent/b", "/api/agent/runtime%3Ar2"]);
    assert.equal(h.sources.length, 1);
    assert.equal(current.closeCount, 0);
    assert.equal(sending.status, "pending");
    assert.equal(promptStarted, false);

    current.open();
    current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
    await tick();
    assert.equal(sending.status, "fulfilled");
    assert.equal(promptStarted, true);
    assert.equal(h.bindings.eventSourceRef.current, current);
    assert.equal(h.sources.length, 1);
    assert.equal(h.timers.size, 0);
    assertOutputAndDialog(h, current);
  });
}

for (const [label, sourceId, selectedId, incomingId] of [
  ["a different source label", "a", "b", "b"],
  ["a newly selected session", "b", "c", "c"],
  ["a different incoming transcript", "b", "b", "c"],
]) {
  test(`state discovery cannot adopt a pending canonical source for ${label}`, async () => {
    const h = harness({ sessionId: "b", runtimeId: null });
    const connection = track(h.connectEvents(sourceId));
    const current = h.sources[0];
    h.bindings.sessionIdRef.current = selectedId;
    h.replies.push(response({ running: true, state: { sessionId: incomingId, runtimeId: "runtime:r2" } }));
    await h.refreshContextUsage(selectedId);
    await tick();
    assert.equal(connection.status, "fulfilled");
    assert.equal(connection.value.status, "closed");
    assert.equal(current.readyState, 2);
    assert.equal(h.bindings.eventSourceRef.current, null);
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
    assert.equal(h.bindings.sessionIdRef.current, incomingId);
    assert.equal(h.timers.size, 0);
  });
}

for (const handshakeComplete of [false, true]) {
  test(`state discovery still invalidates a ${handshakeComplete ? "connected" : "pending"} source already bound to R1`, async () => {
    const h = harness({ sessionId: "b" });
    const connection = track(h.connectEvents("b"));
    const current = h.sources[0];
    if (handshakeComplete) {
      current.open();
      current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
      await tick();
    }
    h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2" } }));
    await h.refreshContextUsage("b");
    await tick();
    // A completed handshake reads usage on connect; the discovery read follows.
    assert.deepEqual(h.requests, handshakeComplete ? ["/api/agent/runtime%3Ar1", "/api/agent/runtime%3Ar1"] : ["/api/agent/runtime%3Ar1"]);
    assert.equal(current.readyState, 2);
    assert.equal(h.bindings.eventSourceRef.current, null);
    assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
    assert.equal(connection.status, "fulfilled");
    assert.equal(connection.value.status, handshakeComplete ? "connected" : "closed");
  });
}

test("state discovery cannot adopt an unbound source whose pending handshake already timed out", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  const connection = track(h.connectEvents("b"));
  const current = h.sources[0];
  current.open();
  h.runTimers(5_000);
  await tick();
  assert.equal(connection.value.status, "timeout");
  h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2" } }));
  await h.refreshContextUsage("b");
  await tick();
  assert.equal(current.readyState, 2);
  assert.equal(h.bindings.eventSourceRef.current, null);
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
});

test("a conflicting first handshake after R2 adoption cannot roll back identity or admit a prompt", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  let promptStarted = false;
  const sending = track(h.ensureEventsConnected("b").then(() => { promptStarted = true; }));
  const current = h.sources[0];
  h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2" } }));
  await h.refreshContextUsage("b");
  await tick();
  assert.equal(h.bindings.eventSourceRef.current, current, "R2 discovery must preserve the pending source");
  assert.equal(sending.status, "pending");
  h.effects.length = 0;
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
  await tick();
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.equal(current.readyState, 2);
  assert.notEqual(sending.status, "fulfilled");
  assert.equal(promptStarted, false);
  assert.deepEqual(h.effects, [], "a conflicting handshake must not reach the identity callback");
});

test("a source initially bound to R2 also rejects a conflicting first R1 handshake", async () => {
  const h = harness({ sessionId: "b", runtimeId: "runtime:r2" });
  let promptStarted = false;
  const sending = track(h.ensureEventsConnected("b").then(() => { promptStarted = true; }));
  await tick();
  const current = h.sources[0];
  assert.equal(current.url, "/api/agent/runtime%3Ar2/events");
  h.effects.length = 0;
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
  await tick();
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.equal(current.readyState, 2);
  assert.notEqual(sending.status, "fulfilled");
  assert.equal(promptStarted, false);
  assert.deepEqual(h.effects, []);
});

test("an adopted source still rejects its conflicting first frame after its promise timed out", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  const connection = track(h.connectEvents("b"));
  const current = h.sources[0];
  current.open();
  h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2" } }));
  await h.refreshContextUsage("b");
  await tick();
  assert.equal(h.bindings.eventSourceRef.current, current);
  h.runTimers(5_000);
  await tick();
  assert.equal(connection.value.status, "timeout");
  assert.equal(current.closeCount, 0);
  h.effects.length = 0;
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r1" });
  await tick();
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r2");
  assert.equal(current.readyState, 2);
  assert.equal(h.bindings.eventSourceRef.current, null);
  assert.deepEqual(h.effects, []);

  const ensuring = track(h.ensureEventsConnected("b"));
  await tick();
  assert.equal(ensuring.status, "pending");
  const replacement = h.sources[1];
  assert.equal(replacement.url, "/api/agent/runtime%3Ar2/events");
  replacement.open();
  replacement.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
  await tick();
  assert.equal(ensuring.status, "fulfilled");
});

test("a canonical source can discover R3 on a later reconnect after accepting its first R2 handshake", async () => {
  const h = harness({ sessionId: "b", runtimeId: null });
  const connection = track(h.connectEvents("b"));
  const current = h.sources[0];
  h.replies.push(response({ running: true, state: { sessionId: "b", runtimeId: "runtime:r2" } }));
  await h.refreshContextUsage("b");
  await tick();
  assert.equal(h.bindings.eventSourceRef.current, current);
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r2" });
  await tick();
  assert.equal(connection.value.status, "connected");
  current.readyState = 0;
  current.onerror();
  current.open();
  current.frame({ type: "connected", sessionId: "b", runtimeId: "runtime:r3" });
  await tick();
  assert.equal(h.bindings.runtimeIdRef.current, "runtime:r3");
  assert.equal(h.bindings.eventSourceRuntimeIdRef.current, "runtime:r3");
  assert.equal(h.bindings.eventSourceRef.current, current);
  assert.equal(current.closeCount, 0);
  const ensuring = track(h.ensureEventsConnected("b"));
  await tick();
  assert.equal(ensuring.status, "fulfilled");
  assert.equal(h.sources.length, 1);
});
