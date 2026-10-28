# Repository instructions

## GitHub releases

The repository owner requires a consistent release format and an explicit list
of public assets. Read [the release policy](docs/release-policy.md) and
[the release template](docs/releases/TEMPLATE.md) before preparing a release.

The owner approved this policy and template on 2026-10-29. Use them for future
releases, and obtain approval of each release's concrete contents as follows:

- Prepare the final release title, tag, source commit, notes, and exact asset
  list locally, with build and verification work completed before requesting
  approval. Show what will be published and what existing content will change.
- Obtain the owner's approval of that concrete release before creating or
  updating a public GitHub release or uploading, replacing, or removing assets.
  Approval of the template alone does not authorize a release or changes to
  past releases. If the owner has already approved the same concrete content
  in the current task, proceed without asking again.
- Keep notarization receipts, verification JSON, test reports, upload logs,
  operational state, and credentials out of public release assets. Use an
  explicit file list; never upload an entire build directory or a wildcard.
  Any proposed extra public file must appear in the owner's review list.
- Keep detailed build records in the ignored `release/` directory. Public
  notes should explain user-visible changes, installation, upgrade effects,
  and relevant limitations. Summarize validation accurately without copying
  operational logs or notarization submission identifiers into the notes.
