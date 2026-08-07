# Releasing `@jerrywu1234/smartflow`

Only the root CLI package is published. Every `apps/*` and `packages/*`
workspace package is private and bundled into the root package.

## One-time bootstrap

After the release automation lands on `main`:

1. Pull `main`, run `pnpm install --frozen-lockfile`, log in with `npm login`,
   then run `npm publish --access public` to publish `0.1.0` with npm 2FA.
2. In the npm settings for `@jerrywu1234/smartflow`, add a GitHub Actions
   trusted publisher with these exact values:
   - Owner: `JerryWu1234`
   - Repository: `AI-smart-flow`
   - Workflow filename: `release.yml`
   - Allowed action: `npm publish`
3. In GitHub **Settings → Actions → General**, grant workflows read/write
   permission and enable **Allow GitHub Actions to create and approve pull requests**.
4. Protect `main`: require a pull request, disallow bypass/direct pushes, and
   require the `Verify (Node.js 24)` status check.
5. Run the **Release** workflow once on `main`. It creates the `v0.1.0` tag and
   GitHub Release, then prepares any pending Version PR.

No `NPM_TOKEN` is used or stored.

## Normal release flow

1. For a PR that changes the published CLI, run `pnpm changeset`, select
   `@smartflow/cli`, choose patch/minor/major, and commit the generated file.
2. Merge the feature PR after CI passes.
3. The Release workflow creates or updates the Version PR.
4. Merge the Version PR to approve publication.
5. CI runs again. If it passes, the Release workflow publishes to npm through
   OIDC and creates the matching Git tag and GitHub Release.
