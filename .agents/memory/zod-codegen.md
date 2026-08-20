---
name: Zod and OpenAPI codegen
description: Compatibility constraint between Orval's generated validators and workspace dependencies.
---

Orval's current Zod client generation emits Zod 4 APIs such as `zod.int()` and `zod.uuid()`.

**Why:** The workspace initially pinned Zod 3, which made successful code generation fail during the required library typecheck.

**How to apply:** Keep the workspace Zod catalog on a Zod 4 release whenever the generated OpenAPI validators use these helpers.