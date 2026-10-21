import assert from "node:assert/strict";
import test from "node:test";
import manifest, { dynamic } from "./manifest.ts";

test("manifest reads the app name at runtime without changing other metadata", () => {
  const original = process.env.OMP_WEB_APP_NAME;
  try {
    assert.equal(dynamic, "force-dynamic");
    delete process.env.OMP_WEB_APP_NAME;
    const defaults = manifest();
    assert.equal(defaults.name, "omp-web");
    assert.equal(defaults.short_name, "omp-web");

    // Reuse the same imported function: the environment must not be captured
    // at module load time (or baked into a statically generated manifest).
    for (const [value, expected] of [
      ["", "omp-web"],
      [" \t\n ", "omp-web"],
      ["Work omp", "Work omp"],
      ["  工作 omp 🚀 \n", "工作 omp 🚀"],
      ["Another omp", "Another omp"],
    ]) {
      process.env.OMP_WEB_APP_NAME = value;
      assert.deepEqual(manifest(), {
        ...defaults,
        name: expected,
        short_name: expected,
      });
    }
  } finally {
    if (original === undefined) delete process.env.OMP_WEB_APP_NAME;
    else process.env.OMP_WEB_APP_NAME = original;
  }
});
