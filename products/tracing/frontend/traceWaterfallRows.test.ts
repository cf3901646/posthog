import { makeSpan } from './__mocks__/span'
import { buildSpanTree } from './spanTree'
import { buildWaterfallRows, rowKey, runTimeRange, type WaterfallRow } from './traceWaterfallRows'
import type { Span } from './types'

const TRACE_START_MS = Date.parse('2026-09-03T10:00:00.000Z')

function opSpan(id: string, parentId: string, name: string, offsetMs: number, serviceName = 'web'): Span {
    return makeSpan({
        uuid: id,
        span_id: id,
        parent_span_id: parentId,
        is_root_span: parentId === '',
        service_name: serviceName,
        name,
        timestamp: new Date(TRACE_START_MS + offsetMs).toISOString(),
        duration_nano: 10_000_000,
    })
}

function labels(rows: WaterfallRow[]): string[] {
    return rows.map((row) => (row.kind === 'run' ? `run:${row.nodes.length}` : row.node.span.name))
}

describe('buildWaterfallRows', () => {
    // A root with three cache reads. The second read makes a call of its own.
    const cacheTree = buildSpanTree([
        opSpan('root', '', 'GET /x', 0),
        opSpan('cache-1', 'root', 'cache GET', 1),
        opSpan('cache-2', 'root', 'cache GET', 2),
        opSpan('redis-1', 'cache-2', 'redis GET', 2),
        opSpan('cache-3', 'root', 'cache GET', 3),
    ])

    it('folds a run of three or more adjacent siblings and keeps an interleaved operation as a separator', () => {
        // The pair runs on another service, so it shares the span name but not the operation.
        // The call under the first read must stay hidden with its folded run.
        const tree = buildSpanTree([
            opSpan('root', '', 'GET /x', 0),
            opSpan('a1', 'root', 'cache GET', 1),
            opSpan('a1-call', 'a1', 'redis GET', 1),
            opSpan('a2', 'root', 'cache GET', 2),
            opSpan('a3', 'root', 'cache GET', 3),
            opSpan('select', 'root', 'SELECT', 4),
            opSpan('b1', 'root', 'cache GET', 5, 'worker'),
            opSpan('b2', 'root', 'cache GET', 6, 'worker'),
            opSpan('c1', 'root', 'cache GET', 7),
            opSpan('c2', 'root', 'cache GET', 8),
            opSpan('c3', 'root', 'cache GET', 9),
        ])

        expect(labels(buildWaterfallRows(tree, new Set(), new Set(), null))).toEqual([
            'GET /x',
            'run:3',
            'SELECT',
            'cache GET',
            'cache GET',
            'run:3',
        ])
    })

    it.each<[string, Set<string>, string | null]>([
        ['openRunIds has its first span', new Set(['cache-1']), null],
        ['the selected span is its second span', new Set(), 'cache-2'],
        // A deep link to a call made by a folded span must not land on a hidden row.
        ['the selected span sits under one of its spans', new Set(), 'redis-1'],
    ])(
        'expands a run when it is open, and when the selected span is inside it (%s)',
        (_, openRunIds, selectedSpanId) => {
            const rows = buildWaterfallRows(cacheTree, new Set(), openRunIds, selectedSpanId)

            expect(labels(rows)).toEqual(['GET /x', 'cache GET', 'cache GET', 'redis GET', 'cache GET'])
            // The waterfall reads the length on the first span to offer a control that folds the run back.
            expect(rows[1]).toMatchObject({ kind: 'span', openRunLength: 3 })
        }
    )

    it('hides a run inside a collapsed parent', () => {
        expect(labels(buildWaterfallRows(cacheTree, new Set(['root']), new Set(), null))).toEqual(['GET /x'])
    })

    it('never folds missing-parent placeholders, so each orphaned span keeps its own row', () => {
        const tree = buildSpanTree([1, 2, 3].map((i) => opSpan(`orphan-${i}`, `gone-${i}`, 'GET /x', i)))

        expect(buildWaterfallRows(tree, new Set(), new Set(), null).map(rowKey)).toEqual([
            'gone-1',
            'orphan-1',
            'gone-2',
            'orphan-2',
            'gone-3',
            'orphan-3',
        ])
    })

    it('runTimeRange spans from the first start to the last end and sums the durations', () => {
        const run = buildWaterfallRows(cacheTree, new Set(), new Set(), null).find(
            (row): row is Extract<WaterfallRow, { kind: 'run' }> => row.kind === 'run'
        )!

        expect(runTimeRange(run)).toEqual({
            startUs: (TRACE_START_MS + 1) * 1_000,
            endUs: (TRACE_START_MS + 13) * 1_000,
            totalDurationNano: 30_000_000,
        })
    })
})
