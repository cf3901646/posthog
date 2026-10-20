import { describe, expect, it, vi } from 'vitest'

import { isRecord } from '@/lib/plain-object'
import { getToolByName } from '@/shared/test-utils'
import { conditionId, withConditionIds } from '@/tools/featureFlags/conditionIds'
import {
    type FlagConditionGroup,
    type FlagFilters,
    preserveGroupTargetingFilters,
} from '@/tools/featureFlags/preserveGroupTargeting'
import type { Context } from '@/tools/types'

const planOn = (group_type_index: number, value: string): FlagConditionGroup => ({
    properties: [{ key: 'plan', type: 'group', group_type_index, operator: 'exact', value }],
    rollout_percentage: 100,
})

const personPlan = (value: string): FlagConditionGroup => ({
    properties: [
        { key: 'plan', type: 'person', operator: 'exact', value },
        { key: 'country', type: 'person', operator: 'exact', value: 'US' },
    ],
    rollout_percentage: 100,
})

function untyped(group: FlagConditionGroup, overrides: Partial<FlagConditionGroup> = {}): FlagConditionGroup {
    return {
        condition_id: conditionId(group),
        properties: (group.properties ?? []).map(({ key, operator, value }) => ({ key, operator, value })),
        rollout_percentage: group.rollout_percentage,
        ...overrides,
    }
}

function typings(filters: FlagFilters | null | undefined): unknown[][] {
    return (filters?.groups ?? []).map((group) => [
        group.aggregation_group_type_index ?? null,
        ...(group.properties ?? []).map((prop) => [prop.type, prop.group_type_index]),
    ])
}

const flag = (id: number): Record<string, unknown> => ({
    id,
    key: `flag-${id}`,
    filters: {
        groups: [{ ...planOn(0, `plan-${id}`), aggregation_group_type_index: 0 }, personPlan('free')],
        multivariate: null,
    },
    active: true,
})

const experiment = (id: number): Record<string, unknown> => ({
    id,
    name: `Experiment ${id}`,
    feature_flag_key: `flag-${id + 100}`,
    feature_flag: flag(id + 100),
    metrics: [],
    status: 'running',
})

function conditionsIn(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.flatMap(conditionsIn)
    }
    if (!isRecord(value)) {
        return []
    }
    return Object.entries(value).flatMap(([key, nested]) =>
        key === 'filters' && isRecord(nested) && Array.isArray(nested.groups)
            ? nested.groups.filter(isRecord)
            : conditionsIn(nested)
    )
}

function withoutConditionIds(value: unknown): unknown {
    return JSON.parse(JSON.stringify(value, (key, nested) => (key === 'condition_id' ? undefined : nested)))
}

function contextReturning(responses: unknown[]): Context {
    const request = vi.fn()
    for (const response of responses) {
        request.mockResolvedValueOnce(response)
    }
    return {
        api: { request, getProjectBaseUrl: (projectId: string) => `https://us.posthog.com/project/${projectId}` },
        stateManager: { getProjectId: vi.fn().mockResolvedValue('42') },
    } as unknown as Context
}

const EXPERIMENT_TOOLS_BY_ID = [
    'experiment-archive',
    'experiment-duplicate',
    'experiment-end',
    'experiment-freeze-exposure',
    'experiment-get',
    'experiment-migrate',
    'experiment-pause',
    'experiment-reset',
    'experiment-resume',
    'experiment-ship-variant',
    'experiment-unarchive',
    'experiment-unfreeze-exposure',
]

