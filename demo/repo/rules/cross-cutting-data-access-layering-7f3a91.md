# Data Access Layering

These rules are ALWAYS ACTIVE for all HTTP handlers, controllers, and route modules
in the project. Any code that reads from or writes to the database on behalf of a
request is in scope, including new endpoints and changes to existing ones.

### Rules

**R-001** MUST: All persistence goes through the repository layer in
`src/repositories/`. Handlers MUST NOT compose SQL, call `query()`, or import
`src/db/pool` directly.

**R-002** MUST: A new data access pattern is added as a named function on the
relevant repository module, so it can be tested and reused, rather than inlined at
the call site.

**R-003** SHOULD: Prefer an additional repository function over widening an existing
one with optional flags or conditional joins.

### Verify

```bash
grep -rn "from \"../db/pool\"\|query(\|SELECT \|INSERT \|UPDATE " src/handlers/
test -z "$(grep -rln 'db/pool' src/handlers/)"
```

**Accept when:**

- No file under `src/handlers/` imports `src/db/pool` or contains SQL keywords.
- Every database read or write performed by a handler resolves to a named function
  exported from a module in `src/repositories/`.
- New query shapes appear as new repository functions with their own names.

<enforcement>
This boundary is what makes the data layer independently testable and lets query
changes be reviewed in one place. Handlers that reach past it have historically been
the source of N+1 regressions and untested SQL. A plan that proposes direct SQL in a
handler for performance reasons should instead propose a repository function that
encapsulates the optimized query.
</enforcement>
