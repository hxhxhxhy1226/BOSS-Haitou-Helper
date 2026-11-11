# Release workflow

The project owner requires every completed update to include a version bump, a Git commit, and a push to the repository. This authorization persists unless the owner explicitly requests local-only work or postpones publication.

- Bump the patch version for bug-fix releases; use an appropriate semantic version for broader changes. Keep `extension/manifest.json`, `package.json`, the root package entries in `package-lock.json`, the core banner, and current-version documentation consistent. Preserve version numbers in historical records.
- Run relevant tests and `npm run check`, build the installation and source packages, and verify their contents. Tests of the real extension must read the version from the manifest instead of hard-coding it.
- In the owner's organized workspace, development lives in `独立插件/开发源码` and the Git checkout lives in `独立插件/GitHub上传/仓库文件`. Synchronize changed source, tests, and documentation into that checkout before committing. Update the installation package, source ZIP, and checksum files. Preserve already-loaded extension paths.
- Inspect the actual branch and remote, fetch updates, commit the completed work, and push normally to the agreed branch (`develop` on `origin` in the owner's workspace). Never force-push as part of routine publishing.
- Verify the remote commit and check its CI run when available. Report the release version, commit, and repository link.
