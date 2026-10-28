import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-models-config-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
refreshDirsFromEnv();

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const modelsPath = join(testAgentDir, "models.json");
// The fork route keeps `models.yml` as its canonical write target and the fork
// SDK caches model discovery in a SQLite db beside the config; the registry
// fixtures below pin those paths.
const modelsWritePath = join(testAgentDir, "models.yml");
const modelsStorePath = join(testAgentDir, "models-store.db");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  refreshDirsFromEnv();
  await rm(testAgentDir, { recursive: true, force: true });
});

function put(body) {
  return new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

function get() {
  return new Request("http://localhost/api/models-config", { headers: { Host: "localhost" } });
}

test("a models.json with a syntax error is reported instead of read as empty, and a save cannot replace it", async () => {
  const original = '{ "providers": { "acme": { "models": [ } } }';
  await writeFile(modelsPath, original);

  let response = await GET(get());
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /models\.json/);

  response = await PUT(put({ providers: {} }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /models\.json/);
  assert.equal(await readFile(modelsPath, "utf8"), original);
});

test("a commented models.json loads with its providers", async () => {
  await writeFile(modelsPath, '{\n  // local models\n  "providers": { "acme": { "models": [{ "id": "a" },] } },\n}\n');

  const response = await GET(get());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { providers: { acme: { models: [{ id: "a" }] } } });
});

test("invalid context overrides are rejected without changing the saved configuration", async () => {
  const config = { providers: { "openai-codex": { modelOverrides: { "gpt-6-astra": { contextWindow: 500000 } } } } };
  await writeFile(modelsPath, JSON.stringify(config));
  const invalid = structuredClone(config);
  invalid.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow = 0;
  const response = await PUT(put(invalid));
  assert.equal(response.status, 400);
  assert.deepEqual(await (await GET(get())).json(), config);
});

test("saved login-model context overrides reach the SDK; resetting restores the catalog without changing credentials", async () => {
  const { discoverAuthStorage, ModelRegistry } = await import("@oh-my-pi/pi-coding-agent");
  const authPath = join(testAgentDir, "auth.json");
  const credentials = JSON.stringify({ "openai-codex": { type: "oauth", access: "test-only", refresh: "test-only", expires: 9999999999999 } });
  await writeFile(authPath, credentials);
  // Fork SDK equivalent of `ModelRuntime.create({ authPath, modelsPath, modelsStorePath, refreshOnCreate: false })`:
  // AuthStorage pinned to the test agent dir (auth.json is its default store
  // location), the registry pinned to the file the route writes (models.yml)
  // and its discovery cache; refresh("offline", { refreshCommandCredentials })
  // forces a fresh parse of the config, so each construction sees the file as
  // saved even though the SDK caches the parsed models.yml per path.
  const authStorage = await discoverAuthStorage(testAgentDir);
  const createRegistry = () => new ModelRegistry(authStorage, modelsWritePath, { cacheDbPath: modelsStorePath });
  const config = { providers: { "openai-codex": { modelOverrides: { "gpt-6-astra": { contextWindow: "500000", maxTokens: 128000 } } } } };
  assert.equal((await PUT(put(config))).status, 200);
  const saved = await (await GET(get())).json();
  assert.equal(saved.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow, 500000);
  const registry = createRegistry();
  await registry.refresh("offline", { refreshCommandCredentials: true });
  assert.equal(registry.find("openai-codex", "gpt-6-astra").contextWindow, 500000);
  delete config.providers["openai-codex"].modelOverrides["gpt-6-astra"].contextWindow;
  assert.equal((await PUT(put(config))).status, 200);
  const reset = createRegistry();
  await reset.refresh("offline", { refreshCommandCredentials: true });
  // Fork equivalent of a registry built with `modelsPath: null`: ignore the
  // local config file entirely so only the built-in catalog resolves.
  const baseline = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
  await baseline.refresh("offline", { refreshCommandCredentials: true });
  assert.equal(reset.find("openai-codex", "gpt-6-astra").contextWindow, baseline.find("openai-codex", "gpt-6-astra").contextWindow);
  assert.equal(reset.find("openai-codex", "gpt-6-astra").maxTokens, 128000);
  assert.equal(await readFile(authPath, "utf8"), credentials);
});

test("a hand-edited override pi accepts does not block saving an unrelated provider", async () => {
  const { discoverAuthStorage, ModelRegistry } = await import("@oh-my-pi/pi-coding-agent");
  const config = { providers: {
    "openai-codex": { modelOverrides: { "gpt-6-astra": { contextWindow: 400000.5 } } },
    relay: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "TEST_ONLY_KEY", models: [{ id: "a" }] },
  } };
  await writeFile(modelsPath, JSON.stringify(config));
  // Fork SDK equivalent of `ModelRuntime.create({ authPath, modelsPath, modelsStorePath, refreshOnCreate: false })`
  // pointed at the hand-edited legacy models.json: the fork registry reads pi's
  // JSONC format from an explicit path, while the route keeps models.yml as its
  // write target.
  const registry = new ModelRegistry(await discoverAuthStorage(testAgentDir), modelsPath, { cacheDbPath: modelsStorePath });
  await registry.refresh("offline", { refreshCommandCredentials: true });
  assert.equal(registry.getError(), undefined);
  assert.equal(registry.find("openai-codex", "gpt-6-astra").contextWindow, 400000.5);
  const edited = structuredClone(config);
  edited.providers.relay.models.push({ id: "b" });
  const response = await PUT(put(edited));
  assert.equal(response.status, 200);
  assert.deepEqual(await (await GET(get())).json(), edited);
});

test("model-level endpoints round-trip through Save, override only that model, and can return to inheritance", async () => {
  const { discoverAuthStorage, ModelRegistry } = await import("@oh-my-pi/pi-coding-agent");
  const config = { providers: { relay: {
    baseUrl: "https://synthetic.invalid", api: "anthropic-messages", apiKey: "synthetic-not-a-key",
    models: [
      { id: "one", api: "openai-responses", baseUrl: "https://synthetic.invalid/v1", headers: { "x-example": "keep" } },
      { id: "two" },
    ],
  } } };
  // Fork SDK equivalent of `ModelRuntime.create(...)`: the registry reads the
  // fork route's write target (models.yml) after each Save.
  const authStorage = await discoverAuthStorage(testAgentDir);
  const createRegistry = () => new ModelRegistry(authStorage, modelsWritePath, { cacheDbPath: modelsStorePath });
  assert.equal((await PUT(put(config))).status, 200);
  assert.deepEqual(await (await GET(get())).json(), config);
  const registry = createRegistry();
  await registry.refresh("offline", { refreshCommandCredentials: true });
  assert.equal(registry.getError(), undefined);
  assert.equal(registry.find("relay", "one").baseUrl, "https://synthetic.invalid/v1");
  assert.equal(registry.find("relay", "two").baseUrl, "https://synthetic.invalid");
  assert.equal(registry.find("relay", "two").api, "anthropic-messages");
  delete config.providers.relay.models[0].baseUrl;
  assert.equal((await PUT(put(config))).status, 200);
  assert.deepEqual(await (await GET(get())).json(), config);
  const reset = createRegistry();
  await reset.refresh("offline", { refreshCommandCredentials: true });
  assert.equal(reset.find("relay", "one").baseUrl, "https://synthetic.invalid");
  assert.equal(reset.find("relay", "one").api, "openai-responses");
});
