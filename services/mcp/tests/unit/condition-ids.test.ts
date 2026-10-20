import { describe, expect, it } from 'vitest'

import { conditionId, withConditionIds } from '@/tools/featureFlags/conditionIds'
import {
    type FlagConditionGroup,
    type FlagFilters,
    preserveGroupTargetingFilters,
} from '@/tools/featureFlags/preserveGroupTargeting'

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

describe('condition ids', () => {
    it('gives the same ID to one stored condition however the API renders it', () => {
        const stored = {
            aggregation_group_type_index: null,
            properties: [
                { key: 'id', type: 'cohort', operator: 'in', value: 7 },
                { key: 'plan', type: 'group', group_type_index: 0, operator: 'exact', value: 'pro' },
            ],
            rollout_percentage: 50,
        }
        const rendered = {
            ...stored,
            properties: [{ ...stored.properties[1]! }, { ...stored.properties[0]!, cohort_name: 'Paying customers' }],
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

    it('adds an ID to each condition of a flag and passes other values through', () => {
        const flag = { id: 3, filters: { groups: [planOn(0, 'pro'), planOn(1, 'pro')] } }

        expect(withConditionIds(flag).filters.groups.map((group) => group.condition_id)).toEqual([
            conditionId(planOn(0, 'pro')),
            conditionId(planOn(1, 'pro')),
        ])
        expect(withConditionIds({ found: false })).toEqual({ found: false })
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
