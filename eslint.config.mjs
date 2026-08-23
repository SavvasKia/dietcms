import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Enforce the DB-clock decision (see .superpowers/sdd/progress.md, Task 2):
  // every persisted timestamp comes from Postgres via sql`now()`, never from the
  // app clock. A skewed function host would otherwise write updated_at values
  // that precede created_at, which no test can catch reliably — a timestamp
  // window passes on a healthy host regardless of which clock produced it.
  //
  // A lint rule rather than a test that greps the source: it is AST-based, so a
  // `new Date` in a comment or string cannot false-positive and an unusual call
  // position cannot slip past, and it reports the offending line directly.
  // Scoped to lib/ and db/ — tests legitimately construct Dates to assert with.
  {
    files: ['lib/**/*.ts', 'db/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Persisted timestamps must come from the DB clock: use sql`now()` (see the dbNow helper in lib/clients.ts). new Date() is the app clock and can disagree with the database.',
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
