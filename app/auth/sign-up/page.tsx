'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signUpWithEmail } from './actions'

export default function SignUpPage() {
  const [state, formAction, isPending] = useActionState(signUpWithEmail, null)

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-bold">Εγγραφή</h1>

        <form action={formAction} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-1">
              Όνομα
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              autoComplete="name"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              Κωδικός
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {state?.error && (
            <p className="text-sm text-red-600">{state.error}</p>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? 'Εγγραφή…' : 'Εγγραφή'}
          </button>
        </form>

        <p className="text-sm text-center">
          Έχετε ήδη λογαριασμό;{' '}
          <Link href="/auth/sign-in" className="text-blue-600 hover:underline">
            Σύνδεση
          </Link>
        </p>
      </div>
    </main>
  )
}
