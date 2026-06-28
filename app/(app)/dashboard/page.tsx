import { getCurrentUser } from '@/lib/auth'
import { ensureTenantForUser } from '@/lib/tenant'

export default async function Dashboard() {
  const user = await getCurrentUser()
  if (!user) return null
  const tenantId = await ensureTenantForUser(user.id, user.email)
  return <main className="p-8">Practice ready. Tenant: {tenantId}</main>
}
