---
"stardust": minor
---

Core gains sagas (multi-step work that resumes after a crash and undoes finished steps when one fails), single-use approval tickets, protected targets and a reveal rate rule, kept in the new `saga_runs`, `guard_used` and `guard_events` tables, and contract test suites that a port's fake and its real implementations both run.
