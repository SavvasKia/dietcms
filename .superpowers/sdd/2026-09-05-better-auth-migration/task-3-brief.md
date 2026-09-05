### Task 3: API route handler

**Files:**
- Modify: `app/api/auth/[...path]/route.ts`

**Interfaces:**
- Consumes: `auth` from `lib/auth/server.ts` (Task 2).
- Produces: `GET`, `POST` route exports — no other task consumes these directly (Next.js routes them by URL).

- [ ] **Step 1: Rewrite the handler**

```ts
import { auth } from '@/lib/auth/server'
import { toNextJsHandler } from 'better-auth/next-js'

export const { GET, POST } = toNextJsHandler(auth)
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/auth/\[...path\]/route.ts
git commit -m "feat: swap auth API route handler to better-auth's toNextJsHandler

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WUuVy2RNrDfxWAVui9w2uc"
```

---

