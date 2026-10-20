import { fireEvent, render, screen, within } from '@testing-library/react'

import { compareRowKey } from './compareUtils'
import { TraceWaterfallView } from './TraceWaterfallView'
import type { Span } from './types'

// Give the waterfall real dimensions so react-window renders rows (ResizeObserver is mocked globally
// in jest.setup.ts; AutoSizer returns 0×0 in jsdom without this).
jest.mock('lib/components/AutoSizer', () => ({
    AutoSizer: ({ renderProp }: { renderProp: (size: { height: number; width: number }) => React.ReactNode }) =>
        renderProp({ height: 600, width: 800 }),
}))

// uuid (ClickHouse row id) and span_id (OTel id) are deliberately DISTINCT so a test can tell which
// identity the click emits — the inspector/URL/tree all key on span_id, so selection must too.
function makeSpan(overrides: Partial<Span>): Span {
    return {
        uuid: 'uuid-x',
        trace_id: 'trace-1',
        span_id: 'span-x',
        parent_span_id: '',
        name: 'span',
        kind: 1,
        service_name: 'svc',
        status_code: 0,
        timestamp: '2026-06-11T08:00:00.000Z',
        end_time: '2026-06-11T08:00:00.010Z',
        duration_nano: 10_000_000,
        is_root_span: false,
        matched_filter: true,
        attributes: {},
        resource_attributes: {},
        ...overrides,
    }
}

const root = makeSpan({ uuid: 'uuid-root', span_id: 'span-root', name: 'root-operation', is_root_span: true })
const child = makeSpan({
    uuid: 'uuid-child',
    span_id: 'span-child',
    parent_span_id: 'span-root',
    name: 'child-operation',
})
const cacheReads = [1, 2, 3].map((offsetMs) =>
    makeSpan({
        uuid: `uuid-cache-${offsetMs}`,
        span_id: `span-cache-${offsetMs}`,
        parent_span_id: 'span-root',
        name: 'cache GET',
        timestamp: `2026-06-11T08:00:00.00${offsetMs}Z`,
    })
)

