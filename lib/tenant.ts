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
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ tenantId: tenantMembers.tenantId })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId))
      .limit(1)
    if (existing) return existing.tenantId

    const [tenant] = await tx.insert(tenants).values({ name: displayName }).returning({ id: tenants.id })
    const inserted = await tx
      .insert(tenantMembers)
      .values({ userId, tenantId: tenant.id, role: 'owner' })
      .onConflictDoNothing({ target: tenantMembers.userId })
      .returning()

    if (inserted.length === 0) {
      // Lost a concurrent race: remove the orphan tenant we just created, return the winner's tenant
      await tx.delete(tenants).where(eq(tenants.id, tenant.id))
      const [winner] = await tx
        .select({ tenantId: tenantMembers.tenantId })
        .from(tenantMembers)
        .where(eq(tenantMembers.userId, userId))
        .limit(1)
      return winner.tenantId
    }

    return tenant.id
  })
}
