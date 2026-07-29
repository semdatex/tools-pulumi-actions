# About this fork

`semdatex/tools-pulumi-actions` is a fork of
[`pulumi/actions`](https://github.com/pulumi/actions). It exists so we can carry
patches to the Pulumi GitHub Action at our own pace instead of waiting on
upstream releases.

This file holds everything specific to the fork. Everything else in the repo is
upstream's and is kept as close to upstream as possible so that syncing stays
cheap — including `CHANGELOG.md`, which tracks upstream's releases and should
not record our changes. Put fork-relevant notes here instead.

## What we changed relative to upstream

- **Removed four workflows** that authenticate against Pulumi's own
  infrastructure and cannot work here: `update_dist.yml` and
  `export-repo-secrets.yml` (OIDC into the `pulumi` Pulumi Cloud org / Pulumi's
  GitHub App), plus `tag.yaml` and `immutable-action.yml` (Marketplace release
  automation we have no use for).
- **Removed `test.yml`'s `test-pr-version` job**, which listed workflow-run
  artifacts on `pulumi/pulumi`. The `pr#N` version feature itself is untouched.
- **Added `.github/workflows/pipeline.yml`**, a single entry point that calls
  the other suites and ends in one `Pipeline Complete` gate. That gate is the
  required status check on `main`, declared in
  [`infrastructure-root`](https://github.com/semdatex/infrastructure-root)
  (`projects/tools/pulumi-actions.yml`).
- **Added lint, typecheck and dist-integrity** to CI. Upstream ran none of them
  on PRs.
- **Dropped `dorny/paths-filter`** in favour of a shell step, so the fork needs
  no third-party action and is not coupled to the org's Actions allowlist.
- **Pinned the toolchain** — `volta.node` in `package.json`, read by
  `actions/setup-node` via `node-version-file`, and
  `yarn install --frozen-lockfile` everywhere, so `dist/` builds reproducibly.
- **Extracted stack-output publishing into `src/libs/outputs.ts`** with unit
  tests that pin the current `setOutput`/`setSecret` behavior, including call
  order. No behavior change — groundwork for the output/secret features, which
  all land in that module instead of `main.ts`.
- **`preview` streams its output** through `onOutput` like `up`/`refresh`/
  `destroy` do, instead of buffering until the command exits. Long previews are
  now diagnosable while they run; stderr is no longer printed twice. The
  `output` step output and PR-comment/summary content are unchanged.
- **Secret outputs are masked before anything is written, leaf by leaf.**
  Upstream registers each mask after the value has already been set and masks
  only the exact serialization, so nested values of structured secret outputs
  leak through `fromJSON(...)`/`toJSON(...)` re-encoding. Masks now register
  first, and structured secrets additionally mask every string/number leaf
  (boolean and very short leaves are skipped to avoid corrupting logs). New
  input `secret-masking: nested` (default) | `exact` (bit-for-bit upstream
  masking). GITHUB_OUTPUT contents are unchanged in both modes.
- **`output-format` input** — `per-key` (default) keeps upstream's contract:
  one step output per stack output, byte-identical behavior. `json` publishes
  no per-key outputs; instead a single declared `stack-outputs` output
  `{name: {value, secret}}` with secret values omitted and never decrypted
  (the CLI runs without `--show-secrets`, so plaintext secrets never enter
  the process), plus a `command-result: succeeded | failed` output set even
  when the command fails (upstream sets no outputs at all then). Nothing in
  json mode can be stripped by GitHub's masked-value rule, and `fromJSON`
  yields real objects instead of double-encoded strings.

## `dist/` must be committed with your change

The action runs from the bundled `dist/index.js`, so a source change that does
not ship a rebuilt bundle is a no-op at runtime. Upstream papered over this with
a bot that force-committed `dist/` to `main` after the fact; our branch ruleset
does not allow that, so CI checks it on the PR instead.

Any change to `src/`, `scripts/`, `package.json` or `yarn.lock` needs:

```bash
yarn install --frozen-lockfile
yarn build
git add --force dist   # dist/ is gitignored but tracked
```

`--force` is needed because `.gitignore` lists `dist/`; the four bundle files
are force-tracked. Note the build also emits protobuf/licence trees under
`dist/` that upstream does not track — leave those untracked, as upstream does.

If CI fails with `Binary files a/dist/index.js and b/dist/index.js differ`, you
forgot to rebuild. Use the pinned Node version (`volta.node`); a different major
can produce a different bundle.

## Syncing from upstream

```bash
git remote add upstream https://github.com/pulumi/actions.git   # once
git fetch upstream --tags
git checkout -b sync-upstream-$(date +%Y%m%d) main
git merge upstream/main
yarn install --frozen-lockfile && yarn build && git add --force dist
```

**Merge, never rebase.** Merging keeps our patch commits identifiable in
`git log` and means `main` never needs a force-push — which the branch ruleset
blocks anyway. Open the sync as a normal PR and let the pipeline verify it.

Expect conflicts only in the files listed above. The workflows are where we
diverge most.

## Consuming the fork

Pin a **full commit SHA**:

```yaml
- uses: semdatex/tools-pulumi-actions@<sha>
```

Not `@main`, and not `@v6`/`@v7` — those tags came with the fork, still point at
upstream commits, and are no longer maintained here (upstream moves them with
the release automation we removed). Same-org actions are exempt from the
organisation's Actions allowlist, so no policy change is needed to use this.
