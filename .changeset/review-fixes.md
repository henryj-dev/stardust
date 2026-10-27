---
"stardust": minor
---

Security fixes from the pre-publication review:
- Pull requests are built but no longer deployed.
- Workspace projects refuse pull requests from forks.
- A webhook delivery must name the project's repository, and a re-sent delivery starts nothing.
- Parallel sign-in guesses no longer bypass the lockout.
- Passwords are capped at 1024 characters and API bodies at 64 KiB.
- A password reset also revokes the user's API tokens.
- The sign-in redirect accepts only paths on the same site.
