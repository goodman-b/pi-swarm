# Development and releases

GitHub is the authoritative repository. Open issues and pull requests there.
Keep host-specific models, grants and paths in `~/.pi/swarm.json`, not in a
private code fork. Never commit credentials or runtime artifacts.

## Development

Work on a branch in a separate clone or worktree, not a package directory
currently loaded by Pi. Install Pi 0.87.1, Node ≥ 22.19 and Python 3, then run
`npm test`. The suite is offline and does not call models. GitHub CI runs it
on pushes to `main` and pull requests.

For behavior changes, add a regression check and run a bounded live smoke on
a disposable workspace before release. Writer changes also need a live apply
smoke with a suitable gate; offline tests alone do not prove that path.
Review and merge through a pull request after checks pass.

## Release checklist

1. Update `package.json`'s version and `CHANGELOG.md` on a release branch.
   Use a new version for every npm publication; do not move published tags.
2. Run `npm test` and `npm pack --dry-run`. Inspect the file list for private
   data and verify all required runtime files are included.
3. Merge after review and green CI. From a clean checkout of that exact
   `main` commit, verify the version and create the matching annotated tag
   (`vX.Y.Z`). Push the tag to GitHub.
4. Publish that same checkout with `npm publish --access public`, completing
   npm's interactive authentication. No credentials belong in the repo or CI.
5. Verify `npm view @goodman-b/pi-swarm@X.Y.Z version dist.integrity` and
   the npm/Pi catalog pages. Create GitHub release notes from the changelog.
6. Upgrade a canary first, then other consumers deliberately. Pinned installs
   use `pi install npm:@goodman-b/pi-swarm@X.Y.Z`; reload Pi when idle.
   Roll back by installing the previous version and reloading.

The initial `v0.4.0` Git tag predates the scoped npm metadata and README
updates. npm 0.4.0 was published from `4d2b1ef`; runtime source is unchanged.
Keep that historical tag intact. Future tags and npm publications must use
exactly the same source commit.

npm trusted publishing can replace interactive publication later; no release
automation or publishing credentials are configured by this workflow.
