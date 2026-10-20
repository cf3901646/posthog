import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { List, useDynamicRowHeight, useListRef } from 'react-window'

import { IconChevronRight, IconCollapse, IconExpand, IconWarning } from '@posthog/icons'
import { LemonButton, Spinner } from '@posthog/lemon-ui'

import { getSeriesColor } from 'lib/colors'
import { AutoSizer } from 'lib/components/AutoSizer'
import { SizeProps } from 'lib/components/AutoSizer/AutoSizer'
import { Tooltip } from 'lib/lemon-ui/Tooltip'
import { cn } from 'lib/utils/css-classes'
import { humanFriendlyNumber } from 'lib/utils/numbers'

import { compareRowKey } from './compareUtils'
import {
    buildSpanTree,
    collectCollapsibleSpanIds,
    connectorLinesOf,
    countDescendants,
    getTimelineTicks,
    parseTimestampUs,
    type SpanNode,
} from './spanTree'
import { buildWaterfallRows, rowKey, rowOperationKey, runTimeRange, type WaterfallRow } from './traceWaterfallRows'
import type { Span } from './types'

interface TraceWaterfallViewProps {
    spans: Span[]
    /** Currently-selected span (controlled by the scene's URL-canonical state). */
    selectedSpanId?: string | null
    onSpanSelect?: (spanId: string | null) => void
    /** The trace has more spans than are loaded — show the infinite-scroll affordance at the bottom. */
    hasMore?: boolean
    /** A next page of spans is being fetched. */
    loadingMore?: boolean
    onLoadMore?: () => void
    /** Dim every span outside this operation (compareRowKey). Null dims nothing. */
    highlightedOperationKey?: string | null
}

