import { auth } from '@/lib/auth/server'
import { headers } from 'next/headers'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email }
}
