# Changelog

## Unreleased

### Added

- Preserve the independent Orthogonal landing reference with local assets, catalog search, animated scenes and browser verification.

### Changed

- Load customer, company and administrator views on demand, with scoped dashboard reads, non-overlapping refreshes and compressed production assets.
- Keep Home separate from Activity, with the redesigned provider overview, API key library and shared company console.
- Open agent setup from a shared dialog and preserve the current client configuration during installation.
- Preserve the approved light-blue buttons and white labels in normal, hover and pressed states.

### Fixed

- Show tool loading and retry states, and identify each provider in tool-button accessibility names.
- Keep catalog card footers aligned and contained on desktop and mobile.
- Preserve browser origins through the development proxy so local write checks match production behavior.
- Recover failed page downloads with a reload action and retain navigation while customer pages load.
- Serve compressed assets from checkouts under hidden directories, return 404 for missing assets and avoid caching transfer errors.
- Keep local access-token entry available on protected dashboard pages.

### Documentation

- Add a product research index and reference-capture template.
- Document the dashboard loading and storage performance changes.
