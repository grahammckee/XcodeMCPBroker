# Security Policy

## Supported Versions

Security fixes are provided for the latest published release only.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |

Users should upgrade to the latest release before reporting an issue that may already be fixed.

## Reporting a Vulnerability

Do not open a public issue, discussion, or pull request for a suspected vulnerability.

Use GitHub's [private vulnerability reporting form](https://github.com/grahammckee/XcodeMCPBroker/security/advisories/new). If you cannot use that form, email [contact@grahammckee.com](mailto:contact@grahammckee.com) with the subject `XcodeMCPBroker security report`. Include:

- Affected version and macOS/Xcode versions
- Required configuration, including whether the broker was bound beyond loopback
- Reproduction steps or a minimal proof of concept
- Expected impact and affected Xcode tools
- Any known mitigations or workarounds

Remove unrelated credentials, private source code, and personal information. Reports should contain only the information needed to reproduce and assess the issue.

The maintainer aims to acknowledge reports within 7 days and provide an initial assessment within 14 days. Resolution time depends on severity and complexity. Please allow time for investigation and a coordinated release before public disclosure.

## Security Boundaries

The broker is intended to bind to `127.0.0.1`. It does not provide authentication and shares an Xcode-authorized bridge with clients that can reach it. Binding to another interface without an appropriate authenticated, encrypted access-control layer is unsupported and unsafe.

Reports about credential exposure, unauthorized tool execution, network exposure, installer integrity, release-signing bypasses, or dependency vulnerabilities are in scope. General support questions and non-security bugs should use the public issue forms.

## Disclosure

After a fix is available, the maintainer may publish a GitHub Security Advisory describing impact, affected versions, remediation, and reporter credit when requested. Do not disclose the issue publicly before coordinated disclosure is complete.
