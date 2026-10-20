import { fireEvent, render, screen } from '@testing-library/react'

import { compareRowKey } from '../../compareUtils'
import type { TraceOperation } from '../../traceOperations'
import { MAX_OPERATIONS, TraceOperationsTable } from './TraceOperationsTable'

function makeOperation(service_name: string, name: string, total_duration_nano: number): TraceOperation {
    return {
        key: compareRowKey({ service_name, name }),
        service_name,
        name,
        count: 1,
        total_duration_nano,
        avg_duration_nano: total_duration_nano,
        p50_duration_nano: total_duration_nano,
        share: total_duration_nano / 3_000_000,
    }
}

const orders = makeOperation('checkout-api', 'POST /api/orders', 2_000_000)
const cache = makeOperation('checkout-api', 'cache GET', 1_000_000)

describe('TraceOperationsTable', () => {
    it('highlights the clicked operation and clears the highlight when the same operation is clicked again', () => {
        // The second click must emit null. If it emits the key again, a click on the table can never
        // clear the dimming in the waterfall. The clicks go through the keyboard-reachable button, so
        // the test also fails when one click toggles twice (the button and then its row), or when the
        // button stops telling assistive technology which operation is highlighted.
        const onHighlightOperation = jest.fn()
        const { rerender } = render(
            <TraceOperationsTable
                operations={[orders, cache]}
                highlightedOperationKey={null}
                onHighlightOperation={onHighlightOperation}
            />
        )
        // Text query, not a role query: role queries walk the whole DOM and are slow in jsdom.
        const ordersButton = (): HTMLElement => screen.getByText('POST /api/orders').closest('button') as HTMLElement
        expect(ordersButton().getAttribute('aria-pressed')).toBe('false')

        fireEvent.click(ordersButton())
        rerender(
            <TraceOperationsTable
                operations={[orders, cache]}
                highlightedOperationKey={orders.key}
                onHighlightOperation={onHighlightOperation}
            />
        )
        expect(ordersButton().getAttribute('aria-pressed')).toBe('true')
        fireEvent.click(ordersButton())

        expect(onHighlightOperation.mock.calls).toEqual([[orders.key], [null]])
    })

    it('renders only the operations with the largest totals and says how many there are', () => {
        // A trace with many operations must not render every row. The last assertion also fails when
        // the cap keeps the wrong end of the list, because op-29 has the smallest total.
        const operations = Array.from({ length: 30 }, (_, index) =>
            makeOperation('catalog-api', `op-${index}`, (30 - index) * 1_000_000)
        )
        const { container } = render(
            <TraceOperationsTable
                operations={operations}
                highlightedOperationKey={null}
                onHighlightOperation={jest.fn()}
            />
        )

        expect(container.querySelectorAll('button[data-attr="tracing-trace-operations-highlight"]')).toHaveLength(
            MAX_OPERATIONS
        )
        expect(screen.getByText('Showing the top 25 of 30 operations by total time.')).toBeTruthy()
        expect(screen.queryByText('op-29')).toBeNull()
    })
})
