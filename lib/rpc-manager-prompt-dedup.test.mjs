import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function makeInner(overrides = {}) {
  return {
    sessionId: "dedup-test-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    extensionRunner: {
      getRegisteredCommands: () => [],
      setUIContext: () => {},
      emit: async () => {},
    },
    promptTemplates: [],
    sessionManager: { getCwd: () => os.tmpdir() },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => [],
    getAllTools: () => [],
    setActiveToolsByName: () => {},
    pendingMessageCount: 0,
    dispose: () => {},
    abort: async () => {},
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("identical prompt arriving while the original is in flight is deduplicated", async () => {
  let resolveRun;
  let promptCalls = 0;
  const wrapper = new AgentSessionWrapper(makeInner({
    prompt: async (_text, options) => {
      promptCalls += 1;
      options?.preflightResult?.();
      await new Promise((resolve) => { resolveRun = resolve; });
    },
  }));
  try {
    const first = await wrapper.send({ type: "prompt", message: "same text" });
    assert.equal(first, null);
    assert.equal(promptCalls, 1);

    const second = await wrapper.send({ type: "prompt", message: "same text" });
    assert.deepEqual(second, { deduplicated: true });
    assert.equal(promptCalls, 1, "duplicate must not reach the SDK");
    resolveRun();
    await tick();
  } finally {
    resolveRun?.();
    wrapper.destroy();
  }
});

test("identical prompt right after a clean settle is deduplicated within the window", async () => {
  let promptCalls = 0;
  const wrapper = new AgentSessionWrapper(makeInner({
    prompt: async (_text, options) => {
      promptCalls += 1;
      options?.preflightResult?.();
    },
  }));
  try {
    await wrapper.send({ type: "prompt", message: "same text" });
    await tick();
    const second = await wrapper.send({ type: "prompt", message: "same text" });
    assert.deepEqual(second, { deduplicated: true });
    assert.equal(promptCalls, 1);

    const different = await wrapper.send({ type: "prompt", message: "other text" });
    assert.equal(different, null);
    assert.equal(promptCalls, 2, "different text must pass");
  } finally {
    wrapper.destroy();
  }
});

test("identical prompt passes once the dedup window has passed or Stop voided it", async () => {
  let promptCalls = 0;
  const wrapper = new AgentSessionWrapper(makeInner({
    prompt: async (_text, options) => {
      promptCalls += 1;
      options?.preflightResult?.();
    },
  }));
  try {
    await wrapper.send({ type: "prompt", message: "same text" });
    await tick();
    wrapper.promptDedupWindowMs = -1;
    assert.deepEqual(await wrapper.send({ type: "prompt", message: "same text" }), null);
    assert.equal(promptCalls, 2, "expired window must pass a deliberate retry");

    // Re-arm the fingerprint (window rule) so the post-Stop assertion proves Stop voids it.
    await wrapper.send({ type: "prompt", message: "same text" });
    await tick();
    wrapper.promptDedupWindowMs = 12_000;
    await wrapper.send({ type: "abort" });
    await tick();
    assert.deepEqual(await wrapper.send({ type: "prompt", message: "same text" }), null);
    assert.equal(promptCalls, 4, "post-Stop retry must pass even inside the window");
  } finally {
    wrapper.destroy();
  }
});

test("a rejected prompt does not poison later submissions of the same text", async () => {
  let promptCalls = 0;
  const wrapper = new AgentSessionWrapper(makeInner({
    prompt: async (_text, options) => {
      promptCalls += 1;
      if (promptCalls === 1) throw new Error("transient admission failure");
      options?.preflightResult?.();
    },
  }));
  try {
    await assert.rejects(
      wrapper.send({ type: "prompt", message: "same text" }),
      { message: "transient admission failure" },
    );
    await tick();
    assert.deepEqual(await wrapper.send({ type: "prompt", message: "same text" }), null);
    assert.equal(promptCalls, 2, "retry after rejection must reach the SDK");
  } finally {
    wrapper.destroy();
  }
});

test("steering a text the queue already holds is deduplicated", async () => {
  const steered = [];
  const wrapper = new AgentSessionWrapper(makeInner({
    getSteeringMessages: () => ["queued text"],
    steer: async (text) => { steered.push(text); },
  }));
  try {
    assert.deepEqual(await wrapper.send({ type: "steer", message: "queued text" }), { deduplicated: true });
    assert.equal(steered.length, 0, "queued duplicate must not re-enter the queue");
    assert.equal(await wrapper.send({ type: "steer", message: "new text" }), null);
    assert.deepEqual(steered, ["new text"]);
  } finally {
    wrapper.destroy();
  }
});

test("follow-up a text the queue already holds is deduplicated", async () => {
  const followed = [];
  const wrapper = new AgentSessionWrapper(makeInner({
    getFollowUpMessages: () => ["queued text"],
    followUp: async (text) => { followed.push(text); },
  }));
  try {
    assert.deepEqual(await wrapper.send({ type: "follow_up", message: "queued text" }), { deduplicated: true });
    assert.equal(followed.length, 0);
    assert.equal(await wrapper.send({ type: "follow_up", message: "new text" }), null);
    assert.deepEqual(followed, ["new text"]);
  } finally {
    wrapper.destroy();
  }
});
