# Project Workflow

## Release Signing

- Do not block or delay a reviewed pull request while waiting for candidate-bound release records or a pre-merge signature.
- Merge the pull request when its code checks are complete. Let the GitHub Actions `release-sign` workflow rebuild and sign the release records on `main` after the merge, and verify that workflow rather than re-signing the squash commit manually.
- Never create a tag, publish a GitHub Release, publish installers, or bump the release version unless the user explicitly asks for a release.
