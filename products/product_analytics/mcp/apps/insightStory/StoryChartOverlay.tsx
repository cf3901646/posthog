/* eslint-disable react/forbid-dom-props -- pixel positions from the chart's scales */
import { type ReactElement, type SyntheticEvent } from 'react'

import { useChartLayout } from '@posthog/quill-charts'

import type { StoryPage } from './storyPages'

// The brand orange in both themes, so the highlight never reads as one of the chart's series.
const HIGHLIGHT_COLOR = 'var(--primary-light)'
const MARKER_SIZE = 20
const MARKER_GAP = 12
const TAIL_WIDTH = 8
const FEATHER = 28
const MIN_REACH = 22
const BAR_PADDING = 4

interface Band {
    left: number
    right: number
}

// The chart runs its own hover and click on this layer, and a marker must not start them.
const stopPropagation = (event: SyntheticEvent): void => event.stopPropagation()

export interface StoryChartOverlayProps {
    seriesKey: string
    pages: StoryPage[]
    /** The page whose stretch is lit: the one on show, or the one the pointer is over. */
    highlightedIndex: number
    activeIndex: number
    onSelect: (index: number) => void
}

export function StoryChartOverlay({
    seriesKey,
    pages,
    highlightedIndex,
    activeIndex,
    onSelect,
}: StoryChartOverlayProps): ReactElement | null {
    const { scales, dimensions, labels, series, theme, resolvePositionValue } = useChartLayout()
    const chartSeries = series.find((candidate) => candidate.key === seriesKey)
    const highlighted = pages[highlightedIndex]
    if (!chartSeries || !highlighted) {
        return null
    }

    const { plotLeft, plotTop, plotWidth, plotHeight } = dimensions
    const plotRight = plotLeft + plotWidth
    const xAt = (index: number): number | null => {
        const label = labels[index]
        const x = label == null ? undefined : scales.x(label, chartSeries.key)
        return x == null || !isFinite(x) ? null : x
    }
    const first = xAt(0)
    const second = xAt(1)
    const step = first !== null && second !== null ? Math.abs(second - first) : plotWidth
    // A bar fills its slot. A lone point on a line needs its neighbours in view to read as a rise or a fall.
    const barWidth = labels[0] == null ? undefined : scales.extent?.(labels[0])
    const range = highlighted.range
    const isOnePoint = !!range && range[0] === range[1]
    const reach =
        barWidth !== undefined
            ? barWidth / 2 + (isOnePoint ? BAR_PADDING : 0)
            : isOnePoint
              ? Math.max(step, MIN_REACH)
              : step / 2

    const from = range ? xAt(range[0]) : null
    const to = range ? xAt(range[1]) : null
    const band: Band | null =
        from !== null && to !== null
            ? { left: Math.max(from - reach, plotLeft), right: Math.min(to + reach, plotRight) }
            : null
    const surface = theme.backgroundColor ?? 'var(--card)'
    const tint = (share: number): string => `color-mix(in srgb, ${HIGHLIGHT_COLOR} ${share}%, transparent)`
    const dims = band
        ? [
              { left: plotLeft, right: band.left, fadeLeft: false, fadeRight: true },
              { left: band.right, right: plotRight, fadeLeft: true, fadeRight: false },
          ]
        : []

    const yScale = (chartSeries.yAxisId && scales.yAxes?.[chartSeries.yAxisId]?.scale) || scales.y
    const markers = pages.flatMap((page, index) => {
        const x = page.anchor === null ? null : xAt(page.anchor)
        if (page.anchor === null || x === null || x < plotLeft || x > plotRight) {
            return []
        }
        const y = yScale(resolvePositionValue(chartSeries, page.anchor))
        if (!isFinite(y)) {
            return []
        }
        // A point at the top of the plot has no room above it, so its marker goes below.
        const above = y - MARKER_SIZE - MARKER_GAP
        const below = above < plotTop
        return [{ page, index, x, y, top: below ? y + MARKER_GAP : above, left: x, below }]
    })
    // Badges on neighbouring points move apart sideways, so each stays over its own point.
    for (const marker of markers) {
        for (const other of markers) {
            if (other === marker || Math.abs(other.top - marker.top) >= MARKER_SIZE) {
                continue
            }
            const overlap = MARKER_SIZE + 2 - Math.abs(other.left - marker.left)
            if (overlap > 0) {
                const direction = marker.x >= other.x ? 1 : -1
                marker.left += (direction * overlap) / 2
                other.left -= (direction * overlap) / 2
            }
        }
    }

    return (
        <div data-attr="insight-story-overlay">
            {dims.map((dim, index) => {
                const width = Math.max(dim.right - dim.left, 0)
                const feather = Math.min(FEATHER, width / 2)
                return (
                    <div
                        key={index}
                        className="pointer-events-none absolute opacity-65 transition-[left,width] duration-500 ease-out motion-reduce:transition-none starting:opacity-0"
                        style={{
                            left: dim.left,
                            top: plotTop,
                            width,
                            height: plotHeight,
                            background: `linear-gradient(to right, ${dim.fadeLeft ? 'transparent' : surface}, ${surface} ${feather}px, ${surface} calc(100% - ${feather}px), ${dim.fadeRight ? 'transparent' : surface})`,
                        }}
                    />
                )
            })}
            {band && (
                <div
                    className="pointer-events-none absolute rounded-t-md border-x border-t-2 transition-[left,width] duration-500 ease-out motion-reduce:transition-none starting:opacity-0"
                    style={{
                        left: band.left,
                        top: plotTop,
                        width: band.right - band.left,
                        height: plotHeight,
                        borderColor: tint(45),
                        borderTopColor: HIGHLIGHT_COLOR,
                        background: `linear-gradient(to bottom, ${tint(20)}, ${tint(5)})`,
                    }}
                />
            )}
            <svg
                className="pointer-events-none absolute overflow-visible"
                style={{ left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight }}
                aria-hidden
            >
                {markers.map(({ index, x, y, top, left, below }) => {
                    const base = below ? top + 1 : top + MARKER_SIZE - 1
                    const tip = below ? y + 3 : y - 3
                    const points: [number, number][] = [
                        [left - TAIL_WIDTH / 2, base],
                        [left + TAIL_WIDTH / 2, base],
                        [x, tip],
                    ]
                    return (
                        <polygon
                            key={index}
                            points={points.map(([px, py]) => `${px - plotLeft},${py - plotTop}`).join(' ')}
                            fill={index === activeIndex ? 'var(--foreground)' : 'var(--muted-foreground)'}
                        />
                    )
                })}
            </svg>
            {markers.map(({ page, index, top, left }) => {
                const active = index === activeIndex
                return (
                    <button
                        key={index}
                        type="button"
                        data-hog-charts-interactive-overlay
                        data-attr="insight-story-marker"
                        aria-label={`Chapter ${index + 1}: ${page.title}`}
                        aria-current={active ? 'step' : undefined}
                        className={`pointer-events-auto absolute flex cursor-pointer items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                            active
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-muted-foreground bg-card text-foreground shadow-sm hover:border-foreground'
                        }`}
                        style={{ left: left - MARKER_SIZE / 2, top, width: MARKER_SIZE, height: MARKER_SIZE }}
                        onClick={(event) => {
                            event.stopPropagation()
                            onSelect(index)
                        }}
                        onMouseDown={stopPropagation}
                        onMouseMove={stopPropagation}
                    >
                        {index + 1}
                    </button>
                )
            })}
        </div>
    )
}
