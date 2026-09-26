/* The only bridge between screens and data. Components import from here, never
 * from `mock/`, so the DataSource swap stays a one-file change. */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { qk } from '@/data/DataSource'
import { dataSource } from '@/data'
import type { LiveEvent, Segment, SegmentStatus } from '@/data/types'
import { useDemoStore } from '@/store/demoStore'

export function useSegments() {
  return useQuery({
    queryKey: qk.segments,
    queryFn: () => dataSource.getSegments(),
    staleTime: Infinity,
  })
}

export function useSegmentStatus() {
  return useQuery({
    queryKey: qk.status,
    queryFn: () => dataSource.getSegmentStatus(),
    staleTime: Infinity,
  })
}

export function useKpis() {
  return useQuery({ queryKey: qk.kpis, queryFn: () => dataSource.getKpis() })
}

export function useSegmentHistory(id: number | null) {
  return useQuery({
    queryKey: qk.history(id ?? -1),
    queryFn: () => dataSource.getSegmentHistory(id!),
    enabled: id !== null,
    staleTime: Infinity,
  })
}

export function useForecast(id: number | null) {
  return useQuery({
    queryKey: qk.forecast(id ?? -1),
    queryFn: () => dataSource.getForecast(id!),
    enabled: id !== null,
    staleTime: Infinity,
  })
}

export function usePhotoReports() {
  return useQuery({
    queryKey: qk.photos,
    queryFn: () => dataSource.getPhotoReports(),
  })
}

export function useWorkOrders() {
  return useQuery({
    queryKey: qk.workOrders,
    queryFn: () => dataSource.getWorkOrders(),
  })
}

export function useProjectedScores(dayOffset: number) {
  return useQuery({
    queryKey: qk.projected(dayOffset),
    queryFn: () => dataSource.getProjectedScores(dayOffset),
    staleTime: Infinity,
  })
}

/** Segments joined to their status, which is what every map layer wants. */
export interface SegmentWithStatus extends Segment {
  status: SegmentStatus
}

export function useSegmentsWithStatus(): {
  data: SegmentWithStatus[]
  byId: Map<number, SegmentWithStatus>
  isLoading: boolean
  error: unknown
} {
  const segments = useSegments()
  const statuses = useSegmentStatus()

  const data = useMemo(() => {
    if (!segments.data || !statuses.data) return []
    const statusById = new Map(statuses.data.map((s) => [s.id, s]))
    return segments.data
      .map((segment) => {
        const status = statusById.get(segment.id)
        return status ? { ...segment, status } : null
      })
      .filter((s): s is SegmentWithStatus => s !== null)
  }, [segments.data, statuses.data])

  const byId = useMemo(() => new Map(data.map((s) => [s.id, s])), [data])

  return {
    data,
    byId,
    isLoading: segments.isLoading || statuses.isLoading,
    error: segments.error ?? statuses.error,
  }
}

/**
 * The live feed. Keeps the most recent `limit` events, counts bumps into the
 * persisted store so the KPI ticks, and never re-subscribes on re-render.
 */
export function useLiveEvents(limit = 40) {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [latest, setLatest] = useState<LiveEvent | null>(null)
  const countBump = useDemoStore((s) => s.countBump)
  const queryClient = useQueryClient()
  const seen = useRef(0)

  useEffect(() => {
    const unsubscribe = dataSource.subscribeLive((event) => {
      setEvents((previous) => [event, ...previous].slice(0, limit))
      setLatest(event)

      if (event.type === 'bump') {
        countBump()
        seen.current += 1
        // The KPI bar reads bumpsToday from the DataSource, so nudge it
        // occasionally rather than on every single bump.
        if (seen.current % 3 === 0) {
          void queryClient.invalidateQueries({ queryKey: qk.kpis })
        }
      }
    })

    return unsubscribe
  }, [limit, countBump, queryClient])

  return { events, latest }
}