export function formatDuration(durationNano: number): string {
    const us = durationNano / 1_000
    if (us < 100) {
        return `${us.toFixed(1)}\u00B5s`
    }
    const ms = us / 1_000
    if (ms < 1000) {
        return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`
    }
    return `${(ms / 1000).toFixed(2)}s`
}

export function buildServiceColorMap(spans: Span[]): Map<string, number> {
    const services = [...new Set(spans.map((s) => s.service_name))].sort()
    const map = new Map<string, number>()
    services.forEach((service, i) => map.set(service, i))
    return map
}

const INDENT_PX = 16
const DEFAULT_LABEL_COLUMN_WIDTH = 280
const MIN_LABEL_COLUMN_WIDTH = 120
const MAX_LABEL_COLUMN_WIDTH = 800
const LABEL_COLUMN_WIDTH_STORAGE_KEY = 'tracing-trace-label-width'
/** Hit area for the vertical splitter (centered on the label/timeline border). */
const LABEL_SPLITTER_HIT_PX = 8
const ROW_HEIGHT = 32
// Cap the windowed list viewport; taller traces scroll inside it instead of growing the modal.
const MAX_WATERFALL_HEIGHT = 600
// Fetch the next page once the bottom of the rendered window is within this many rows of the end.
const LOAD_MORE_THRESHOLD = 10
// Rough extra room reserved when a span's detail panel is open, so a selection near the top of a
// short trace doesn't pop an unexpected scrollbar.

function clampLabelColumnWidth(px: number): number {
    return Math.min(MAX_LABEL_COLUMN_WIDTH, Math.max(MIN_LABEL_COLUMN_WIDTH, Math.round(px)))
}

function readStoredLabelColumnWidth(): number | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        const raw = window.localStorage.getItem(LABEL_COLUMN_WIDTH_STORAGE_KEY)
        if (raw == null) {
            return null
        }
        const n = Number.parseInt(raw, 10)
        if (!Number.isFinite(n)) {
            return null
        }
        return clampLabelColumnWidth(n)
    } catch {
        return null
    }
}
const ERROR_COLOR = 'var(--danger)'

const TREE_LINE_W = 2
const TREE_COLOR = 'var(--border-bold)'
// Extend vertical lines well beyond row edges to eliminate subpixel gaps between siblings
const TREE_OVERFLOW = 2

function TreeIndent({
    node,
    isLastChild = node.isLastChild,
}: {
    node: SpanNode
    isLastChild?: boolean
}): JSX.Element | null {
    if (node.depth === 0) {
        return null
    }

    const mid = INDENT_PX / 2
    const connectorLines = connectorLinesOf(node)

    return (
        <span className="flex shrink-0 items-stretch self-stretch overflow-visible">
            {/* Continuation lines for ancestor levels */}
            {connectorLines.slice(0, -1).map((hasContinuation, i) => (
                <span
                    key={i}
                    className="shrink-0 relative overflow-visible"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ width: INDENT_PX }}
                >
                    {hasContinuation && (
                        <span
                            className="absolute"
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{
                                left: mid - TREE_LINE_W / 2,
                                top: -TREE_OVERFLOW,
                                bottom: -TREE_OVERFLOW,
                                width: TREE_LINE_W,
                                backgroundColor: TREE_COLOR,
                            }}
                        />
                    )}
                </span>
            ))}
            {/* Branch connector */}
            <span
                className="shrink-0 relative overflow-visible"
                // eslint-disable-next-line react/forbid-dom-props
                style={{ width: INDENT_PX }}
            >
                {/* Vertical line — full height for middle children, stops at center for last child */}
                <span
                    className="absolute"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{
                        left: mid - TREE_LINE_W / 2,
                        top: -TREE_OVERFLOW,
                        bottom: isLastChild ? '50%' : -TREE_OVERFLOW,
                        width: TREE_LINE_W,
                        backgroundColor: TREE_COLOR,
                    }}
                />
                {/* Horizontal line from vertical to right edge */}
                <span
                    className="absolute"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{
                        left: mid - TREE_LINE_W / 2,
                        right: 0,
                        top: `calc(50% - ${TREE_LINE_W / 2}px)`,
                        height: TREE_LINE_W,
                        backgroundColor: TREE_COLOR,
                    }}
                />
            </span>
        </span>
    )
}

interface WaterfallRowData {
    rows: WaterfallRow[]
    traceStartUs: number
    traceDurationUs: number
    serviceColorMap: Map<string, number>
    ticks: number[]
    labelColumnWidth: number
    selectedSpanId: string | null
    onSelect: (spanId: string) => void
    collapsedSpanIds: Set<string>
    onToggleCollapse: (spanId: string) => void
    openRunIds: Set<string>
    /** A run is identified by the span_id of its first span. */
    onSetRunOpen: (firstSpanId: string, isOpen: boolean) => void
    highlightedOperationKey: string | null
    dynamicRowHeight: ReturnType<typeof useDynamicRowHeight>
}

type RunRow = Extract<WaterfallRow, { kind: 'run' }>

function WaterfallSpanRow({
    node,
    traceStartUs,
    traceDurationUs,
    serviceColorMap,
    ticks,
    labelColumnWidth,
    selectedSpanId,
    onSelect,
    collapsedSpanIds,
    onToggleCollapse,
    onSetRunOpen,
    highlightedOperationKey,
    foldableRunLength,
}: Omit<WaterfallRowData, 'rows' | 'openRunIds' | 'dynamicRowHeight'> & {
    node: SpanNode
    /** Set on the first span of a run that the user opened, so the row can fold the run back. */
    foldableRunLength?: number
}): JSX.Element {
    const { span, isMissingParent = false } = node
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedSpanIds.has(span.span_id)
    const hiddenDescendants = isCollapsed ? countDescendants(node) : 0
    const spanStartUs = parseTimestampUs(span.timestamp)
    const spanDurationUs = span.duration_nano / 1_000
    const leftPct = traceDurationUs > 0 ? Math.max(((spanStartUs - traceStartUs) / traceDurationUs) * 100, 0) : 0
    const rawWidthPct = traceDurationUs > 0 ? (spanDurationUs / traceDurationUs) * 100 : 100
    const widthPct = Math.max(Math.min(rawWidthPct, 100 - leftPct), 0.3)

    const isError = span.status_code === 2
    // While an operation is highlighted, the highlight alone decides. A trace opened from a filtered
    // list marks the spans outside the filter as unmatched, and the operation the user picked can be
    // one of those, so the list filter must not dim it.
    const isDimmed =
        highlightedOperationKey != null ? compareRowKey(span) !== highlightedOperationKey : !span.matched_filter
    const seriesIndex = serviceColorMap.get(span.service_name) ?? 0
    const seriesColor = isError ? ERROR_COLOR : getSeriesColor(seriesIndex)
    const barColor = isDimmed ? 'var(--border)' : seriesColor
    // Select by span_id (the OTel id the tree is keyed by, and what the inspector/URL resolve),
    // not the ClickHouse row uuid.
    const isSelected = selectedSpanId === span.span_id
    const foldLabel =
        foldableRunLength != null ? `Fold ${humanFriendlyNumber(foldableRunLength)} ${span.name} spans` : null
    const foldControl = foldLabel != null && (
        <Tooltip title={foldLabel}>
            <button
                type="button"
                className="flex items-center justify-center w-4 h-4 rounded text-muted hover:text-default hover:bg-fill-button-tertiary-hover"
                aria-label={foldLabel}
                aria-expanded
                // pinned: data-attr value, because renaming it breaks autocapture dashboards and Playwright selectors
                data-attr="tracing-waterfall-fold-run"
                onClick={(e) => {
                    e.stopPropagation()
                    onSetRunOpen(span.span_id, false)
                }}
            >
                <IconChevronRight className="rotate-90" fontSize={14} />
            </button>
        </Tooltip>
    )
    return (
        <div>
            <div
                // The 3px left border is always reserved (transparent when unselected) so selecting
                // a span shows an accent bar without shifting the row content.
                className={`flex items-stretch cursor-pointer transition-colors border-l-[3px] ${
                    isSelected
                        ? 'bg-surface-primary-active border-l-accent'
                        : 'border-l-transparent hover:bg-surface-primary-hover'
                }`}
                // eslint-disable-next-line react/forbid-dom-props
                style={{ minHeight: ROW_HEIGHT }}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                onClick={() => onSelect(span.span_id)}
                onKeyDown={(e) => {
                    // A toggle inside the row handles its own keys. Without this check, Enter on the
                    // toggle bubbles here and selects the row instead of activating the toggle.
                    if (e.target !== e.currentTarget) {
                        return
                    }
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelect(span.span_id)
                    }
                }}
            >
                {/* Label column */}
                <div
                    className="shrink-0 flex items-center overflow-hidden border-r border-border px-2"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ width: labelColumnWidth }}
                >
                    <TreeIndent node={node} />
                    <span className="shrink-0 flex items-center justify-center w-4 self-stretch">
                        {hasChildren ? (
                            <Tooltip title={isCollapsed ? 'Expand child spans' : 'Collapse child spans'}>
                                <button
                                    type="button"
                                    className="flex items-center justify-center w-4 h-4 rounded text-muted hover:text-default hover:bg-fill-button-tertiary-hover"
                                    aria-label={isCollapsed ? 'Expand child spans' : 'Collapse child spans'}
                                    aria-expanded={!isCollapsed}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        onToggleCollapse(span.span_id)
                                    }}
                                >
                                    <IconChevronRight
                                        className={cn('transition-transform', !isCollapsed && 'rotate-90')}
                                        fontSize={14}
                                    />
                                </button>
                            </Tooltip>
                        ) : (
                            foldControl
                        )}
                    </span>
                    {isError && (
                        <Tooltip title="This span has an error status">
                            <IconWarning className="text-danger shrink-0 mr-1" fontSize={14} />
                        </Tooltip>
                    )}
                    <Tooltip title={isMissingParent ? `span ${span.span_id} not found` : span.name}>
                        <span
                            className={`text-xs truncate ${isError || isMissingParent ? 'text-danger' : ''} ${
                                isSelected || isError ? 'font-semibold' : 'font-medium'
                            } ${isDimmed ? 'opacity-40' : ''}`}
                        >
                            {span.name}
                        </span>
                    </Tooltip>
                    {isCollapsed && (
                        <Tooltip title={`${hiddenDescendants} hidden child span${hiddenDescendants === 1 ? '' : 's'}`}>
                            <span className="shrink-0 ml-1 px-1 rounded text-[10px] leading-4 font-medium text-muted bg-fill-button-tertiary-hover">
                                {hiddenDescendants}
                            </span>
                        </Tooltip>
                    )}
                    {/* The chevron slot already holds the collapse toggle, so the fold control moves to the end. */}
                    {hasChildren && foldControl && <span className="shrink-0 ml-auto pl-1">{foldControl}</span>}
                </div>

                {/* Timeline column */}
                <div
                    className="relative grow self-center"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ height: ROW_HEIGHT - 8 }}
                >
                    {/* Grid lines */}
                    {ticks.map((tickUs) => {
                        const pct = (tickUs / traceDurationUs) * 100
                        return (
                            <span
                                key={tickUs}
                                className="absolute top-0 bottom-0 border-l border-border"
                                // eslint-disable-next-line react/forbid-dom-props
                                style={{ left: `${pct}%` }}
                            />
                        )
                    })}

                    {/* Span bar */}
                    {!isMissingParent && (
                        <Tooltip
                            title={
                                <span>
                                    <strong>{span.name}</strong>
                                    <br />
                                    {span.service_name} · {formatDuration(span.duration_nano)}
                                    {isError ? ' · Error' : ''}
                                </span>
                            }
                        >
                            <div
                                className="absolute h-full flex items-center px-1.5 overflow-hidden"
                                // eslint-disable-next-line react/forbid-dom-props
                                style={{
                                    left: `${leftPct}%`,
                                    width: `${widthPct}%`,
                                    minWidth: 2,
                                    backgroundColor: `color-mix(in srgb, ${barColor} 20%, transparent)`,
                                    borderLeft: `1px solid ${barColor}`,
                                }}
                            >
                                <span
                                    className={`text-[11px] truncate whitespace-nowrap flex items-center gap-1.5 ${isDimmed ? 'opacity-40' : ''}`}
                                >
                                    <span className="text-muted-alt font-medium">{span.service_name}</span>
                                    <span className="text-muted">{formatDuration(span.duration_nano)}</span>
                                </span>
                            </div>
                        </Tooltip>
                    )}
                </div>
            </div>
        </div>
    )
}

function WaterfallRunRow({
    row,
    traceStartUs,
    traceDurationUs,
    serviceColorMap,
    ticks,
    labelColumnWidth,
    onSetRunOpen,
    highlightedOperationKey,
}: Pick<
    WaterfallRowData,
    | 'traceStartUs'
    | 'traceDurationUs'
    | 'serviceColorMap'
    | 'ticks'
    | 'labelColumnWidth'
    | 'onSetRunOpen'
    | 'highlightedOperationKey'
> & { row: RunRow }): JSX.Element {
    const first = row.nodes[0]
    const { span } = first
    // A run can hold thousands of spans and the drawer re-renders on every resize drag. The row object
    // stays the same until the rows rebuild, so this pass over the members runs once per run.
    const { startUs, endUs, totalDurationNano, errorCount, anyMatched } = useMemo(
        () => ({
            ...runTimeRange(row),
            errorCount: row.nodes.filter((node) => node.span.status_code === 2).length,
            anyMatched: row.nodes.some((node) => node.span.matched_filter),
        }),
        [row]
    )
    const countText = humanFriendlyNumber(row.nodes.length)
    const label = `${span.name} \u00D7${countText}`
    const durationText = formatDuration(totalDurationNano)
    const leftPct = traceDurationUs > 0 ? Math.max(((startUs - traceStartUs) / traceDurationUs) * 100, 0) : 0
    const rawWidthPct = traceDurationUs > 0 ? ((endUs - startUs) / traceDurationUs) * 100 : 100
    const widthPct = Math.max(Math.min(rawWidthPct, 100 - leftPct), 0.3)
    const isError = errorCount > 0
    const isDimmed = highlightedOperationKey != null ? row.key !== highlightedOperationKey : !anyMatched
    const seriesColor = isError ? ERROR_COLOR : getSeriesColor(serviceColorMap.get(span.service_name) ?? 0)
    const barColor = isDimmed ? 'var(--border)' : seriesColor

    return (
        <button
            type="button"
            className="flex items-stretch w-full text-left cursor-pointer transition-colors border-l-[3px] border-l-transparent hover:bg-surface-primary-hover"
            // eslint-disable-next-line react/forbid-dom-props
            style={{ minHeight: ROW_HEIGHT }}
            aria-expanded={false}
            aria-label={`Expand ${countText} ${span.name} spans`}
            // pinned: data-attr value, because renaming it breaks autocapture dashboards and Playwright selectors
            data-attr="tracing-waterfall-expand-run"
            onClick={() => onSetRunOpen(span.span_id, true)}
        >
            {/* Label column */}
            <span
                className="shrink-0 flex items-center overflow-hidden border-r border-border px-2"
                // eslint-disable-next-line react/forbid-dom-props
                style={{ width: labelColumnWidth }}
            >
                {/* The run stands for all of its spans, so its branch line ends only when its last span is the last sibling. */}
                <TreeIndent node={first} isLastChild={row.nodes[row.nodes.length - 1].isLastChild} />
                <span className="shrink-0 flex items-center justify-center w-4 self-stretch text-muted">
                    <IconChevronRight fontSize={14} />
                </span>
                {isError && (
                    <Tooltip
                        title={
                            errorCount === 1
                                ? '1 of these spans has an error status'
                                : `${humanFriendlyNumber(errorCount)} of these spans have an error status`
                        }
                    >
                        <IconWarning className="text-danger shrink-0 mr-1" fontSize={14} />
                    </Tooltip>
                )}
                <span
                    className={cn(
                        'text-xs truncate',
                        isError ? 'text-danger font-semibold' : 'font-medium',
                        isDimmed && 'opacity-40'
                    )}
                    translate="no"
                >
                    {label}
                </span>
            </span>

            {/* Timeline column */}
            <span
                className="relative grow self-center"
                // eslint-disable-next-line react/forbid-dom-props
                style={{ height: ROW_HEIGHT - 8 }}
            >
                {ticks.map((tickUs) => (
                    <span
                        key={tickUs}
                        className="absolute top-0 bottom-0 border-l border-border"
                        // eslint-disable-next-line react/forbid-dom-props
                        style={{ left: `${(tickUs / traceDurationUs) * 100}%` }}
                    />
                ))}
                <Tooltip
                    title={
                        <span>
                            <strong translate="no">{label}</strong>
                            <br />
                            <span translate="no">{span.service_name}</span> · <span translate="no">{countText}</span>{' '}
                            spans · <span translate="no">{durationText}</span> in total
                            <br />
                            <span translate="no">{`+${formatDuration((startUs - traceStartUs) * 1_000)}`}</span> to{' '}
                            <span translate="no">{`+${formatDuration((endUs - traceStartUs) * 1_000)}`}</span> from the
                            trace start
                        </span>
                    }
                >
                    <span
                        className="absolute h-full flex items-center px-1.5 overflow-hidden"
                        // eslint-disable-next-line react/forbid-dom-props
                        style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            minWidth: 2,
                            backgroundColor: `color-mix(in srgb, ${barColor} 20%, transparent)`,
                            borderLeft: `1px solid ${barColor}`,
                        }}
                    >
                        <span className={cn('text-[11px] truncate text-muted', isDimmed && 'opacity-40')}>
                            <span className="text-muted-alt font-medium" translate="no">
                                {span.service_name}
                            </span>{' '}
                            · <span translate="no">{countText}</span> spans · <span translate="no">{durationText}</span>
                        </span>
                    </span>
                </Tooltip>
            </span>
        </button>
    )
}

function WaterfallListRow({
    ariaAttributes,
    index,
    style,
    rows,
    traceStartUs,
    traceDurationUs,
    serviceColorMap,
    ticks,
    labelColumnWidth,
    selectedSpanId,
    onSelect,
    collapsedSpanIds,
    onToggleCollapse,
    openRunIds,
    onSetRunOpen,
    highlightedOperationKey,
    dynamicRowHeight,
}: {
    ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
    index: number
    style: CSSProperties
} & WaterfallRowData): JSX.Element {
    const rowRef = useRef<HTMLDivElement>(null)
    const row = rows[index]

    useEffect(() => {
        if (rowRef.current) {
            return dynamicRowHeight.observeRowElements([rowRef.current])
        }
    }, [dynamicRowHeight])

    return (
        <div
            {...ariaAttributes}
            ref={rowRef}
            // eslint-disable-next-line react/forbid-dom-props
            style={style}
            data-index={index}
            data-row-key={row.kind === 'span' ? row.node.span.uuid : `run-${row.nodes[0].span.uuid}`}
        >
            {row.kind === 'run' ? (
                <WaterfallRunRow
                    row={row}
                    traceStartUs={traceStartUs}
                    traceDurationUs={traceDurationUs}
                    serviceColorMap={serviceColorMap}
                    ticks={ticks}
                    labelColumnWidth={labelColumnWidth}
                    onSetRunOpen={onSetRunOpen}
                    highlightedOperationKey={highlightedOperationKey}
                />
            ) : (
                <WaterfallSpanRow
                    node={row.node}
                    traceStartUs={traceStartUs}
                    traceDurationUs={traceDurationUs}
                    serviceColorMap={serviceColorMap}
                    ticks={ticks}
                    labelColumnWidth={labelColumnWidth}
                    selectedSpanId={selectedSpanId}
                    onSelect={onSelect}
                    collapsedSpanIds={collapsedSpanIds}
                    onToggleCollapse={onToggleCollapse}
                    onSetRunOpen={onSetRunOpen}
                    highlightedOperationKey={highlightedOperationKey}
                    // A run that holds the selected span stays open whatever openRunIds says, so a fold
                    // control on a run that only the selection opened would do nothing.
                    foldableRunLength={openRunIds.has(row.node.span.span_id) ? row.openRunLength : undefined}
                />
            )}
        </div>
    )
}

export function TraceWaterfallView({
    spans,
    selectedSpanId = null,
    onSpanSelect,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
    highlightedOperationKey = null,
}: TraceWaterfallViewProps): JSX.Element {
    const [cursorPct, setCursorPct] = useState<number | null>(null)
    const [labelColumnWidth, setLabelColumnWidth] = useState(
        () => readStoredLabelColumnWidth() ?? DEFAULT_LABEL_COLUMN_WIDTH
    )
    const labelResizeActiveRef = useRef(false)
    const labelSplitterDragCleanupRef = useRef<(() => void) | null>(null)
    const timelineRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        return () => {
            labelSplitterDragCleanupRef.current?.()
        }
    }, [])
    const [collapsedSpanIds, setCollapsedSpanIds] = useState<Set<string>>(() => new Set())
    const [openRunIds, setOpenRunIds] = useState<Set<string>>(() => new Set())
    const serviceColorMap = useMemo(() => buildServiceColorMap(spans), [spans])
    const tree = useMemo(() => buildSpanTree(spans), [spans])
    const rows = useMemo(
        () => buildWaterfallRows(tree, collapsedSpanIds, openRunIds, selectedSpanId),
        [tree, collapsedSpanIds, openRunIds, selectedSpanId]
    )
    const collapsibleSpanIds = useMemo(() => collectCollapsibleSpanIds(tree), [tree])
    const allCollapsed = collapsibleSpanIds.size > 0 && collapsedSpanIds.size >= collapsibleSpanIds.size
    const dynamicRowHeight = useDynamicRowHeight({ defaultRowHeight: ROW_HEIGHT })

    const handleToggleCollapse = useCallback((spanId: string): void => {
        setCollapsedSpanIds((prev) => {
            const next = new Set(prev)
            if (next.has(spanId)) {
                next.delete(spanId)
            } else {
                next.add(spanId)
            }
            return next
        })
    }, [])

    const handleSetRunOpen = useCallback((firstSpanId: string, isOpen: boolean): void => {
        setOpenRunIds((prev) => {
            if (prev.has(firstSpanId) === isOpen) {
                return prev
            }
            const next = new Set(prev)
            if (isOpen) {
                next.add(firstSpanId)
            } else {
                next.delete(firstSpanId)
            }
            return next
        })
    }, [])

    const handleToggleCollapseAll = useCallback((): void => {
        setCollapsedSpanIds((prev) => (prev.size >= collapsibleSpanIds.size ? new Set() : new Set(collapsibleSpanIds)))
    }, [collapsibleSpanIds])
    const listRef = useListRef(null)

    // Infinite scroll: fetch the next page once the rendered window nears the end of the loaded spans.
    // Tracks the span count we last paged against so the trigger fires at most once per loaded count —
    // without this, a page that returns no new rows (dupes / end of data) leaves the window pinned at
    // the bottom and the trigger spins on every render, pegging the CPU. The guard counts spans, not
    // rows, because a page whose spans all fold into an existing run adds no row, and a row-count guard
    // would then stop paging for good.
    const lastRequestedSpanCountRef = useRef(-1)
    const handleRowsRendered = useCallback(
        (
            _visibleRows: { startIndex: number; stopIndex: number },
            allRows: { startIndex: number; stopIndex: number }
        ): void => {
            if (!onLoadMore || !hasMore || loadingMore) {
                return
            }
            if (allRows.stopIndex < rows.length - 1 - LOAD_MORE_THRESHOLD) {
                return
            }
            if (lastRequestedSpanCountRef.current === spans.length) {
                return
            }
            lastRequestedSpanCountRef.current = spans.length
            onLoadMore()
        },
        [onLoadMore, hasMore, loadingMore, rows.length, spans.length]
    )

    // Deep links land with a span anchor — scroll it into view once the tree is built. The anchor
    // is captured at mount (the drawer keys this component by trace, so it remounts per trace) so
    // later selection changes from clicking don't recenter, and data refreshes (full-trace fetch
    // replacing the prefetch) don't yank scroll after the user has started exploring.
    const initialSpanRef = useRef(selectedSpanId)
    const scrolledToInitialRef = useRef(false)
    useEffect(() => {
        if (scrolledToInitialRef.current || !initialSpanRef.current || rows.length === 0) {
            return
        }
        const index = rows.findIndex((row) => rowKey(row) === initialSpanRef.current)
        if (index >= 0) {
            listRef.current?.scrollToRow({ index, align: 'center' })
            scrolledToInitialRef.current = true
        }
    }, [rows, listRef])

    // The first span of a large operation often sits far down the tree, so a click on the operations
    // table must scroll that span into view. The `smart` alignment keeps the list still when that span
    // is already visible, so the click does not move the rows the user is reading. The ref holds the
    // last key that scrolled, so that a collapse, an expand, or a new page of spans does not pull the
    // list back to the operation.
    const lastScrolledOperationKeyRef = useRef<string | null>(null)
    useEffect(() => {
        if (highlightedOperationKey == null) {
            lastScrolledOperationKeyRef.current = null
            return
        }
        if (lastScrolledOperationKeyRef.current === highlightedOperationKey) {
            return
        }
        const index = rows.findIndex((row) => rowOperationKey(row) === highlightedOperationKey)
        if (index >= 0) {
            listRef.current?.scrollToRow({ index, align: 'smart' })
            lastScrolledOperationKeyRef.current = highlightedOperationKey
        }
    }, [highlightedOperationKey, rows, listRef])

    // Controlled: emit the new selection (toggling off if the same span is clicked) and let the
    // scene flow it back via `selectedSpanId`. No internal copy, so highlight can't drift from the URL.
    const handleSelect = useCallback(
        (spanId: string): void => {
            onSpanSelect?.(selectedSpanId === spanId ? null : spanId)
        },
        [selectedSpanId, onSpanSelect]
    )

    const { traceStartUs, traceDurationUs } = useMemo(() => {
        if (spans.length === 0) {
            return { traceStartUs: 0, traceDurationUs: 0 }
        }
        const startTimesUs = spans.map((s) => parseTimestampUs(s.timestamp))
        const endTimesUs = spans.map((s) => parseTimestampUs(s.timestamp) + s.duration_nano / 1_000)
        const traceStartUs = Math.min(...startTimesUs)
        const traceEndUs = Math.max(...endTimesUs)
        return { traceStartUs, traceDurationUs: traceEndUs - traceStartUs }
    }, [spans])

    // Pre-compute snap points (span start/end as percentages of trace duration)
    const snapPointsPct = useMemo(() => {
        if (traceDurationUs <= 0) {
            return []
        }
        const points = new Set<number>()
        for (const s of spans) {
            const spanStartUs = parseTimestampUs(s.timestamp)
            points.add(((spanStartUs - traceStartUs) / traceDurationUs) * 100)
            points.add(((spanStartUs + s.duration_nano / 1_000 - traceStartUs) / traceDurationUs) * 100)
        }
        return [...points].sort((a, b) => a - b)
    }, [spans, traceStartUs, traceDurationUs])

    const SNAP_THRESHOLD_PX = 6

    const persistLabelColumnWidth = useCallback((width: number): void => {
        try {
            window.localStorage.setItem(LABEL_COLUMN_WIDTH_STORAGE_KEY, String(width))
        } catch {
            // Quota or private mode
        }
    }, [])

    const handleLabelSplitterMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            setCursorPct(null)
            labelResizeActiveRef.current = true
            document.body.classList.add('is-resizing')
            const startX = e.clientX
            const startWidth = labelColumnWidth
            let lastWidth = startWidth

            const onMove = (ev: MouseEvent): void => {
                lastWidth = clampLabelColumnWidth(startWidth + (ev.clientX - startX))
                setLabelColumnWidth(lastWidth)
            }
            const onUp = (): void => {
                labelSplitterDragCleanupRef.current = null
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                document.body.classList.remove('is-resizing')
                labelResizeActiveRef.current = false
                persistLabelColumnWidth(lastWidth)
            }
            labelSplitterDragCleanupRef.current = onUp
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
        },
        [labelColumnWidth, persistLabelColumnWidth]
    )

    const handleLabelSplitterKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                const delta = e.key === 'ArrowLeft' ? -10 : 10
                setLabelColumnWidth((w) => {
                    const next = clampLabelColumnWidth(w + delta)
                    persistLabelColumnWidth(next)
                    return next
                })
            }
        },
        [persistLabelColumnWidth]
    )

    const handleTimelineMouseMove = useCallback(
        (e: React.MouseEvent) => {
            if (labelResizeActiveRef.current) {
                return
            }
            const timeline = timelineRef.current
            if (!timeline) {
                return
            }
            const rect = timeline.getBoundingClientRect()
            const x = e.clientX - rect.left
            if (x < 0 || x > rect.width) {
                setCursorPct(null)
                return
            }
            let pct = Math.max(0, Math.min(100, (x / rect.width) * 100))

            // Snap to nearest span edge if within threshold
            const pxPerPct = rect.width / 100
            for (const snapPct of snapPointsPct) {
                if (Math.abs(pct - snapPct) * pxPerPct <= SNAP_THRESHOLD_PX) {
                    pct = snapPct
                    break
                }
            }

            setCursorPct(pct)
        },
        [snapPointsPct]
    )

    const handleTimelineMouseLeave = useCallback(() => {
        setCursorPct(null)
    }, [])

    if (spans.length === 0) {
        return <div className="text-muted p-4">No spans in this trace</div>
    }

    const ticks = getTimelineTicks(traceDurationUs)

    const cursorTimeUs = cursorPct !== null ? (cursorPct / 100) * traceDurationUs : null

    return (
        <div
            className="flex flex-col relative"
            onMouseMove={handleTimelineMouseMove}
            onMouseLeave={handleTimelineMouseLeave}
        >
            {/* Full-height cursor line overlay */}
            {cursorPct !== null && (
                <div
                    className="absolute top-0 bottom-0 border-l border-dashed border-primary pointer-events-none z-20"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{
                        left: `calc(${labelColumnWidth}px + (100% - ${labelColumnWidth}px) * ${cursorPct / 100})`,
                    }}
                />
            )}

            {/* Timeline header */}
            <div className="flex border-b border-border sticky top-0 bg-surface-primary z-10">
                <div
                    className="shrink-0 text-xs font-medium text-muted pl-2 pr-1 flex items-center justify-between gap-1 border-r border-border"
                    // eslint-disable-next-line react/forbid-dom-props
                    style={{ width: labelColumnWidth }}
                >
                    <span>Span</span>
                    {collapsibleSpanIds.size > 0 && (
                        <Tooltip title={allCollapsed ? 'Expand all spans' : 'Collapse all spans'}>
                            <LemonButton
                                size="xsmall"
                                icon={allCollapsed ? <IconExpand /> : <IconCollapse />}
                                onClick={handleToggleCollapseAll}
                                aria-label={allCollapsed ? 'Expand all spans' : 'Collapse all spans'}
                            />
                        </Tooltip>
                    )}
                </div>
                <div className="relative grow h-7" ref={timelineRef}>
                    {(cursorPct === null || cursorPct > 5) && (
                        <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] text-muted">0</span>
                    )}
                    {ticks
                        .filter((tickUs) => {
                            const pct = (tickUs / traceDurationUs) * 100
                            return pct > 5 && pct < 90
                        })
                        .map((tickUs) => {
                            const pct = (tickUs / traceDurationUs) * 100
                            return (
                                <span
                                    key={tickUs}
                                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 text-[10px] text-muted"
                                    // eslint-disable-next-line react/forbid-dom-props
                                    style={{ left: `${pct}%` }}
                                >
                                    {formatDuration(tickUs * 1_000)}
                                </span>
                            )
                        })}
                    {(cursorPct === null || cursorPct < 95) && (
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-muted">
                            {formatDuration(traceDurationUs * 1_000)}
                        </span>
                    )}
                    {/* Cursor time label in header */}
                    {cursorPct !== null && cursorTimeUs !== null && (
                        <span
                            className={`absolute bottom-0 text-[10px] font-mono font-medium pointer-events-none ${
                                cursorPct < 50 ? 'translate-x-1' : '-translate-x-full -ml-1'
                            }`}
                            // eslint-disable-next-line react/forbid-dom-props
                            style={{ left: `${cursorPct}%` }}
                        >
                            {formatDuration(cursorTimeUs * 1_000)}
                        </span>
                    )}
                </div>
            </div>

            {/* Span rows (virtualized) */}
            <AutoSizer
                disableHeight
                renderProp={({ width }: SizeProps) => (
                    <List<WaterfallRowData>
                        style={{
                            height: Math.min(rows.length * ROW_HEIGHT, MAX_WATERFALL_HEIGHT),
                            width,
                        }}
                        overscanCount={10}
                        rowCount={rows.length}
                        rowHeight={dynamicRowHeight}
                        rowComponent={WaterfallListRow}
                        rowProps={{
                            rows,
                            traceStartUs,
                            traceDurationUs,
                            serviceColorMap,
                            ticks,
                            labelColumnWidth,
                            selectedSpanId,
                            onSelect: handleSelect,
                            collapsedSpanIds,
                            onToggleCollapse: handleToggleCollapse,
                            openRunIds,
                            onSetRunOpen: handleSetRunOpen,
                            highlightedOperationKey,
                            dynamicRowHeight,
                        }}
                        onRowsRendered={handleRowsRendered}
                        listRef={listRef}
                    />
                )}
            />

            {/* Infinite-scroll footer: a trace can exceed the per-page span cap, so page the rest in
                as the user scrolls to the bottom. The button is a manual fallback to the auto-trigger. */}
            {hasMore && (
                <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted border-t border-border">
                    {loadingMore ? (
                        <>
                            <Spinner />
                            <span>Loading more spans…</span>
                        </>
                    ) : (
                        <LemonButton size="xsmall" type="tertiary" onClick={() => onLoadMore?.()}>
                            Load more spans
                        </LemonButton>
                    )}
                </div>
            )}

            {/* Full-height splitter between label column and timeline */}
            <div
                role="separator"
                aria-label="Resize span name column"
                aria-orientation="vertical"
                aria-valuenow={labelColumnWidth}
                aria-valuemin={MIN_LABEL_COLUMN_WIDTH}
                aria-valuemax={MAX_LABEL_COLUMN_WIDTH}
                tabIndex={0}
                className="absolute top-0 bottom-0 z-30 cursor-ew-resize touch-none hover:bg-accent-highlight-primary/30"
                // eslint-disable-next-line react/forbid-dom-props
                style={{
                    left: labelColumnWidth - LABEL_SPLITTER_HIT_PX / 2,
                    width: LABEL_SPLITTER_HIT_PX,
                }}
                onMouseDown={handleLabelSplitterMouseDown}
                onKeyDown={handleLabelSplitterKeyDown}
            />
        </div>
    )
}
