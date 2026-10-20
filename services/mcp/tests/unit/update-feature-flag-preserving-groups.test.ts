import { describe, expect, it, vi } from 'vitest'

import { conditionId } from '@/tools/featureFlags/conditionIds'
import { GENERATED_TOOLS } from '@/tools/generated/feature_flags'
import type { Context } from '@/tools/types'

type ApiRequestArgs = { method: string; path: string; body?: unknown }

function requestArgs(requestMock: ReturnType<typeof vi.fn>, callIndex: number): ApiRequestArgs {
    const call = requestMock.mock.calls[callIndex]
    if (!call) {
        throw new Error(`Expected an api.request call at index ${callIndex}`)
    }
    return call[0] as ApiRequestArgs
}

function createMockContext(requestMock: ReturnType<typeof vi.fn>): Context {
    return {
        api: {
            request: requestMock,
            getProjectBaseUrl: (projectId: string) => `https://us.posthog.com/project/${projectId}`,
        } as any,
        stateManager: { getProjectId: vi.fn().mockResolvedValue('42') } as any,
        env: {} as any,
        sessionManager: {} as any,
        cache: {} as any,
        getDistinctId: async () => 'test-distinct-id',
        trackEvent: async () => {},
    }
}

describe('update-feature-flag preserving groups', () => {
    const tool = GENERATED_TOOLS['update-feature-flag']!()

    it('GETs existing flag, merges group fields into filters, then PATCHes', async () => {
        const existing = {
            id: 9,
            key: 'workspace-rollout',
            filters: {
                aggregation_group_type_index: 0,
                groups: [
                    {
                        properties: [
                            {
                                key: 'plan',
                                type: 'group',
                                group_type_index: 0,
                                operator: 'exact',
                                value: 'enterprise',
                            },
                        ],
                        rollout_percentage: 100,
                    },
                ],
            },
        }
        const patched = { ...existing, filters: { ...existing.filters, groups: [] } }

        const request = vi
            .fn()
            .mockResolvedValueOnce(existing) // GET
            .mockResolvedValueOnce(patched) // PATCH via generated handler

        // The merge reads key presence, so a codegen default on an aggregation key would turn it
        // into a no-op. Params built by hand never catch that, so parse through the tool's own schema.
        const params = tool.schema.parse({
            id: 9,
            name: 'Renamed',
            filters: {
                groups: [
                    {
                        properties: [{ key: 'plan', operator: 'exact', value: 'pro' }],
                        rollout_percentage: 50,
                    },
                ],
            },
        })

        const result = await tool.handler(createMockContext(request), params)

        expect(request).toHaveBeenCalledTimes(2)
        expect(requestArgs(request, 0)).toMatchObject({
            method: 'GET',
            path: '/api/projects/42/feature_flags/9/',
        })
        expect(requestArgs(request, 1)).toMatchObject({
            method: 'PATCH',
            path: '/api/projects/42/feature_flags/9/',
        })
        const patchBody = requestArgs(request, 1).body as {
            name?: string
            filters: {
                aggregation_group_type_index?: number
                groups: Array<{ properties: Array<{ type?: string; group_type_index?: number; value?: unknown }> }>
            }
        }
        expect(patchBody).toMatchObject({ name: 'Renamed' })
        expect(patchBody.filters.aggregation_group_type_index).toBe(0)
        expect(patchBody.filters.groups[0]?.properties[0]?.type).toBe('group')
        expect(patchBody.filters.groups[0]?.properties[0]?.group_type_index).toBe(0)
        expect(patchBody.filters.groups[0]?.properties[0]?.value).toBe('pro')
        expect(result).toMatchObject({ id: 9 })
    })

    it('matches conditions by condition_id and keeps the IDs out of the PATCH', async () => {
        const storedGroups = [0, 1].map((group_type_index) => ({
            properties: [{ key: 'plan', type: 'group', group_type_index, operator: 'exact', value: 'pro' }],
            rollout_percentage: 100,
        }))
        const existing = { id: 9, key: 'plan-rollout', filters: { groups: storedGroups } }
        const request = vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(existing)

        const params = tool.schema.parse({
            id: 9,
            filters: {
                groups: [...storedGroups].reverse().map((group) => ({
                    condition_id: conditionId(group),
                    properties: [{ key: 'plan', operator: 'exact', value: 'pro' }],
                    rollout_percentage: 100,
                })),
            },
        })
        const result = (await tool.handler(createMockContext(request), params)) as typeof existing

        const patchGroups = (requestArgs(request, 1).body as typeof existing).filters.groups
        expect(patchGroups.map((group) => group.properties[0]?.group_type_index)).toEqual([1, 0])
        expect(patchGroups.some((group) => 'condition_id' in group)).toBe(false)
        expect(result.filters.groups.map((group) => (group as { condition_id?: string }).condition_id)).toEqual(
            storedGroups.map(conditionId)
        )
    })

    it('surfaces GET failures instead of PATCHing unmerged filters', async () => {
        const request = vi.fn().mockRejectedValueOnce(new Error('HTTP 429: rate limited'))

        await expect(
            tool.handler(createMockContext(request), {
                id: 9,
                filters: {
                    groups: [
                        {
                            properties: [{ key: 'plan', operator: 'exact', value: 'pro' }],
                            rollout_percentage: 50,
                        },
                    ],
                },
            })
        ).rejects.toThrow(/429|rate limited/i)

        expect(request).toHaveBeenCalledTimes(1)
        expect(requestArgs(request, 0).method).toBe('GET')
    })

    it('forwards updates without filters without an extra GET', async () => {
        const request = vi.fn().mockResolvedValue({ id: 9, key: 'x', active: false })

        await tool.handler(createMockContext(request), { id: 9, active: false })

        expect(request).toHaveBeenCalledTimes(1)
        expect(requestArgs(request, 0).method).toBe('PATCH')
        expect(requestArgs(request, 0).body).toMatchObject({ active: false })
    })
})
