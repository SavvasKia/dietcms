import { auth } from '@/lib/auth/server'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const { data: session } = await auth.getSession()
  if (!session?.user) return null
  return { id: session.user.id, email: session.user.email ?? '' }
}
