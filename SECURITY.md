# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability").

You should get an acknowledgement within a week. Once a fix is released, the
advisory will credit you unless you prefer otherwise.

## Supported versions

Until 1.0, only the latest release receives security fixes.

## Release integrity

Release images and the chart are signed with cosign, keyless, by the release
workflow on `main` (see [docs/releasing.md](docs/releasing.md) for the
`cosign verify` command and the identity to expect). Deploy only artifacts
whose signatures verify, and pin them by digest. Git tags are not signed: the
signature on the artifact is what ties it to this repository's workflow.

The threat model is in [docs/security/threat-model.md](docs/security/threat-model.md).
