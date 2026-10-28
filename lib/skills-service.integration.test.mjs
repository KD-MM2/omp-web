import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The skills listing (Settings › Skills, the chat slash palette) loads no
// extensions (#1226): they add skills only through `resources_discover` at
// session_start, which a listing never runs. Every extension below counts its
// import, and the listing must still show global, package and project skills.
//
// omp binds its roots (config root, plugin tree) to the home directory the
// process started with — Bun caches `os.homedir()` at startup, and the plugin
// discovery walks up from the process cwd — so redirecting HOME mid-process is
// not enough. The fixture therefore runs in a dedicated child bun spawned with
// a fixture HOME and a cwd outside the real home.
const REPO_ROOT = dirname(import.meta.dirname);
if (!process.env.OMP_SKILLS_FIXTURE_ROOT) {
  const root = await mkdtemp(join(tmpdir(), "omp-web-skills-service-"));
  await writeFixture(root);
  const child = spawnSync(process.execPath, ["test", import.meta.filename], {
    cwd: root,
    env: {
      ...process.env,
      OMP_SKILLS_FIXTURE_ROOT: root,
      HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_OFFLINE: "1",
    },
    stdio: "inherit",
  });
  await rm(root, { recursive: true, force: true });
  process.exit(child.status ?? 1);
}

function countedExtension(name) {
  return `
(globalThis as any).__ompWebSkillsTestImports ??= [];
(globalThis as any).__ompWebSkillsTestImports.push(${JSON.stringify(name)});
export default function (pi: any) {
  pi.on("resources_discover", () => ({ skillPaths: ["/never-reached-in-this-test"] }));
}
`;
}

async function skill(dir, name) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`);
}

// Writes the fixture tree for a given root. omp's package distribution is the
// `<home>/.omp/plugins` install tree (package.json + node_modules +
// omp-plugins.lock.json with a per-plugin `version`), not a settings key.
async function writeFixture(root) {
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const pluginsDir = join(home, ".omp", "plugins");
  const pkg = join(pluginsDir, "node_modules", "local-pkg");
  const trustedProject = join(root, "trusted");
  const untrustedProject = join(root, "untrusted");

  await mkdir(home, { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "global.ts"), countedExtension("global"));
  await skill(join(agentDir, "skills"), "global-skill");

  await mkdir(join(pkg, "extensions"), { recursive: true });
  await writeFile(join(pkg, "extensions", "index.ts"), countedExtension("package"));
  await skill(join(pkg, "skills"), "package-skill");
  await writeFile(join(pkg, "package.json"), JSON.stringify({
    name: "local-pkg",
    version: "1.0.0",
    pi: { skills: ["./skills"], extensions: ["./extensions"] },
  }));
  await writeFile(join(pluginsDir, "package.json"), JSON.stringify({
    name: "omp-plugins",
    private: true,
    dependencies: { "local-pkg": "1.0.0" },
  }));
  await writeFile(join(pluginsDir, "omp-plugins.lock.json"), JSON.stringify({
    plugins: { "local-pkg": { version: "1.0.0", enabledFeatures: null, enabled: true } },
    settings: {},
  }));

  for (const project of [trustedProject, untrustedProject]) {
    // omp scans `.omp` (not `.pi`), `.claude`, and `.agents` project roots.
    await mkdir(join(project, ".omp", "extensions"), { recursive: true });
    await writeFile(join(project, ".omp", "extensions", "project.ts"), countedExtension(project));
    await skill(join(project, ".omp", "skills"), "project-omp-skill");
    await skill(join(project, ".agents", "skills"), "project-agents-skill");
  }
}

const root = process.env.OMP_SKILLS_FIXTURE_ROOT;
const agentDir = join(root, "agent");
const trustedProject = join(root, "trusted");
const untrustedProject = join(root, "untrusted");

const jiti = createJiti(import.meta.url, {
  alias: { "@": REPO_ROOT },
  interopDefault: true,
  moduleCache: false,
});
const { loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");
const { trustProject } = await jiti.import("./project-trust.ts");
const { DefaultResourceLoader } = await import(
  "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim"
);

trustProject(trustedProject, agentDir);

const imports = () => globalThis.__ompWebSkillsTestImports ?? [];
const names = (skills) => skills.map((entry) => entry.name).sort();

test("the listing imports no extension and still lists global, package and trusted project skills", async () => {
  const listed = await loadSkillsWithInstallInfo(trustedProject);
  assert.deepEqual(imports(), []);
  assert.equal(listed.projectResourcesLoaded, true);
  assert.deepEqual(names(listed.skills), [
    "global-skill",
    "package-skill",
    "project-agents-skill",
    "project-omp-skill",
  ]);
});

test("an untrusted project's extensions are not imported by the listing", async () => {
  const listed = await loadSkillsWithInstallInfo(untrustedProject);
  assert.deepEqual(imports(), []);
  assert.equal(listed.projectResourcesLoaded, false);
  assert.ok(names(listed.skills).includes("global-skill"));
});

test("loading the extensions would list exactly the same skills", async () => {
  const listed = await loadSkillsWithInstallInfo(trustedProject);
  const withExtensions = new DefaultResourceLoader({ cwd: trustedProject, agentDir });
  // The shim loader re-derives trust from the same agent-dir state `trustProject`
  // wrote; it takes no reload options.
  await withExtensions.reload();
  assert.ok(imports().length > 0, "the full loader imports the extensions");
  const paths = (skills) => skills.map((entry) => [entry.name, entry.filePath]).sort();
  assert.deepEqual(paths(listed.skills), paths(withExtensions.getSkills().skills));
  // `resources_discover` runs only at session_start, which neither loader reaches.
  assert.ok(!names(listed.skills).includes("discovered-skill"));
});
