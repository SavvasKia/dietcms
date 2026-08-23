# Task 6 report: GDPR coverage forcing-test

Module: client-records+GDPR (final task). Branch `feat/client-records`, from `b666f54`.
Created: `tests/unit/gdpr-coverage.test.ts`. **`lib/gdpr.ts` and `db/schema.ts` are byte-identical to `b666f54`** — the test revealed no coverage gap, and nothing was restructured to make the test easier.

## What was implemented

A source-text tripwire over `lib/gdpr.ts`, per the brief's replacement mechanism (the plan's mechanism is a documented false negative — see below).

1. **Detection** — plan's rule kept: iterate `Object.values(schema)`, `getTableConfig` in try/catch, a table is client-scoped when `cfg.name === 'clients' || cols.includes('client_id')`. Detects `clients`, `client_consents`, `audit_log`.
2. **`namedBodies(src)`** — map of every top-level named code block → brace-matched body, covering both declaration styles so a refactor between them cannot silently change the answer:
   - `[export] [async] function NAME (...) { }`
   - `[export] const NAME = [async] (...) => { }`
   The body brace is found by scanning past a *balanced* parameter list (not `indexOf('{')`, which the plan used and which breaks on destructured params), and the arrow form requires a `=>` between the params and the brace so `const x = (a + b)` is not captured as a code block.
3. **`effectiveBody(bodies, entry)`** — the entry point's own body plus, to a fixpoint, the body of every mapped name referenced in the accumulated text. Cycle-safe via a `visited` set (seeded with the entry, so self-recursion is also safe). Throws when the entry point is absent, and throws when the effective body is empty-after-stripping-whitespace-and-braces.
4. **Assertion** — for each detected table: registered in `tableToIdent` (else a red naming the table and the three required actions), and its identifier appears — `\b`-bounded, escaped, not `includes` — in *both* entry points' effective bodies (else a red naming the entry point and explaining that module-local helpers count while other files do not).
5. **Vacuous-pass guard** — `expect(tables).toEqual(expect.arrayContaining(['clients','client_consents','audit_log']))` before the loop, so an empty `tables` (e.g. `getTableConfig` starting to throw for every export) cannot satisfy every `for` assertion silently.
6. **Three mechanism tests on synthetic fixtures**, not on `lib/gdpr.ts`: helper-reachable resolution across a cycle, import-only/type-only exclusion, and loud throw on a missing entry point. Fixture-based deliberately — asserting "`clients` is absent from `exportClient`'s own body" against the real file would turn a legitimate inlining of that read into a false red (this is forcing test C part 2, below).

Header comment states plainly that this is a tripwire, not proof of correct wiring; the behavioural proof is `tests/integration/gdpr.test.ts`.

One deviation from the plan's snippet, forced by the environment: `new URL('../../lib/gdpr.ts', import.meta.url)` throws `ERR_INVALID_URL_SCHEME` from `readFileSync` under this suite (jsdom environment supplies its own `URL` global). The path is resolved with `fileURLToPath` + `dirname` instead — still relative to the test file, not to cwd.

## The plan's blocker, reproduced

Probe against the real `lib/gdpr.ts` (throwaway test, removed):

```
names:                reachableClient,callerTenantId,callerTenantIdOrNull,recordDeny,exportClient,eraseClient
ownHasClients:        false     <-- the plan's test goes red here, against correct code
effHasClients:        true
effHasClientConsents: true
effHasAuditLog:       true
eraseEff (clients, clientConsents, auditLog): true,true,true
```

`exportClient`'s own body genuinely does not contain `clients`; the transitive body does. The traversal is doing real work, not accidentally matching.

## Forcing tests

### A — a new client-scoped table goes red

Appended `_coverageProbe` / `coverage_probe` (id + `client_id`) to `db/schema.ts`, no `db:generate`, no migrate:

