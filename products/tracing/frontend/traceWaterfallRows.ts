import { compareRowKey } from './compareUtils'
import { parseTimestampUs, type SpanNode } from './spanTree'

export const MIN_RUN_LENGTH = 3

export type WaterfallRow =
    | {
          kind: 'span'
          node: SpanNode
          /** Set on the first span of an open run, so its row can offer to fold the run back. */
          openRunLength?: number
      }
    /**
     * Adjacent siblings with one operation, folded. `nodes` is in start order and nodes[0] identifies the run.
     * `key` is the operation key that every member shares.
     */
    | { kind: 'run'; nodes: SpanNode[]; key: string }

function byStart(nodes: SpanNode[]): SpanNode[] {
    return [...nodes].sort((a, b) => parseTimestampUs(a.span.timestamp) - parseTimestampUs(b.span.timestamp))
}

/** The selected span and its ancestors. A run that holds one of them stays open, so the selection is never folded away. */
function selectedPathOf(roots: SpanNode[], selectedSpanId: string | null): Set<SpanNode> {
    const path = new Set<SpanNode>()
    if (!selectedSpanId) {
        return path
    }
    const stack = [...roots]
    while (stack.length > 0) {
        const node = stack.pop()!
        if (node.span.span_id === selectedSpanId) {
            for (let ancestor: SpanNode | null = node; ancestor; ancestor = ancestor.parent) {
                path.add(ancestor)
            }
            return path
        }
        for (const child of node.children) {
            stack.push(child)
        }
    }
    return path
}

function siblingRows(siblings: SpanNode[], openRunIds: Set<string>, selectedPath: Set<SpanNode>): WaterfallRow[] {
    const sorted = byStart(siblings)
    const rows: WaterfallRow[] = []
    let start = 0
    while (start < sorted.length) {
        const first = sorted[start]
        const key = compareRowKey(first.span)
        let end = start + 1
        // Placeholders all share one label, but each one stands for a different absent parent, so they never fold.
        while (
            !first.isMissingParent &&
            end < sorted.length &&
            !sorted[end].isMissingParent &&
            compareRowKey(sorted[end].span) === key
        ) {
            end++
        }
        const group = sorted.slice(start, end)
        start = end
        if (group.length < MIN_RUN_LENGTH) {
            for (const node of group) {
                rows.push({ kind: 'span', node })
            }
            continue
        }
        const isOpen = openRunIds.has(first.span.span_id) || group.some((node) => selectedPath.has(node))
        if (!isOpen) {
            rows.push({ kind: 'run', nodes: group, key })
            continue
        }
        rows.push({ kind: 'span', node: first, openRunLength: group.length })
        for (const node of group.slice(1)) {
            rows.push({ kind: 'span', node })
        }
    }
    return rows
}

/**
 * Depth first like `flattenTree`. Adjacent siblings with one operation fold into one row, so a loop of identical
 * calls does not push the rest of the trace out of view.
 */
export function buildWaterfallRows(
    roots: SpanNode[],
    collapsedSpanIds: Set<string>,
    openRunIds: Set<string>,
    selectedSpanId: string | null
): WaterfallRow[] {
    const selectedPath = selectedPathOf(roots, selectedSpanId)
    const rows: WaterfallRow[] = []
    // An explicit stack, in reverse so the earliest sibling pops first, keeps deep traces off the call stack.
    const stack = siblingRows(roots, openRunIds, selectedPath).reverse()
    while (stack.length > 0) {
        const row = stack.pop()!
        rows.push(row)
        // A run row stands for its spans as one unit, so their children stay hidden until the run opens.
        if (row.kind === 'span' && !collapsedSpanIds.has(row.node.span.span_id)) {
            const children = siblingRows(row.node.children, openRunIds, selectedPath)
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push(children[i])
            }
        }
    }
    return rows
}

export function rowKey(row: WaterfallRow): string {
    return row.kind === 'span' ? row.node.span.span_id : row.nodes[0].span.span_id
}

export function rowOperationKey(row: WaterfallRow): string {
    return row.kind === 'span' ? compareRowKey(row.node.span) : row.key
}

export function runTimeRange(row: Extract<WaterfallRow, { kind: 'run' }>): {
    startUs: number
    endUs: number
    totalDurationNano: number
} {
    let startUs = Infinity
    let endUs = -Infinity
    let totalDurationNano = 0
    for (const { span } of row.nodes) {
        const spanStartUs = parseTimestampUs(span.timestamp)
        startUs = Math.min(startUs, spanStartUs)
        // A span bar ends at start plus duration, and an earlier span can outlast a later one,
        // so the run ends at the latest of those ends and not at the last span's end.
        endUs = Math.max(endUs, spanStartUs + span.duration_nano / 1_000)
        totalDurationNano += span.duration_nano
    }
    return { startUs, endUs, totalDurationNano }
}
