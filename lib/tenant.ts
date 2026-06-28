import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { tenants, tenantMembers } from '@/db/schema'

export function decideBootstrap(
  existingTenantId: string | null,
): { action: 'create' } | { action: 'reuse'; tenantId: string } {
  return existingTenantId
    ? { action: 'reuse', tenantId: existingTenantId }
    : { action: 'create' }
}

export async function getTenantIdForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1)
  return row?.tenantId ?? null
}

export async function ensureTenantForUser(userId: string, displayName: string): Promise<string> {
  const existing = await getTenantIdForUser(userId)
  const decision = decideBootstrap(existing)
  if (decision.action === 'reuse') return decision.tenantId

  const [tenant] = await db.insert(tenants).values({ name: displayName }).returning({ id: tenants.id })
  await db.insert(tenantMembers).values({ userId, tenantId: tenant.id, role: 'owner' })
  return tenant.id
}
