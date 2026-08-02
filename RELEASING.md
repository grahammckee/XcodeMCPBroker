# Releasing

Every pull request must have exactly one release-intent label. The required `Release intent` check validates both the label and the version recorded in `package.json` and `package-lock.json`.

| Label | Version change | Use for |
|---|---|---|
| `release:patch` | `1.2.3` to `1.2.4` | Compatible fixes and dependency updates |
| `release:minor` | `1.2.3` to `1.3.0` | Backward-compatible features |
| `release:major` | `1.2.3` to `2.0.0` | Breaking runtime, configuration, or behavior changes |
| `release:none` | No change | Documentation, CI, or repository-only changes |

Maintainers control these labels. For a release, update both package files before merge:

```sh
npm version 1.2.4 --no-git-tag-version
npm run copyright:update
npm test
npm audit --audit-level=moderate
```

The copyright command keeps 2026 as the first publication year and extends the notice to the current UTC year when needed, for example `2026-2027`. The required PR checks prevent merging while `LICENSE` is stale.

## Automated Process

When a version-changing pull request is squash-merged into `main`, `.github/workflows/release.yml`:

1. Builds native arm64 and x86_64 Node single-executable applications.
2. Combines them into a universal macOS executable.
3. Developer ID signs the executable with hardened runtime.
4. Builds a signed, current-user-home installer package.
5. Notarizes and staples the installer.
6. Generates a source archive, CycloneDX SBOM, and SHA-256 checksums.
7. Creates keyless GitHub provenance and SBOM attestations.
8. Creates an annotated `v<version>` tag and generated GitHub release.

A `release:none` merge runs the release-state check but creates no tag or release. Published versions are never rewritten. The `v*` tag ruleset prevents tag updates and deletion.

## Release Environment

The `release` GitHub environment must define these variables:

| Variable | Value |
|---|---|
| `APPLE_APPLICATION_IDENTITY` | Full Developer ID Application identity |
| `APPLE_INSTALLER_IDENTITY` | Full Developer ID Installer identity |

It must also define these secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATES_P12` | Base64-encoded P12 containing both Developer ID identities |
| `APPLE_CERTIFICATES_PASSWORD` | P12 password |
| `APPLE_SIGNING_KEYCHAIN_PASSWORD` | Random password for the ephemeral CI keychain |
| `APPLE_NOTARY_KEY_P8` | Base64-encoded App Store Connect API private key |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |

Signing credentials are used only by the protected release job after code has merged. Pull-request workflows cannot access them.

## Artifacts

Each release contains:

- `XcodeMCPBroker-<version>-macos-universal.pkg`
- `XcodeMCPBroker-<version>-source.tar.gz`
- `XcodeMCPBroker-<version>.cdx.json`
- `SHA256SUMS`

Verify downloaded files:

```sh
VERSION="<release-version>"
shasum -a 256 -c SHA256SUMS
gh attestation verify "XcodeMCPBroker-${VERSION}-macos-universal.pkg" --repo grahammckee/XcodeMCPBroker
pkgutil --check-signature "XcodeMCPBroker-${VERSION}-macos-universal.pkg"
spctl --assess --type install --verbose=4 "XcodeMCPBroker-${VERSION}-macos-universal.pkg"
```

## Local Packaging

Node.js 26 or later is required to build the standalone executable. An unsigned package can be generated for local structural testing:

```sh
npm ci
npm run build:bundle
npm run build:sea
codesign --force --sign - dist/xcode-mcp-broker
npm run build:package
```

Unsigned packages must not be attached to public releases.