// feature-flag-get-all, feature-flag-enable, feature-flag-disable, feature-flag-archive, and
// feature-flag-unarchive keep no `filters` in their responses, so they are not listed.
const CONDITION_TOOLS: { tool: string; params: Record<string, unknown>; responses: unknown[] }[] = [
    { tool: 'create-feature-flag', params: { key: 'flag-9', name: 'Flag 9' }, responses: [flag(9)] },
    { tool: 'delete-feature-flag', params: { id: 9 }, responses: [{ ...flag(9), deleted: true }] },
    { tool: 'feature-flag-get-definition', params: { id: 9 }, responses: [flag(9)] },
    {
        tool: 'feature-flag-get-definition-by-key',
        params: { key: 'flag-9' },
        responses: [{ results: [flag(9)] }],
    },
    { tool: 'feature-flag-roll-out-to-everyone', params: { id: 9, version: 3 }, responses: [flag(9)] },
    {
        tool: 'feature-flag-set-release-condition-rollout',
        params: { id: 9, condition_index: 0, rollout_percentage: 25, version: 3 },
        responses: [flag(9)],
    },
    {
        tool: 'feature-flags-my-flags-retrieve',
        params: {},
        responses: [
            [
                { feature_flag: flag(9), value: true },
                { feature_flag: flag(10), value: 'test' },
            ],
        ],
    },
    { tool: 'update-feature-flag', params: { id: 9, name: 'Renamed' }, responses: [flag(9)] },
    ...EXPERIMENT_TOOLS_BY_ID.map((tool) => ({ tool, params: { id: 5 }, responses: [experiment(5)] })),
    {
        tool: 'experiment-get-by-flag-key',
        params: { feature_flag_key: 'flag-105' },
        responses: [{ results: [{ id: 105, key: 'flag-105', experiment_set: [5] }] }, experiment(5)],
    },
    {
        tool: 'experiment-list',
        params: {},
        responses: [{ count: 2, next: null, previous: null, results: [experiment(5), experiment(6)] }],
    },
]

