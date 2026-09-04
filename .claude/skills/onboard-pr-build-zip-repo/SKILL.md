---
name: onboard-pr-build-zip-repo
description: Onboard a repo (wpeverest or themegrill org) to the pr-build-zip automation, and work through the standard build-failure checklist when the auto-detected config doesn't produce a ZIP on the first try.
---

# Onboard a repo to pr-build-zip

Adds a `.github/workflows/pr-build-zip.yml` caller to a repo so every ready-for-review PR gets a built, downloadable plugin/theme ZIP posted as a comment.

## Steps

1. Add the repo's `org/name` to the right array in `config/copilot-review-repos.json` (this list is reused from the Copilot-review rollout, not a separate list).
2. Run the `Propagate PR build ZIP workflow` action (`workflow_dispatch`, this repo's Actions tab). It inspects the target repo's `package.json` / `Gruntfile.js` / `gulpfile.js` / `composer.json` via the Contents API (see `scripts/propagate-pr-build-zip.mjs` → `detectBuildConfig()`) and opens a PR there with a generated `pr-build-zip.yml`.
3. If the target repo already has a hand-tuned `pr-build-zip.yml` that calls the reusable workflow, the script skips it — this is a one-shot bootstrap, not an ongoing sync. Don't expect re-running it to update an already-onboarded repo.
4. If secrets (`ARTIFACTS_KEY`/`ARTIFACTS_SECRET`) aren't already on that repo, also run `Propagate pr-build-zip secrets to all repos` — see the `propagate-shared-secret` skill for why this is a separate, required step on GitHub Free.
5. **The opened PR is the real test.** Auto-detection is a best guess, not a guarantee. Watch its `pr-build-zip` check run and work through the checklist below if it fails.

## Build-failure checklist (in the order these have actually happened)

- **`Node/PHP version too low`**: `engines.node` / composer's `require.php` often declare an ancient legacy floor (`>=0.8.0`, `>=5.6.20`) left from old boilerplate — not what anyone builds with today. The detection script already clamps to a sane floor (Node ≥16, PHP ≥7.4) and falls back to a sensible default (Node 20.x) above that, but if a repo's *actual* dependencies need something newer than the clamp, bump `php-version`/`node-version` explicitly in the generated `with:` block.
- **`wp: not found`**: some build steps (e.g. `wp i18n make-pot`) need `wp-cli`. The reusable workflow already installs the standalone `.phar` — if this still fails, check the repo's build step actually needs a fuller WP environment (DB, plugins) that the CI runner doesn't have.
- **`No ZIP matched '<glob>'`**: many repos have no packaging step in their npm scripts at all — they package externally via `.distignore` + rsync + zip. Check for a `.distignore` file in the repo; if present, the detection script's fallback should already handle this (`mkdir -p <repo> && rsync -rc --exclude-from=.distignore ... && zip -r <repo>.zip <repo>`, with `zip-glob: <repo>.zip`). If the repo uses some other non-obvious packaging convention (a `dist/<slug>.zip` from an external bundling branch, a Grunt/Gulp `compress` task with a non-default output path), there's no safe auto-fix — flag it for a human rather than guessing.
- **Composer platform-requirement conflicts**: `composer install --no-dev` still validates the *whole* lockfile's platform requirements (including require-dev packages) before installing. Add `--ignore-platform-reqs` if a repo's own PHP version is genuinely fine for its actual runtime deps but the lockfile's declared floor disagrees.
- **npm `ERESOLVE` peer-dependency conflicts**: use the reusable workflow's `install-command` input to override with `npm ci --legacy-peer-deps`, scoped to just that repo — don't change the reusable workflow's default install behavior for everyone over one repo's stale peer deps.
- **A repo has its own fully self-contained build script** (e.g. `bin/build-zip.sh` that does its own install + composer + build + zip): don't fight it by also configuring `composer-install`/`zip-glob` — set `composer-install: false` and `build-command: npm run build` (or whatever invokes that script) and let it own the whole pipeline. If that script itself calls `cross-env` or another dev-dependency binary, it must already be installed *before* the script runs — set `install-command` to a real install (not a no-op), since the script's own internal install runs too late for that.
- **`install-command` containing embedded quotes**: `${{ inputs.install-command }}` is textually substituted with no escaping. A value like `echo "skip"` can break the surrounding `if [ -n "..." ]` shell test. The reusable workflow passes `install-command` via an `env:` var for exactly this reason — if you're editing `pr-build-zip.yml` itself, keep it that way rather than reverting to raw interpolation.

## Verification

Don't trust a green check alone — open the posted PR comment and confirm the download link actually resolves to a real, correctly-named ZIP. If a real PR branch has been open a while, make sure it's not stale against the default branch before re-testing a fix — merge the default branch in first, or the fix won't be present in the test run.
