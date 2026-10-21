# Release Checklist

This repo publishes two artifacts for each release:

- npm package: `omp-web`
- GitHub Release: `ddallabenetta/omp-web`

Use this checklist from a clean `main` checkout.

## Automated npm publishing

Pushing a version tag matching `v*` starts
`.github/workflows/publish-npm.yml`. The workflow:

1. Checks that the tag version matches `package.json`.
2. Installs dependencies with Bun and runs the production build.
3. Publishes `omp-web` to npm with provenance.

Before the first release, configure npm trusted publishing for
`ddallabenetta/omp-web`:

- workflow file: `.github/workflows/publish-npm.yml`
- GitHub environment: `npm`
- publisher: GitHub Actions

The npm package must be configured to trust this repository and workflow, and
the repository's `npm` environment must permit the release job to run. No npm
token is stored in GitHub Actions.


## Automated omp dependency releases

`.github/workflows/update-omp.yml` checks the latest stable `oh-my-pi` release
and opens a dependency PR when the runtime packages change. The PR also bumps
the `omp-web` version: a patch for a refresh within the same `oh-my-pi` major,
a minor when the major changes (omp-web serves omp's own SDK in-process, so a
new major moves that surface under its users too). After that PR is merged, the
workflow creates the matching `v<version>` GitHub tag and release, with the
updated `oh-my-pi` version in the release notes, then dispatches the npm publish
workflow for that tag.

The workflow verifies the bump with `bun run typecheck` and `bun test` before
opening the PR, but a failure there does not fail the run: a breaking upstream
release is exactly when the update most needs to be seen, so the PR is opened as
a **draft** carrying the failure instead. Take the draft, make omp-web compatible
on that branch, then mark it ready. A release tagged upstream but not yet on npm
is likewise not a failure — the hourly schedule retries it.

## 1. Preflight

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git rev-list --left-right --count main...origin/main
gh auth status
npm whoami
bun --version   # the published .next is built with Bun; engines.bun requires 1.3.14+
node -e "const p=require('./package.json'); console.log(p.version)"
lsof -nP -iTCP:30141 -sTCP:LISTEN
ls .next/server/route-cache
```

Expected:

- `git status` is clean, or only contains changes you intentionally plan to release.
- `main` and `origin/main` are aligned (`0	0`).
- GitHub is authenticated as an account that can push and create releases.
- npm is authenticated as an account that can publish `omp-web`.
- No dev server is listening on 30141: the production build rewrites `.next/` and breaks a running `bun run dev`. Stop it first.
- `.next/server/route-cache/` does not exist. `next start` writes it (the build does not), and it would be published. Delete it if present.

Before bumping, confirm the next version is free (replace `<version>`):

```bash
npm view omp-web@<version> version --registry https://registry.npmjs.org/   # expect E404
git ls-remote --tags origin v<version>                                            # expect empty
```

## 2. Publish to npm

Patch release:

```bash
npm run release
```

The release script runs:

```bash
npm version patch --no-git-tag-version && npm run build && npm publish --access public
```

`npm run release` only bumps the patch number. For a minor (or major) release, set the version yourself and run the other two steps separately:

```bash
npm version <x.y.0> --no-git-tag-version
npm run build
npm publish --access public
```

Choosing the bump: look at `git log --oneline v<previous>..HEAD`. A batch of `feat:` commits (new UI, new commands, new settings) is a minor; only fixes and small adjustments is a patch. Decide before running the script, since a published version cannot be reused.

Notes:

- This bumps `package.json` and `package-lock.json`.
- It intentionally runs a production build. Do not run `next build` during normal development; release work is the exception.
- A newly published version may take a few minutes to show up. `npm view omp-web@<version> version` can return E404 and `npm view omp-web version` can show the previous version even though the publish printed `+ omp-web@<version>`. This is registry propagation, not a failed publish: do not publish again. Poll the registry until the version appears:

```bash
curl -s https://registry.npmjs.org/omp-web/<version> | head -c 80   # JSON once it exists, "version not found" before
npm view omp-web dist-tags --registry https://registry.npmjs.org/
npm view omp-web versions --json --registry https://registry.npmjs.org/
```

## 3. Commit the Version Bump

Replace `<version>` with the new package version, for example `0.7.5`.

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

## 4. Tag and Push

```bash
git tag -a v<version> -m "v<version>"
git push origin main v<version>
```

Push the release tag by name. Do not use `git push --tags`: the local checkout holds tags fetched from contributor forks that are not on origin, and `--tags` publishes them (it leaked a stray `v0.10.5`, on a commit that is on no branch, during the v0.11.0 release). If you ever need `--tags`, compare `git tag` with `git ls-remote --tags origin` first.

Confirm the tag does not already exist before creating it when unsure:

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo ddallabenetta/omp-web
```

## 5. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes or PR numbers next to each item when useful.

- Check commands, flags and setting names against `README.md` and the code before writing them down.
- Thank outside contributors by name: `git log --format='%h %an | %s' v<previous>..v<version>` lists authors, and the previous release's notes show the style.
- Open with the install/upgrade command (`npm install -g omp-web@latest`), as earlier releases did.
- Write the notes to a file outside the repo (for example `NOTES=$(mktemp)`), or pass them through stdin as shown below. A `release-notes.md` in the repo root is an untracked file in the next release's `git status`.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `omp-web@<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `omp-web@<version>`.
```

## 6. Create or Update the GitHub Release

Create a new release:

```bash
gh release create v<version> \
  --repo ddallabenetta/omp-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file "$NOTES"
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version> \
  --repo ddallabenetta/omp-web \
  --notes-file "$NOTES"
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo ddallabenetta/omp-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 7. Final Verification

```bash
gh release view v<version> --repo ddallabenetta/omp-web
npm view omp-web@<version> version --registry https://registry.npmjs.org/
npm view omp-web dist-tags --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
git ls-remote --tags origin
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- npm exact version resolves and `latest` points at it (allow a few minutes, see step 2).
- `git ls-remote --tags origin` shows no tag you did not mean to publish.
- `main` is aligned with `origin/main`.
- `HEAD` points at the release commit and `v<version>` tag.
