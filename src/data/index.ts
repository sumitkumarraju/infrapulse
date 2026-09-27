import type { DataSource } from '@/data/DataSource'
import { HttpDataSource } from '@/data/http/HttpDataSource'
import { MockDataSource } from '@/data/mock/MockDataSource'

/**
 * The swap point.
 *
 * Unset `VITE_API_URL` and the app runs entirely in the browser against the
 * deterministic mock — no server, no database, and the demo behaves identically
 * on every machine. Set it and the same screens read from the API in `server/`:
 *
 *   VITE_API_URL=http://localhost:8787 npm run dev
 *
 * Nothing else in the app imports from `mock/` or `http/`, so this is the only
 * line that has to change.
 */
const envUrl = import.meta.env.VITE_API_URL
const apiUrl =
  envUrl !== undefined && envUrl !== ''
    ? envUrl === 'mock'
      ? ''
      : envUrl
    : typeof window !== 'undefined' && import.meta.env.PROD
      ? window.location.origin
      : ''

export const dataSource: DataSource = apiUrl
  ? new HttpDataSource(String(apiUrl).replace(/\/$/, ''))
  : new MockDataSource()

/** True when the app is talking to a real server. */
export const isLive = Boolean(apiUrl)

export type { DataSource }