describe('condition ids', () => {
    it('gives the same ID to one stored condition however the API renders it', () => {
        const stored = {
            aggregation_group_type_index: null,
            properties: [
                { key: 'id', type: 'cohort', operator: 'in', value: 7 },
                { key: 'plan', type: 'group', group_type_index: 0, operator: 'exact', value: 'pro' },
                { key: '$group_key', type: 'group', group_type_index: 0, operator: 'exact', value: 'acme' },
            ],
            rollout_percentage: 50,
        }
        const rendered = {
            ...stored,
            properties: [
                { ...stored.properties[1]! },
                { ...stored.properties[0]!, cohort_name: 'Paying customers' },
                { ...stored.properties[2]!, group_key_names: { acme: 'Acme Inc' } },
            ],
            rollout_percentage: 75,
            variant: 'test',
            description: 'Edited in the UI',
            sort_key: 'abc-123',
        }

        expect(conditionId(rendered)).toBe(conditionId(stored))
    })

    it.each([
        { name: 'type', change: { type: 'person', group_type_index: undefined } },
        { name: 'group_type_index', change: { group_type_index: 1 } },
        { name: 'value', change: { value: 'enterprise' } },
        { name: 'operator', change: { operator: 'icontains' } },
    ])('gives a condition a new ID when a property changes its $name', ({ change }) => {
        const stored = planOn(0, 'pro')
        const changed = { ...stored, properties: [{ ...stored.properties![0]!, ...change }] }

        expect(conditionId(changed)).not.toBe(conditionId(stored))
    })

    it('tells an absent aggregation from an explicit null', () => {
        const absent = planOn(0, 'pro')

        expect(conditionId({ ...absent, aggregation_group_type_index: null })).not.toBe(conditionId(absent))
    })

    it.each([
        { name: 'a flag', value: flag(9) },
        { name: 'an experiment', value: experiment(5) },
        {
            name: 'a page of experiments where one has no flag',
            value: {
                count: 2,
                next: 'https://us.posthog.com/api/projects/42/experiments/?offset=2',
                results: [experiment(5), { ...experiment(6), feature_flag: null }],
                _posthogUrl: 'https://us.posthog.com/project/42/experiments',
            },
        },
        {
            name: 'a list of my-flags rows',
            value: [
                { feature_flag: flag(9), value: true },
                { feature_flag: flag(10), value: 'test' },
            ],
        },
        { name: 'a lookup miss', value: { found: false, key: 'flag-9', message: 'No feature flag' } },
        {
            name: 'a flag whose conditions carry a saved condition_id',
            value: { id: 9, filters: { groups: [{ condition_id: 'saved-by-api', ...personPlan('free') }] } },
        },
    ])('adds an ID to each condition of $name and changes nothing else', ({ value }) => {
        const result = withConditionIds(structuredClone(value))

        expect(conditionsIn(result).map((group) => group.condition_id)).toEqual(conditionsIn(value).map(conditionId))
        expect(withoutConditionIds(result)).toEqual(withoutConditionIds(value))
    })

    it.each(CONDITION_TOOLS)('$tool returns each condition with its ID', async ({ tool, params, responses }) => {
        const expected = conditionsIn(responses.at(-1)).map(conditionId)

        const result = await getToolByName(tool).handler(contextReturning(responses), params)

        expect(conditionsIn(result).map((group) => group.condition_id)).toEqual(expected)
    })

    it.each([
        {
            name: 'two person sets on different group types trade places',
            stored: [planOn(0, 'enterprise'), planOn(1, 'pro')],
            sent: (stored: FlagConditionGroup[]) => [untyped(stored[1]!), untyped(stored[0]!)],
            expected: [
                [null, ['group', 1]],
                [null, ['group', 0]],
            ],
        },
        {
            name: 'the first of two person sets is deleted',
            stored: [planOn(0, 'pro'), planOn(1, 'pro')],
            sent: (stored: FlagConditionGroup[]) => [untyped(stored[1]!)],
            expected: [[null, ['group', 1]]],
        },
        {
            name: 'a set moves and changes its value',
            stored: [planOn(0, 'enterprise'), planOn(1, 'pro')],
            sent: (stored: FlagConditionGroup[]) => [
                untyped(stored[1]!, {
                    properties: [{ key: 'plan', operator: 'exact', value: 'business' }],
                }),
                untyped(stored[0]!),
            ],
            expected: [
                [null, ['group', 1]],
                [null, ['group', 0]],
            ],
        },
        {
            name: 'two sets with different keys trade places',
            stored: [planOn(0, 'enterprise'), personPlan('free')],
            sent: (stored: FlagConditionGroup[]) => [untyped(stored[1]!), untyped(stored[0]!)],
            expected: [
                [null, ['person', undefined], ['person', undefined]],
                [null, ['group', 0]],
            ],
        },
        {
            name: 'a person set and a group set on a mixed flag trade places',
            stored: [
                { ...personPlan('free'), aggregation_group_type_index: null },
                { ...planOn(0, 'enterprise'), aggregation_group_type_index: 0 },
            ],
            sent: (stored: FlagConditionGroup[]) => [untyped(stored[1]!), untyped(stored[0]!)],
            expected: [
                [0, ['group', 0]],
                [null, ['person', undefined], ['person', undefined]],
            ],
        },
        {
            name: 'the agent copies a condition and edits the copy',
            stored: [planOn(0, 'enterprise'), planOn(1, 'pro')],
            sent: (stored: FlagConditionGroup[]) => [
                untyped(stored[1]!),
                untyped(stored[1]!, { properties: [{ key: 'plan', operator: 'exact', value: 'business' }] }),
                untyped(stored[0]!),
            ],
            expected: [
                [null, ['group', 1]],
                [null, ['group', 1]],
                [null, ['group', 0]],
            ],
        },
        {
            name: 'a new set without an ID repeats a key that a stored person set holds as a group property',
            stored: [planOn(0, 'enterprise')],
            sent: (stored: FlagConditionGroup[]) => [
                untyped(stored[0]!),
                { properties: [{ key: 'plan', operator: 'exact', value: 'free' }], rollout_percentage: 100 },
            ],
            expected: [
                [null, ['group', 0]],
                [null, [undefined, undefined]],
            ],
        },
    ])('restores each condition from the stored condition with its ID when $name', ({ stored, sent, expected }) => {
        const merged = preserveGroupTargetingFilters({ groups: stored }, { groups: sent(stored) })

        expect(typings(merged)).toEqual(expected)
        expect(merged?.groups?.every((group) => !('condition_id' in group))).toBe(true)
    })

    it('refuses a condition ID that matches no stored condition', () => {
        const stored = [planOn(0, 'enterprise'), planOn(1, 'pro')]

        expect(() =>
            preserveGroupTargetingFilters(
                { groups: stored },
                { groups: [untyped(stored[0]!), untyped(planOn(2, 'pro'))] }
            )
        ).toThrow(/filters\.groups\[1\]/)
    })
})