```
--- FORCING TEST A: red expected ---
 FAIL  tests/unit/gdpr-coverage.test.ts > GDPR coverage tripwire > every client-scoped table is wired into BOTH exportClient and eraseClient
AssertionError: Table "coverage_probe" holds client data but is not registered in this test.
A client-scoped table (the `clients` root, or any table with a `client_id`
column) must be covered by GDPR export and erasure. Do all three:
  1. Read it in exportClient (Art 15/20) and delete-or-anonymize it in
     eraseClient (Art 17) in lib/gdpr.ts.
  2. Add a behavioural case to tests/integration/gdpr.test.ts — this test
     only checks that the identifier appears, never that it is used right.
  3. Register it in tableToIdent in this file: 'coverage_probe': '<drizzleExport>'.
If the table is legally retained and must NOT be erased, that is a policy
decision — do not silence this test; see the POLICY SLOT note in lib/gdpr.ts.: expected undefined to be truthy
      Tests  1 failed | 3 passed (4)
```

Restored from the byte-identical backup and re-ran:

```
cmp: byte-identical
git diff db/schema.ts: clean
?? .superpowers/sdd/client-records/task-6-brief.md
?? tests/unit/gdpr-coverage.test.ts
--- FORCING TEST A restored: green expected ---
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

No migration was generated: `db/migrations/` is unchanged and `git status` shows only the two intended untracked files.

### B — an import-only reference does NOT satisfy the check

Removed both real `clientConsents` uses (the `exportClient` select, the `eraseClient` delete) while leaving the import line — and, incidentally, the top-level `ClientExport` type's `typeof clientConsents.$inferSelect`, which is also outside every body:

```
--- import line intact? ---
4:import { auditLog, clientConsents, clients, tenantMembers } from '@/db/schema'
9:  consents: (typeof clientConsents.$inferSelect)[]
--- FORCING TEST B: red expected ---
 FAIL  tests/unit/gdpr-coverage.test.ts > GDPR coverage tripwire > every client-scoped table is wired into BOTH exportClient and eraseClient
AssertionError: Table "client_consents" (identifier `clientConsents`) is not referenced anywhere in
exportClient's effective body in lib/gdpr.ts.
The effective body includes helpers called from it WITHIN lib/gdpr.ts, so a
read extracted into a local helper still counts. It does NOT include the
import block, nor helpers living in other files: if you moved this read into
another module, this red is a false alarm — inline the reference or extend
this test to follow that module.: expected false to be true
      Tests  1 failed | 3 passed (4)
```

Widening to helpers did **not** swallow the import block, and a type-position reference does not count either. Restored:

```
cmp: byte-identical
git diff lib/gdpr.ts: clean
--- B restored: green expected ---
      Tests  4 passed (4)