describe('TraceWaterfallView', () => {
    // Scope to the render's own container (no auto-cleanup here, and the name renders in both the
    // visible label and the Lemon Tooltip title — [0] is the label).
    const clickSpanRow = (container: HTMLElement, name: string): void => {
        fireEvent.click(within(container).getAllByText(name)[0])
    }

    it('emits the clicked span_id (not the row uuid) so the inspector and URL can resolve it', () => {
        const onSpanSelect = jest.fn()
        const { container } = render(<TraceWaterfallView spans={[root, child]} onSpanSelect={onSpanSelect} />)

        clickSpanRow(container, 'child-operation')

        expect(onSpanSelect).toHaveBeenCalledWith('span-child')
        expect(onSpanSelect).not.toHaveBeenCalledWith('uuid-child')
    })

    it('toggles selection off when the same span is clicked twice', () => {
        // Controlled: the parent (scene) flows the new selection back via the prop, so the second
        // click sees `child` selected and emits null. Simulate that round-trip with a rerender.
        const onSpanSelect = jest.fn()
        const { container, rerender } = render(<TraceWaterfallView spans={[root, child]} onSpanSelect={onSpanSelect} />)

        clickSpanRow(container, 'child-operation')
        rerender(<TraceWaterfallView spans={[root, child]} selectedSpanId="span-child" onSpanSelect={onSpanSelect} />)
        clickSpanRow(container, 'child-operation')

        expect(onSpanSelect).toHaveBeenNthCalledWith(1, 'span-child')
        expect(onSpanSelect).toHaveBeenNthCalledWith(2, null)
    })

    it('collapses a span subtree, hiding descendants without selecting the row', () => {
        const onSpanSelect = jest.fn()
        const { container } = render(<TraceWaterfallView spans={[root, child]} onSpanSelect={onSpanSelect} />)

        expect(within(container).queryAllByText('child-operation').length).toBeGreaterThan(0)

        fireEvent.click(within(container).getByLabelText('Collapse child spans'))

        expect(within(container).queryByText('child-operation')).toBeNull()
        // Toggling collapse must not double as selecting the row.
        expect(onSpanSelect).not.toHaveBeenCalled()
        // Re-expanding brings the child back.
        fireEvent.click(within(container).getByLabelText('Expand child spans'))
        expect(within(container).queryAllByText('child-operation').length).toBeGreaterThan(0)
    })

    it('collapses and expands every span via the header toggle', () => {
        const { container } = render(<TraceWaterfallView spans={[root, child]} />)

        fireEvent.click(within(container).getByLabelText('Collapse all spans'))
        expect(within(container).queryByText('child-operation')).toBeNull()

        fireEvent.click(within(container).getByLabelText('Expand all spans'))
        expect(within(container).queryAllByText('child-operation').length).toBeGreaterThan(0)
    })

    // The operations table highlights by compareRowKey. If the waterfall matches spans on a different
    // key, a click on a table row dims the wrong spans. A trace opened from a filtered list marks the
    // spans outside the filter as unmatched, and the list filter must not hide the highlighted operation.
    it.each([
        ['inside the list filter', child],
        ['outside the list filter', { ...child, matched_filter: false }],
    ])(
        'with the highlighted span %s, dims every span outside the highlighted operation and nothing before',
        (_name, highlightedChild) => {
            const spans = [root, highlightedChild]
            const { container, rerender } = render(<TraceWaterfallView spans={spans} />)
            const label = (name: string): HTMLElement => within(container).getAllByText(name)[0]
            expect(label('root-operation').className).not.toContain('opacity-40')

            rerender(<TraceWaterfallView spans={spans} highlightedOperationKey={compareRowKey(highlightedChild)} />)

            expect(label('root-operation').className).toContain('opacity-40')
            expect(label('child-operation').className).not.toContain('opacity-40')
        }
    )

    // A loop of identical calls must not push the rest of the trace out of view, and opening the folded
    // row must not double as selecting a span, which would open the inspector on a span nobody picked.
    it('folds three adjacent siblings into one run row that expands on click without selecting a span', () => {
        const onSpanSelect = jest.fn()
        const { container } = render(<TraceWaterfallView spans={[root, ...cacheReads]} onSpanSelect={onSpanSelect} />)

        expect(within(container).queryByText('cache GET')).toBeNull()
        fireEvent.click(within(container).getByText('cache GET \u00D73'))

        expect(within(container).getAllByText('cache GET')).toHaveLength(3)
        expect(onSpanSelect).not.toHaveBeenCalled()

        fireEvent.click(within(container).getByLabelText('Fold 3 cache GET spans'))

        expect(within(container).getByText('cache GET \u00D73')).toBeTruthy()
        expect(within(container).queryByText('cache GET')).toBeNull()
        expect(onSpanSelect).not.toHaveBeenCalled()
    })

    // A folded run is the only row left for its operation, so a run row that ignores the highlight
    // leaves the operation the user picked in the operations table dim, or lights up the wrong one.
    it.each([
        ['root', compareRowKey(root), true],
        ['run', compareRowKey(cacheReads[0]), false],
    ])(
        'with the %s operation highlighted, dims a run outside the highlighted operation and keeps a matching run bright',
        (_name, highlightedOperationKey, isDimmed) => {
            const { container } = render(
                <TraceWaterfallView spans={[root, ...cacheReads]} highlightedOperationKey={highlightedOperationKey} />
            )

            expect(within(container).getByText('cache GET \u00D73').className.includes('opacity-40')).toBe(isDimmed)
        }
    )

    // A deep link to a span inside a run must land on that span's own row and not on a folded row that
    // hides it. The selection alone holds the run open, so a fold control there would do nothing.
    it('opens the run that holds the selected span', () => {
        const { container } = render(<TraceWaterfallView spans={[root, ...cacheReads]} selectedSpanId="span-cache-2" />)

        expect(within(container).getAllByText('cache GET')).toHaveLength(3)
        expect(within(container).queryByText('cache GET \u00D73')).toBeNull()
        expect(within(container).queryByLabelText('Fold 3 cache GET spans')).toBeNull()
    })

    it('does not render a collapse toggle for leaf spans', () => {
        const { container } = render(<TraceWaterfallView spans={[root]} />)

        expect(within(container).queryByLabelText('Collapse child spans')).toBeNull()
        expect(within(container).queryByLabelText('Collapse all spans')).toBeNull()
    })

    it('does not show a parent span missing row for a root span with the all-zero parent id', () => {
        const zeroParentRoot = { ...root, parent_span_id: '0000000000000000' }
        const { container } = render(<TraceWaterfallView spans={[zeroParentRoot, child]} />)

        expect(container.querySelectorAll('[data-row-key^="missing-parent-"]')).toHaveLength(0)
        expect(within(container).queryByText('<parent span missing>')).toBeNull()
    })

    it('puts spans whose parent is not loaded under one parent span missing row, which selects the missing id', async () => {
        const onSpanSelect = jest.fn()
        const sibling = makeSpan({
            uuid: 'uuid-sibling',
            span_id: 'span-sibling',
            parent_span_id: 'span-root',
            name: 'sibling-operation',
        })
        const { container } = render(<TraceWaterfallView spans={[child, sibling]} onSpanSelect={onSpanSelect} />)

        expect(container.querySelectorAll('[data-row-key^="missing-parent-"]')).toHaveLength(1)
        const missingLabel = within(container).getAllByText('<parent span missing>')[0]
        fireEvent.pointerEnter(missingLabel, { pointerType: 'mouse' })
        fireEvent.mouseEnter(missingLabel)
        fireEvent.mouseMove(missingLabel)
        expect(await screen.findByText('span span-root not found', undefined, { timeout: 2000 })).toBeTruthy()

        clickSpanRow(container, '<parent span missing>')
        expect(onSpanSelect).toHaveBeenCalledWith('span-root')

        fireEvent.click(within(container).getByLabelText('Collapse child spans'))
        expect(within(container).queryByText('child-operation')).toBeNull()
        expect(within(container).queryByText('sibling-operation')).toBeNull()
    })

    it('does not request more spans when hasMore is false', () => {
        const onLoadMore = jest.fn()
        render(<TraceWaterfallView spans={[root, child]} hasMore={false} onLoadMore={onLoadMore} />)

        expect(onLoadMore).not.toHaveBeenCalled()
    })

    it('requests more spans at most once per loaded count, even across rerenders with the same spans', () => {
        // The runaway bug: a page that returns no new rows leaves the window pinned at the bottom, so
        // the trigger refires every render. The guard pages once per loaded count — re-rendering with
        // the same spans (the loading-more flag toggling back) must not refire.
        const onLoadMore = jest.fn()
        const { rerender } = render(<TraceWaterfallView spans={[root, child]} hasMore onLoadMore={onLoadMore} />)

        expect(onLoadMore).toHaveBeenCalledTimes(1)

        rerender(<TraceWaterfallView spans={[root, child]} hasMore loadingMore onLoadMore={onLoadMore} />)
        rerender(<TraceWaterfallView spans={[root, child]} hasMore onLoadMore={onLoadMore} />)

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('requests more again once new spans grow the loaded count', () => {
        const grandchild = makeSpan({
            uuid: 'uuid-grandchild',
            span_id: 'span-grandchild',
            parent_span_id: 'span-child',
            name: 'grandchild-operation',
        })
        const onLoadMore = jest.fn()
        const { rerender } = render(<TraceWaterfallView spans={[root, child]} hasMore onLoadMore={onLoadMore} />)

        expect(onLoadMore).toHaveBeenCalledTimes(1)

        rerender(<TraceWaterfallView spans={[root, child, grandchild]} hasMore onLoadMore={onLoadMore} />)

        expect(onLoadMore).toHaveBeenCalledTimes(2)
    })
})
