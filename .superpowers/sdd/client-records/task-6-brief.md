# Task 6 brief: GDPR coverage forcing-test

Module: client-records+GDPR. Branch: `feat/client-records`, clean at `b666f54`. **Final task in the module.**
Plan: `docs/superpowers/plans/2026-06-28-client-records-gdpr.md` § "Task 6" (lines 1014–1126).
Spec: `docs/superpowers/specs/2026-06-28-client-records-gdpr-design.md` §6.

**The plan's test as written FAILS against the current correct code. Read the blocker section below before anything else.**

## Scope

- Create: `tests/unit/gdpr-coverage.test.ts`
- Modify `lib/gdpr.ts` **only** if the finished test reveals a genuine coverage gap. It should not — coverage is complete today. Do not restructure `lib/gdpr.ts` to make a test easier to write.

Unit test, no DB. `vitest.config.ts` includes `tests/**/*.test.{ts,tsx}` and excludes `tests/integration/**`, so this file lands in the unit suite.

## What this test is, and is not

It is a **tripwire**: it forces a future client-scoped table to be registered here *and* referenced from both `exportClient` and `eraseClient`. It is **not** proof that the wiring is correct — that lives in `tests/integration/gdpr.test.ts` (seed → export-contains / erase-empties). Say so in a comment at the top of the file. Overselling it is worse than not having it.

## THE BLOCKER — the plan's mechanism produces a false negative

The plan brace-matches the body of `function exportClient` and requires the bare table identifier inside it. I ran the plan's own logic against the real `lib/gdpr.ts`:

```
exportClient: includes("clients")        = false   <-- plan's test goes red here
exportClient: includes("clientConsents") = true
exportClient: includes("auditLog")       = true
eraseClient:  clients / clientConsents / auditLog = true / true / true
```

`exportClient` delegates its `clients` read to the module-local `reachableClient` helper (`lib/gdpr.ts:26`), so the identifier never appears in its own body. The plan's test would fail with *"clients not referenced in exportClient"* **against correct, fully-covered code**.

That is the worst failure mode a tripwire can have: a red that is not a real gap teaches whoever hits it to delete the test. Fix the mechanism, not the production code.

## Required mechanism: transitive resolution over module-local code

1. Read `lib/gdpr.ts` source.
2. Build a map of **top-level named code blocks** — name → body text. Cover both declaration styles so a future refactor between them does not silently change the answer:
   - `function NAME(`, `async function NAME(`, `export function NAME(`, `export async function NAME(`
   - `const NAME = (…) => {`, `const NAME = async (…) => {` (and the `export const` forms)
   Brace-match from the opening `{` of the body.
3. For each entry point (`exportClient`, `eraseClient`), compute its **effective body**: its own body, plus the bodies of every mapped name that appears as an identifier within the accumulated text, repeated to a fixpoint. Track a visited set — the graph may be cyclic and must not hang.
4. Assert the table's registered identifier appears in that effective body.

The import block is never part of any body, so the import-only false-green the plan was designed to close stays closed. That property is load-bearing — prove it (forcing test B).

**Fail loudly, never silently:** if an entry point is not found, or its effective body comes back empty, `throw`. A `0`-length body that quietly satisfies nothing is how this test rots.

## Detection and registration

Client-scoped table detection — keep the plan's rule, it is correct. I verified it against the live schema:

```
SCOPED   clients          SCOPED   audit_log        SCOPED   client_consents
  ---    tenants            ---    tenant_members     ---    notes
```

Rule: `cfg.name === 'clients' || cols.includes('client_id')`. Iterate `Object.values(schema)` and `getTableConfig`, skipping non-tables via try/catch as the plan does.

Registration: keep the plan's explicit `tableToIdent` map. An unregistered client-scoped table must fail with a message that tells the next developer exactly what to do — wire it into both functions, add a behavioural case in `tests/integration/gdpr.test.ts`, and register it here. That message is the whole value of the test; write it for someone who has never read this brief.

Also keep a positive assertion that the three known tables are present, so a schema-detection regression (e.g. `getTableConfig` throwing for every entry) cannot make the loop vacuously pass over an empty list. **This is the vacuous-pass class that has been caught in three of the five previous tasks** — an empty `tables` array would otherwise satisfy every `for` assertion.

## Forcing tests — mandatory, all three

Break it, prove red, restore, prove green. **Paste every run.** Restore from a byte-identical backup and `diff` to confirm.

- **A — a new client-scoped table goes red.** Temporarily add to `db/schema.ts` (do **not** migrate):
  ```ts
  export const _coverageProbe = pgTable('coverage_probe', {
    id: uuid('id').defaultRandom().primaryKey(),
    clientId: uuid('client_id'),
  })
  ```
  Expect red with the guidance message naming `coverage_probe`. Then delete it and re-run green. **Confirm `pnpm db:generate` is not run and no migration appears** — check `git status` before you commit.
- **B — an import-only reference does NOT satisfy the check.** Temporarily remove a table's real usage from both entry points (and any helper they reach) while leaving its `import` line intact. Expect red. This proves the body-scoping still works after you widened it to helpers; if it goes green, your effective-body computation has swallowed the import block.
- **C — a reference reachable only through a helper stays GREEN.** This is the plan's bug, inverted into a regression test. `exportClient`→`reachableClient`→`clients` already exercises it, so state that explicitly and show it green. Then, to prove the traversal is doing real work rather than accidentally matching, temporarily inline the `clients` read into `exportClient` and confirm it is *still* green both ways.

## Verification before you report

- `pnpm exec vitest run tests/unit/gdpr-coverage.test.ts` — green (use this form; `pnpm test -- <name>` does not filter)
- `pnpm test` — green (21/21 currently, so 22/22 after this)
- `pnpm test:int` — green (117/117), untouched by this task
- `pnpm typecheck` — clean
- `pnpm lint` — clean
- `git status` — no stray `db/schema.ts` edit, no new migration, no leftover probe file

## Commit

Conventional Commits, subject ≤50 chars.
```
git add tests/unit/gdpr-coverage.test.ts
```
Trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
Brief and report in a second `docs:` commit, matching tasks 1–5.

## Report → `.superpowers/sdd/client-records/task-6-report.md`

What you implemented, the three forcing runs with real output, self-review, and **concerns**. Specifically address:

- **How brittle is this?** It is a source-text test coupled to the structure of `lib/gdpr.ts`. Name the refactors that would break it with a false red, and say whether the failure message would lead someone to the right conclusion.
- The `retain-with-policy` third category recommended at the end of Task 5 (for legally-retained invoice tables, pending the myDATA spike). Do **not** build it — there is no such table yet. But say where it would slot into your registration map, so the next developer does not have to redesign the test to add it.

**Raise, do not implement:** whether this test belongs in the unit suite at all, given it reads a source file from disk rather than testing behaviour. Recommend a home for it.
