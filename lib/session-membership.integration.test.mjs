import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() }, moduleCache: false });
const { invalidateSessionListCache } = await jiti.import('./session-reader.ts');
// The pi fork freezes its dirs resolver at import; env retargeting (the
// per-test scratch agent dir) needs an explicit refresh.
const { refreshDirsFromEnv } = await jiti.import('@oh-my-pi/pi-utils');
const { GET: list } = await jiti.import('../app/api/sessions/route.ts');
const { GET: running } = await jiti.import('../app/api/agent/running/route.ts');
// The fork ships `main: ./src/index.ts`; a bare specifier resolves it the same
// way the server does (bun runs the TS sources), unlike a guessed dist path.
const sdk = '@oh-my-pi/pi-coding-agent';

for (const mode of ['sessions-dir-present', 'sessions-dir-absent']) test(`independent SDK writes refresh cached lists (${mode})`, { timeout: 15000 }, async (t) => {
  const existingRoot = mode === 'sessions-dir-present';
  const dir = await mkdtemp(join(tmpdir(), 'pi-membership-api-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  refreshDirsFromEnv();
  invalidateSessionListCache();
  const requestList = async () => {
    const response = await list(new Request('http://test/api/sessions'));
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    if (existingRoot) await mkdir(join(dir, 'sessions'));
    const initial = await requestList();
    assert.deepEqual(initial.sessions, []);
    // The fork materializes a session file only once the history contains an
    // assistant message, and bun's writer streams asynchronously, so the
    // external writer must complete a turn and flush before exit.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { SessionManager } from ${JSON.stringify(sdk)};
      const sm = SessionManager.create(${JSON.stringify(dir)});
      sm.appendMessage({ role: 'user', content: 'external SDK writer', timestamp: Date.now() });
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'test', provider: 'test', model: 'test', usage: { input: 0, output: 0 }, stopReason: 'stop', timestamp: Date.now() });
      await sm.flush();
      console.log(sm.getSessionId());
    `], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 0, result.stderr);
    const id = result.stdout.trim();
    const persistedAt = Date.now();
    let snapshot;
    const deadline = Date.now() + 3000;
    do {
      snapshot = await (await running()).json();
      if (snapshot.sessionListVersion > initial.sessionListVersion) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.ok(snapshot.sessionListVersion > initial.sessionListVersion, 'disk change must advance the version without force refresh');
    t.diagnostic(`new file observed ${Date.now() - persistedAt}ms after external writer exited`);
    assert.deepEqual(snapshot.runningSessionIds, [], 'external SDK is not registered or started by Web');
    const updated = await requestList();
    assert.equal(updated.sessions.find(s => s.id === id)?.firstMessage, 'external SDK writer');
    const stable = updated.sessionListVersion;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await (await running()).json()).sessionListVersion, stable, 'reads must not create an invalidation loop');
    if (existingRoot) {
      const file = updated.sessions.find(s => s.id === id).path;
      for (const operation of ['append', 'delete']) {
        const before = (await (await running()).json()).sessionListVersion;
        const source = operation === 'append'
          ? `import { SessionManager } from ${JSON.stringify(sdk)}; const sm = await SessionManager.open(${JSON.stringify(file)}); sm.appendMessage({role:'user',content:'second message',timestamp:Date.now()}); await sm.flush();`
          : `import { unlinkSync } from 'node:fs'; unlinkSync(${JSON.stringify(file)});`;
        const writer = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: process.env });
        assert.equal(writer.status, 0, writer.stderr);
        if (operation === 'append') {
          await new Promise(resolve => setTimeout(resolve, 500));
          assert.equal((await (await running()).json()).sessionListVersion, before, 'appending output does not invalidate the catalogue');
        } else {
          const until = Date.now() + 3000;
          while ((await (await running()).json()).sessionListVersion === before && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          assert.ok((await (await running()).json()).sessionListVersion > before);
          assert.equal((await requestList()).sessions.find(s => s.id === id), undefined);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    refreshDirsFromEnv();
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  }
});
