import { BackgroundRefresher } from '~/common/utils/background-refresher'
import { PostgresRouter, PostgresUse } from '~/common/utils/db/postgres'
import { IngestionPipeline } from '~/common/utils/event-ingestion-restrictions'
import { logger } from '~/common/utils/logger'
import { Component } from '~/ingestion/common/scopes'

import { treeHasConditions } from './evaluate'
import { eventFiltersOverrideRefreshErrors, eventFiltersRefreshErrors } from './metrics'
import { EventFilterRowSchema, EventFilterRule } from './schema'

export interface EventFilterManagerOptions {
    pipeline: IngestionPipeline
}

/**
 * Wraps a load so that a failure before the first success resolves to `empty`. The refresher
 * caches that value and retries after its interval. Without a cached value, it would retry on
 * every read. Later failures rethrow, so the refresher keeps the last loaded value.
 */
function emptyUntilLoaded<T>(load: () => Promise<T>, empty: () => T, reportError: (error: unknown) => void) {
    let loaded = false
    return async (): Promise<T> => {
        try {
            const value = await load()
            loaded = true
            return value
        } catch (error) {
            if (loaded) {
                throw error
            }
            reportError(error)
            return empty()
        }
    }
}

/**
 * Manages per-team event filter config loaded from Postgres. One filter
 * per team, cached via a `BackgroundRefresher` that reloads all active
 * filters every 60s. The pipeline overrides that drop all events for
 * `options.pipeline` reload the same way. The constructor does not prime the cache; call
 * `prime()` (or wrap construction in `EventFilterManagerComponent`) to
 * await the initial load.
 */
export class EventFilterManager {
    private refresher: BackgroundRefresher<Map<number, EventFilterRule>>
    private dropAllEventsTeams: BackgroundRefresher<Set<number>>

    constructor(
        private readonly postgres: PostgresRouter,
        private readonly options: EventFilterManagerOptions
    ) {
        const reportFilterError = (error: unknown): void => {
            logger.error('Failed to refresh event filter config', { error })
            eventFiltersRefreshErrors.inc()
        }
        const reportOverrideError = (error: unknown): void => {
            logger.error('Failed to refresh event filter pipeline overrides', {
                pipeline: this.options.pipeline,
                error,
            })
            eventFiltersOverrideRefreshErrors.inc()
        }
        // The error handlers must not rethrow. The refresher calls them from a detached promise,
        // and the server stops on an unhandled rejection.
        this.refresher = new BackgroundRefresher(
            emptyUntilLoaded(
                () => this.fetchAllFilters(),
                () => new Map(),
                reportFilterError
            ),
            60_000,
            reportFilterError
        )
        this.dropAllEventsTeams = new BackgroundRefresher(
            emptyUntilLoaded(
                () => this.fetchDropAllEventsTeams(),
                () => new Set(),
                reportOverrideError
            ),
            60_000,
            reportOverrideError
        )
    }

    async prime(): Promise<void> {
        await Promise.all([this.refresher.get(), this.dropAllEventsTeams.get()])
    }

    /** Returns the filter for a team, or null if disabled or has no conditions. Non-blocking. */
    getFilter(teamId: number): EventFilterRule | null {
        const filter = this.refresher.tryGet()?.get(teamId) ?? null
        if (filter && !treeHasConditions(filter.filter_tree)) {
            return null
        }
        return filter
    }

    /**
     * True when the team's override drops every event in this pipeline. Non-blocking. Until
     * the first successful load it returns false, so events are ingested: a wrong drop cannot
     * be undone.
     */
    dropsAllEvents(teamId: number): boolean {
        return this.dropAllEventsTeams.tryGet()?.has(teamId) ?? false
    }

    private async fetchDropAllEventsTeams(): Promise<Set<number>> {
        // Overrides are stored under the parent team of an environment.
        const { rows } = await this.postgres.query<{ team_id: number }>(
            PostgresUse.COMMON_READ,
            `SELECT t.id AS team_id
             FROM posthog_eventfilterpipelineoverride o
             JOIN posthog_team t ON COALESCE(t.parent_team_id, t.id) = o.team_id
             WHERE o.pipeline = $1 AND o.drop_all_events`,
            [this.options.pipeline],
            'fetchEventFilterDropAllEventsTeams'
        )
        return new Set(rows.map((row) => Number(row.team_id)))
    }

    private async fetchAllFilters(): Promise<Map<number, EventFilterRule>> {
        const { rows } = await this.postgres.query<{
            id: string
            team_id: number
            mode: string
            filter_tree: unknown
        }>(
            PostgresUse.COMMON_READ,
            `SELECT id, team_id, mode, filter_tree
             FROM posthog_eventfilterconfig
             WHERE mode != 'disabled' AND filter_tree IS NOT NULL`,
            [],
            'fetchAllEventFilters'
        )

        const map = new Map<number, EventFilterRule>()
        for (const row of rows) {
            const parsed = EventFilterRowSchema.safeParse(row)
            if (parsed.success) {
                map.set(parsed.data.team_id, parsed.data)
            } else {
                logger.warn('Skipping invalid event filter config', {
                    team_id: row.team_id,
                    id: row.id,
                    error: parsed.error.message,
                })
            }
        }

        logger.debug('🔁 event_filter_manager - refreshed filters', { teamCount: map.size })
        return map
    }
}

/**
 * Scope entry for `EventFilterManager`. `start()` constructs the manager
 * and awaits the initial cache prime before handing it back. Stop is a
 * no-op — dropping the manager and refresher references lets GC reclaim
 * them.
 */
export class EventFilterManagerComponent implements Component<EventFilterManager> {
    constructor(
        private readonly postgres: PostgresRouter,
        private readonly options: EventFilterManagerOptions
    ) {}

    async start(): Promise<{ value: EventFilterManager; stop: () => Promise<void> }> {
        const manager = new EventFilterManager(this.postgres, this.options)
        await manager.prime()
        return { value: manager, stop: () => Promise.resolve() }
    }
}
