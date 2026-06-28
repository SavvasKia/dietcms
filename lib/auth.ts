import { stackServerApp } from '@/stack'

export async function getCurrentUser(): Promise<{ id: string; email: string } | null> {
  const user = await stackServerApp.getUser()
  if (!user) return null
  return { id: user.id, email: user.primaryEmail ?? '' }
}
