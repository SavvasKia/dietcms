'use server'

import { auth } from '@/lib/auth/server'
import { APIError } from 'better-auth/api'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

export async function signUpWithEmail(
  _prevState: { error: string } | null,
  formData: FormData,
) {
  const email = formData.get('email') as string

  if (!email) {
    return { error: 'Το email είναι υποχρεωτικό.' }
  }

  try {
    await auth.api.signUpEmail({
      body: {
        email,
        name: formData.get('name') as string,
        password: formData.get('password') as string,
      },
      headers: await headers(),
    })
  } catch (error) {
    if (error instanceof APIError) {
      return { error: error.message || 'Αποτυχία εγγραφής. Δοκιμάστε ξανά.' }
    }
    throw error
  }

  redirect('/dashboard')
}
