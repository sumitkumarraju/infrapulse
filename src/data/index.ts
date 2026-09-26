import type { DataSource } from '@/data/DataSource'
import { MockDataSource } from '@/data/mock/MockDataSource'

/**
 * The one line that changes when a real backend arrives:
 *
 *   export const dataSource: DataSource = new SupabaseDataSource()
 *
 * Nothing else in the app imports from `mock/`.
 */
export const dataSource: DataSource = new MockDataSource()

export type { DataSource }
