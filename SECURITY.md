# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability").

You should get an acknowledgement within a week. Once a fix is released, the
advisory will credit you unless you prefer otherwise.

## Supported versions

stardust has not had a release yet. Until 1.0, only the latest release
receives security fixes.

## Release integrity

Release tags are signed, and release images and charts are signed with
cosign. Deploy only artifacts whose signatures verify.
