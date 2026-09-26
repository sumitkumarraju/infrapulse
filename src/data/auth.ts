import { isLive } from '@/data'

/* Signing in to the engineer dashboard.
 *
 * Auth is a property of the transport, not of the data: the mock runs entirely
 * in the browser with no server to authenticate against, and pretending
 * otherwise would mean a fake login screen guarding data that is already on the
 * page. So in mock mode these report "signed in" and do nothing, and the gate
 * in RequireOperator disappears.
 *
 * The session is an HttpOnly cookie, which is why nothing here returns or
 * stores a token — the browser attaches it and no script can read it.
 */

const baseUrl = String(import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    // Without this the browser will not send the session cookie cross-origin,
    // and every request looks anonymous.
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
}

export async function checkSession(): Promise<boolean> {
  if (!isLive) return true

  try {
    const response = await call('/api/auth/me')
    if (!response.ok) return false
    const body = (await response.json()) as { signedIn: boolean }
    return body.signedIn
  } catch {
    // The server being unreachable is not the same as being signed out, but
    // from the dashboard's point of view there is nothing to show either way.
    return false
  }
}

export async function signIn(
  password: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!isLive) return { ok: true }

  try {
    const response = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    })

    if (response.ok) return { ok: true }

    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string }
    } | null

    return {
      ok: false,
      message: body?.error?.message ?? 'Could not sign in.',
    }
  } catch {
    return { ok: false, message: 'Could not reach the server.' }
  }
}

export async function signOut(): Promise<void> {
  if (!isLive) return
  await call('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
}
