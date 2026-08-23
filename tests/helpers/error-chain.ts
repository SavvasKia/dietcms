/** Drizzle wraps pg errors ("Failed query: …") and puts the real one in `.cause`.
 *  Flatten the chain so an assertion can match the actual Postgres message.
 *
 *  Shared by the integration suites so no test has to fall back on a bare
 *  `.rejects.toThrow()` — that also passes on a network blip, a typo in the SQL
 *  or a NOT NULL violation, i.e. it can stay green while the guard under test
 *  is gone. Not named `*.test.ts`, so neither vitest config collects it
 *  (unit include is `tests/**\/*.test.{ts,tsx}`, integration
 *  `tests/integration/**\/*.test.ts`). */
import { expect } from 'vitest'

export async function errorChain(fn: () => Promise<unknown>): Promise<string> {
  const err = await fn().then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, 'expected the query to reject').toBeTruthy()
  const messages: string[] = []
  let cur: unknown = err
  while (cur instanceof Error) {
    messages.push(cur.message)
    cur = cur.cause
  }
  return messages.join(' | ')
}
