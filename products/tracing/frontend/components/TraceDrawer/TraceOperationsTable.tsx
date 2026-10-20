import { memo, useCallback, useMemo } from 'react'

import { LemonTable, LemonTableColumns } from '@posthog/lemon-ui'

import { humanFriendlyNumber } from 'lib/utils/numbers'

import type { TraceOperation } from '../../traceOperations'
import { formatDuration } from '../../TraceWaterfallView'

// The panel lists the main contributors to the trace. The waterfall shows all of the spans.
export const MAX_OPERATIONS = 25

export interface TraceOperationsTableProps {
    /** Sorted by total time descending, as summarizeTraceOperations returns them; the cap keeps the head. */
    operations: TraceOperation[]
    highlightedOperationKey: string | null
    /** Called with the row's key, or null when the highlighted row is clicked again. */
    onHighlightOperation: (operationKey: string | null) => void
    /** The trace has spans that are not loaded yet, so the counts do not cover the whole trace. */
    partial?: boolean
}

function highlightTitle(isHighlighted: boolean): string {
    return isHighlighted ? 'Clear the highlight' : 'Highlight these spans in the waterfall'
}

function nextHighlightKey(operation: TraceOperation, highlightedOperationKey: string | null): string | null {
    return operation.key === highlightedOperationKey ? null : operation.key
}

// LemonTable renders `width: 0` as a 1% column, which shrinks to its content. The numeric columns do
// that, so Operation gets all the width they leave. The service name shares the Operation cell instead
// of a column of its own, so the table fits next to the span inspector in a 1280px window. max-w-0
// removes the cell text from the column's minimum width, so a long name truncates in its cell instead
// of widening the table. min-w-32 keeps enough of the name visible to read. Below that width, the
// table scrolls inside LemonTable's own container.
const NUMERIC_COLUMN = { width: 0, align: 'right', className: 'whitespace-nowrap' } as const

const NUMERIC_COLUMNS: LemonTableColumns<TraceOperation> = [
    {
        key: 'count',
        title: 'Spans',
        ...NUMERIC_COLUMN,
        sorter: (a, b) => a.count - b.count,
        render: (_, row) => humanFriendlyNumber(row.count),
    },
    {
        key: 'total',
        title: 'Total',
        ...NUMERIC_COLUMN,
        tooltip: 'Sum of span durations. Nested spans count in both parent and child.',
        sorter: (a, b) => a.total_duration_nano - b.total_duration_nano,
        render: (_, row) => <span className="font-mono">{formatDuration(row.total_duration_nano)}</span>,
    },
    {
        key: 'avg',
        title: 'Avg',
        ...NUMERIC_COLUMN,
        sorter: (a, b) => a.avg_duration_nano - b.avg_duration_nano,
        render: (_, row) => <span className="font-mono">{formatDuration(row.avg_duration_nano)}</span>,
    },
    {
        key: 'p50',
        title: 'p50',
        ...NUMERIC_COLUMN,
        sorter: (a, b) => a.p50_duration_nano - b.p50_duration_nano,
        render: (_, row) => <span className="font-mono">{formatDuration(row.p50_duration_nano)}</span>,
    },
    {
        key: 'share',
        title: 'Share',
        ...NUMERIC_COLUMN,
        tooltip: 'Total as a share of the trace duration. Nested spans can push this above 100%.',
        sorter: (a, b) => a.share - b.share,
        render: (_, row) => `${(row.share * 100).toFixed(1)}%`,
    },
]

// Memoized because the drawer re-renders on every mousemove of an inspector resize drag, and
// LemonTable does not virtualize its rows. The props stay the same during a drag, so the table skips
// that work. The stable callbacks below also keep the memo on each LemonTable row in place.
export const TraceOperationsTable = memo(function TraceOperationsTable({
    operations,
    highlightedOperationKey,
    onHighlightOperation,
    partial = false,
}: TraceOperationsTableProps): JSX.Element {
    const visibleOperations = useMemo(() => operations.slice(0, MAX_OPERATIONS), [operations])
    const columns = useMemo(
        (): LemonTableColumns<TraceOperation> => [
            {
                key: 'name',
                title: 'Operation',
                className: 'w-full max-w-0 min-w-32',
                sorter: (a, b) => a.name.localeCompare(b.name),
                render: (_, row) => {
                    const isHighlighted = row.key === highlightedOperationKey
                    // A table row cannot take keyboard focus, so the cell holds a real button for
                    // keyboard users. The row keeps its own click handler for mouse users.
                    return (
                        <button
                            type="button"
                            // pinned: autocapture selects on this value, so renaming it breaks saved actions
                            data-attr="tracing-trace-operations-highlight"
                            aria-pressed={isHighlighted}
                            className="block w-full font-mono text-left truncate cursor-pointer"
                            title={highlightTitle(isHighlighted)}
                            onClick={(event) => {
                                // Stop here so that the row handler does not toggle the highlight a second time.
                                event.stopPropagation()
                                onHighlightOperation(nextHighlightKey(row, highlightedOperationKey))
                            }}
                        >
                            <span title={`${row.service_name} ${row.name}`} translate="no">
                                <span className="text-muted">{row.service_name}</span> {row.name}
                            </span>
                        </button>
                    )
                },
            },
            ...NUMERIC_COLUMNS,
        ],
        [highlightedOperationKey, onHighlightOperation]
    )
    const onRow = useCallback(
        (row: TraceOperation): { onClick: () => void; title: string } => ({
            onClick: () => onHighlightOperation(nextHighlightKey(row, highlightedOperationKey)),
            title: highlightTitle(row.key === highlightedOperationKey),
        }),
        [highlightedOperationKey, onHighlightOperation]
    )
    const rowStatus = useCallback(
        (row: TraceOperation): 'highlighted' | null => (row.key === highlightedOperationKey ? 'highlighted' : null),
        [highlightedOperationKey]
    )

    return (
        <>
            {partial && <p className="text-xs text-muted mb-1">Counts cover the spans loaded so far.</p>}
            <LemonTable<TraceOperation>
                // pinned: autocapture and Playwright select on this value, so renaming it breaks them
                data-attr="tracing-trace-operations-table"
                size="small"
                embedded
                rowKey="key"
                columns={columns}
                dataSource={visibleOperations}
                defaultSorting={{ columnKey: 'total', order: -1 }}
                // The tracing scene keeps its own state in the URL. Sorting this table must not add an
                // `order` param to that URL or a browser history entry for each click on a header.
                useURLForSorting={false}
                onRow={onRow}
                rowStatus={rowStatus}
            />
            {operations.length > MAX_OPERATIONS && (
                <p className="text-xs text-muted mt-1">
                    {`Showing the top ${MAX_OPERATIONS} of ${humanFriendlyNumber(operations.length)} operations by total time.`}
                </p>
            )}
        </>
    )
})
