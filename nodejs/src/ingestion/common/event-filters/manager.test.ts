import { EventFilterManager, EventFilterManagerComponent } from './manager'

describe('EventFilterManager', () => {
    const mockPostgres = {
        query: jest.fn(),
    }

    async function buildManager(): Promise<{ manager: EventFilterManager; stop: () => Promise<void> }> {
        const scope = new EventFilterManagerComponent(mockPostgres as any, { pipeline: 'errortracking' })
        const started = await scope.start()
        return { manager: started.value, stop: started.stop }
    }

    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('returns null for unknown team', async () => {
        mockPostgres.query.mockResolvedValue({ rows: [] })
        const { manager, stop } = await buildManager()
        expect(manager.getFilter(999)).toBeNull()
        await stop()
    })

    it('returns filter for team in live mode', async () => {
        mockPostgres.query.mockResolvedValue({
            rows: [
                {
                    id: 'filter-1',
                    team_id: 1,
                    mode: 'live',
                    filter_tree: {
                        type: 'or',
                        children: [{ type: 'condition', field: 'event_name', operator: 'exact', value: '$drop' }],
                    },
                },
            ],
        })
        const { manager, stop } = await buildManager()

        const filter = manager.getFilter(1)
        expect(filter).not.toBeNull()
        expect(filter!.id).toBe('filter-1')
        expect(filter!.mode).toBe('live')

        await stop()
    })

    it('returns filter for team in dry_run mode', async () => {
        mockPostgres.query.mockResolvedValue({
            rows: [
                {
                    id: 'filter-dry',
                    team_id: 1,
                    mode: 'dry_run',
                    filter_tree: {
                        type: 'condition',
                        field: 'event_name',
                        operator: 'exact',
                        value: '$test',
                    },
                },
            ],
        })
        const { manager, stop } = await buildManager()

        const filter = manager.getFilter(1)
        expect(filter).not.toBeNull()
        expect(filter!.mode).toBe('dry_run')

        await stop()
    })

    it('returns null for filter with no conditions (empty tree)', async () => {
        mockPostgres.query.mockResolvedValue({
            rows: [
                {
                    id: 'filter-empty',
                    team_id: 1,
                    mode: 'live',
                    filter_tree: { type: 'or', children: [] },
                },
            ],
        })
        const { manager, stop } = await buildManager()

        expect(manager.getFilter(1)).toBeNull()

        await stop()
    })

    it('skips rows with invalid filter_tree', async () => {
        mockPostgres.query.mockResolvedValue({
            rows: [
                {
                    id: 'bad-filter',
                    team_id: 1,
                    mode: 'live',
                    filter_tree: { type: 'invalid' },
                },
                {
                    id: 'good-filter',
                    team_id: 2,
                    mode: 'live',
                    filter_tree: {
                        type: 'condition',
                        field: 'event_name',
                        operator: 'exact',
                        value: 'test',
                    },
                },
            ],
        })
        const { manager, stop } = await buildManager()

        expect(manager.getFilter(1)).toBeNull()
        expect(manager.getFilter(2)).not.toBeNull()
        expect(manager.getFilter(2)!.id).toBe('good-filter')

        await stop()
    })

    it('skips rows with empty condition value', async () => {
        mockPostgres.query.mockResolvedValue({
            rows: [
                {
                    id: 'empty-value',
                    team_id: 1,
                    mode: 'live',
                    filter_tree: {
                        type: 'condition',
                        field: 'event_name',
                        operator: 'exact',
                        value: '',
                    },
                },
            ],
        })
        const { manager, stop } = await buildManager()

        expect(manager.getFilter(1)).toBeNull()

        await stop()
    })

    const liveTree = { type: 'condition', field: 'event_name', operator: 'exact', value: 'a' }

    function mockQueryRows(rowsByQueryName: Record<string, unknown[]>): void {
        mockPostgres.query.mockImplementation((_use, _sql, _params, queryName: string) =>
            Promise.resolve({ rows: rowsByQueryName[queryName] ?? [] })
        )
    }

    it('keeps the loaded filters and overrides when a background reload fails', async () => {
        mockQueryRows({
            fetchAllEventFilters: [
                {
                    id: 'f1',
                    team_id: 1,
                    mode: 'live',
                    filter_tree: { type: 'condition', field: 'event_name', operator: 'exact', value: 'a' },
                },
            ],
            fetchEventFilterDropAllEventsTeams: [{ team_id: 2 }],
        })
        const { manager, stop } = await buildManager()
        mockPostgres.query.mockRejectedValue(new Error('connection refused'))
        const unhandledRejection = jest.fn()
        process.on('unhandledRejection', unhandledRejection)
        jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)

        try {
            manager.getFilter(1)
            manager.dropsAllEvents(2)
            await new Promise((resolve) => setImmediate(resolve))

            expect(mockPostgres.query).toHaveBeenCalledTimes(4)
            expect(unhandledRejection).not.toHaveBeenCalled()
            expect(manager.getFilter(1)!.id).toBe('f1')
            expect(manager.dropsAllEvents(2)).toBe(true)
        } finally {
            process.off('unhandledRejection', unhandledRejection)
            jest.restoreAllMocks()
            await stop()
        }
    })

    it.each([
        {
            name: 'filters',
            input: { failingQuery: 'fetchAllEventFilters' },
            expected: { loadedRows: [{ id: 'f1', team_id: 1, mode: 'live', filter_tree: liveTree }] },
        },
        {
            name: 'pipeline overrides',
            input: { failingQuery: 'fetchEventFilterDropAllEventsTeams' },
            expected: { loadedRows: [{ team_id: 1 }] },
        },
    ])('retries a failed first load of $name only after the refresh interval', async ({ input, expected }) => {
        const failingQueryCalls = (): number =>
            mockPostgres.query.mock.calls.filter((call) => call[3] === input.failingQuery).length
        const read = (manager: EventFilterManager): unknown =>
            input.failingQuery === 'fetchAllEventFilters' ? manager.getFilter(1) : manager.dropsAllEvents(1)
        mockPostgres.query.mockImplementation((_use, _sql, _params, queryName: string) =>
            queryName === input.failingQuery
                ? Promise.reject(new Error('connection refused'))
                : Promise.resolve({ rows: [] })
        )
        const { manager, stop } = await buildManager()

        try {
            for (let i = 0; i < 5; i++) {
                expect(read(manager)).toBeFalsy()
                await new Promise((resolve) => setImmediate(resolve))
            }
            expect(failingQueryCalls()).toBe(1)

            mockQueryRows({ [input.failingQuery]: expected.loadedRows })
            jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
            read(manager)
            await new Promise((resolve) => setImmediate(resolve))

            expect(failingQueryCalls()).toBe(2)
            expect(read(manager)).toBeTruthy()
        } finally {
            jest.restoreAllMocks()
            await stop()
        }
    })

    it('handles multiple teams', async () => {
        mockPostgres.query.mockResolvedValue({
            rows: [
                {
                    id: 'f1',
                    team_id: 1,
                    mode: 'live',
                    filter_tree: { type: 'condition', field: 'event_name', operator: 'exact', value: 'a' },
                },
                {
                    id: 'f2',
                    team_id: 2,
                    mode: 'dry_run',
                    filter_tree: { type: 'condition', field: 'distinct_id', operator: 'contains', value: 'bot' },
                },
            ],
        })
        const { manager, stop } = await buildManager()

        expect(manager.getFilter(1)!.id).toBe('f1')
        expect(manager.getFilter(2)!.id).toBe('f2')
        expect(manager.getFilter(3)).toBeNull()

        await stop()
    })
})
