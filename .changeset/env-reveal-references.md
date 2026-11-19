---
"stardust": minor
---

The env page, as Coolify's: maintainers can show a secret's value (audited by name, never cached), values may span several lines (typed, not only as files), and a value may use `${NAME}` and `{{project.NAME}}`, resolved when the env is rendered — in multi-line secrets too — unless the value is marked Literal. A reference to nothing, a cycle, or a plain value that uses a secret is refused.