```

### C — a helper-reachable reference stays green

Part 1 is the live code: `exportClient` → `reachableClient` → `clients`. That is exactly the path the plan's mechanism reported as uncovered, and it is green here (`effHasClients: true` in the probe above; the suite is green at HEAD).

Part 2 — inlined the `clients` read into `exportClient` so no helper hop remains, to prove the traversal is not the *only* thing making it green:

```
--- FORCING TEST C part 2: clients read INLINED into exportClient (no reachableClient hop) ---
26:async function reachableClient(
175:    const client = await reachableClient(tx, clientId)   # eraseClient's call only
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Part 3 (not required, added because the brief demands both declaration styles behave identically) — rewrote `reachableClient` from `async function` to `const … = async (…) => {`:

```
const reachableClient = async (
  tx: typeof authedDb,
  clientId: string,
) => {
  const [row] = await tx.select().from(clients).where(eq(clients.id, clientId)).limit(1)
  return row ?? null
}
      Tests  4 passed (4)
```

Restored after each, with proof:

```
cmp after C2: byte-identical
cmp after C3: byte-identical
git diff lib+db: clean
```

### Side experiment — a raw-text false GREEN that does exist

Predicted during review, so I measured it. Removed `exportClient`'s `auditLog` read but left the return-object property **key** `auditLog: audit`:

```
126:    return { client, consents, auditLog: audit }
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Still green. The effective body is raw text, so property keys, comments and string literals all count as references. Here it is a coincidence that the key spells the identifier; it means the test cannot distinguish "reads the table" from "mentions the word". It is a tripwire for *absence*, not an assertion of *use* — the integration suite is what proves use. (Luck worth noting: the doc-comments in `lib/gdpr.ts` say `client_consents` / `audit_log` in snake_case, so they do not collide with the camelCase identifiers. Rewriting a comment to say `clientConsents` would create the same kind of false green.)

## Verification

```
pnpm exec vitest run tests/unit/gdpr-coverage.test.ts   4 passed (4)
pnpm test                                              8 files, 25 passed (25)
pnpm test:int                                          5 files, 117 passed (117)
pnpm typecheck                                         clean (tsc --noEmit, no output)
pnpm lint                                              clean (eslint ., no output)
```

Unit count is **25**, not the brief's predicted 22: the file adds 4 tests, not 1 — the tripwire plus three tests of the parsing/traversal mechanism itself.

Final `git status`: only the intended additions (test file, brief, this report). No `db/schema.ts` edit, no new `db/migrations/` entry, no probe file.

## Concerns

### How brittle is this? Refactors that produce a FALSE RED

It is a source-text test coupled to the shape of one file. Ordered by likelihood:

1. **Moving a table read into another file** (e.g. a `lib/gdpr/consents-read.ts`, or reusing a helper from `lib/consents.ts`). The bodies map is module-local by construction — that is what keeps the import block excluded, so it cannot be widened without losing property B. This is the most likely real refactor to trip the test. The failure message names it explicitly ("nor helpers living in other files: if you moved this read into another module, this red is a false alarm"), so it should lead the reader to the right conclusion rather than to deleting the test.
2. **Renaming `exportClient` / `eraseClient`.** Throws at collection time with a message naming `ENTRY_POINTS`. Correct diagnosis, cheap fix.
3. **A declaration style the parser does not know**: a parenless arrow (`const f = x => {}`), a class method, an object-literal method, `export default`, a `function` expression assigned to a const, or a decorated/overloaded declaration. The block simply does not enter the map, so a reference reached only through it disappears → red pointing at the wrong thing (it says "not referenced", when the truth is "not parsed"). This is the failure mode whose message is *least* helpful.
4. **A brace inside a return-type annotation** (`function f(): { a: string } {`). Brace-matching would capture the type literal as the body. No function in `lib/gdpr.ts` has one today; documented rather than solved, because solving it means parsing TypeScript.
5. **Renaming a table** in `db/schema.ts` without updating `tableToIdent` → red as "not registered". That one is a *true* red wearing a slightly confusing message.

Conversely the false-*green* surface is real and wider than the false-red surface: any textual mention of the identifier inside any reachable body satisfies it (property key, comment, string). Documented above and in the file header. Treating a green run here as GDPR assurance would be the actual danger.

### Where `retain-with-policy` slots in (Task 5's recommendation — deliberately NOT built)

There is no tax-retained table yet, so nothing was implemented. When the myDATA retention spike lands and the billing module adds one:

- It stays in `tableToIdent` unchanged, and stays **required in the `exportClient` assertion** — Art 15/20 still owes the data subject a copy of a retained invoice.
- It is exempted **only from the `eraseClient` assertion**. So the shape is a sibling constant next to `tableToIdent` — e.g. `const erasureExempt: Record<string, string> = { invoices: 'Greek tax law retention; see spec §5 / myDATA spike' }` — consulted inside the `for (const entry of ENTRY_POINTS)` loop to skip the `eraseClient` check for that table only, with the reason string printed in the test name or a comment so the exemption is never silent.
- No change to detection, to the parser, or to the traversal is needed. The next developer should not have to redesign anything.

Deliberately not pre-built: an unused exemption map is an invitation to silence a real red.

### Raise, do not implement: does this belong in the unit suite?

Recommendation: **it does not really belong there, but it should stay there for now.**

The case against: it reads a source file from disk and asserts on its text. It tests neither behaviour nor a pure function of the module under test; it is a lint rule wearing a test's clothes. It will fail for reasons that have nothing to do with a regression (a rename, a style change), and it sits in the suite developers run on every save, where a false red costs the most trust.

Better homes, in order of preference:
1. **An ESLint rule or a CI-only `scripts/check-gdpr-coverage.ts` gate** run as its own step (`pnpm check:gdpr`) alongside `lint`. That is what it actually is, and a red there reads as "policy gate failed", not "a test broke".
2. A separate vitest project/tag (e.g. `tests/gates/`) excluded from the default watch run.
3. Where it is now.

Reason to leave it in place today: the module is closing, and `tests/unit/` is the only wired-up suite that runs in CI without a database. Moving it needs a new npm script and a CI step, which is a foundation-level change and out of this task's scope. I would file it as a follow-up: *"move the GDPR coverage tripwire out of the unit suite into a CI policy gate"*.
