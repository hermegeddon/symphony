import { describe, expect, it } from 'vitest';

import { LinearIssueMutationClient } from '../src/tracker.js';
import type { GraphQLTransport, LinearTrackerReceipt } from '../src/tracker.js';

class RecordingTransport implements GraphQLTransport {
  public readonly calls: { readonly query: string; readonly variables: Readonly<Record<string, unknown>> }[] = [];

  public constructor(private readonly responses: readonly unknown[]) {}

  public request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.calls.push({ query, variables });
    const response = this.responses[this.calls.length - 1];
    if (response === undefined) {
      throw new Error(`missing fake response for call ${String(this.calls.length)}`);
    }
    return Promise.resolve(response);
  }
}

describe('LinearIssueMutationClient relation mutations', () => {
  it('creates an issue blocks relation and verifies exact active relation readback', async () => {
    const receipts: LinearTrackerReceipt[] = [];
    const transport = new RecordingTransport([
      {
        data: {
          issueRelationCreate: {
            success: true,
            issueRelation: {
              id: 'rel_parent_child',
              type: 'blocks',
              archivedAt: null,
              issue: { id: 'lin_parent', identifier: 'HER-201' },
              relatedIssue: { id: 'lin_child', identifier: 'HER-202' },
            },
          },
        },
      },
      {
        data: {
          issue: {
            id: 'lin_parent',
            identifier: 'HER-201',
            relations: {
              nodes: [
                {
                  id: 'rel_parent_child',
                  type: 'blocks',
                  archivedAt: null,
                  issue: { id: 'lin_parent', identifier: 'HER-201' },
                  relatedIssue: { id: 'lin_child', identifier: 'HER-202' },
                },
              ],
            },
            inverseRelations: { nodes: [] },
          },
        },
      },
      {
        data: {
          issue: {
            id: 'lin_parent',
            identifier: 'HER-201',
            relations: {
              nodes: [
                {
                  id: 'rel_archived',
                  type: 'blocks',
                  archivedAt: '2026-06-30T00:00:00.000Z',
                  issue: { id: 'lin_parent', identifier: 'HER-201' },
                  relatedIssue: { id: 'lin_child', identifier: 'HER-202' },
                },
              ],
            },
            inverseRelations: { nodes: [] },
          },
        },
      },
    ]);
    const client = new LinearIssueMutationClient({
      apiKey: 'fake-linear-api-key',
      transport,
      receiptSink: (receipt) => {
        receipts.push(receipt);
      },
    });

    const created = await client.createIssueRelation({
      issueId: 'lin_parent',
      relatedIssueId: 'lin_child',
      type: 'blocks',
    });
    const present = await client.hasIssueRelation({
      issueId: 'lin_parent',
      relatedIssueId: 'lin_child',
      type: 'blocks',
    });
    const archivedOnly = await client.hasIssueRelation({
      issueId: 'lin_parent',
      relatedIssueId: 'lin_child',
      type: 'blocks',
    });

    expect(created).toEqual({
      relation_id: 'rel_parent_child',
      type: 'blocks',
      issue_id: 'lin_parent',
      related_issue_id: 'lin_child',
    });
    expect(present).toBe(true);
    expect(archivedOnly).toBe(false);
    expect(transport.calls[0]?.query).toContain('issueRelationCreate');
    expect(transport.calls[0]?.variables).toEqual({
      input: { issueId: 'lin_parent', relatedIssueId: 'lin_child', type: 'blocks' },
    });
    expect(transport.calls[1]?.query).toContain('issue(id: $issueId)');
    expect(transport.calls[1]?.variables).toEqual({ issueId: 'lin_parent' });
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'linear_mutation_result',
        operation: 'SymphonyIssueRelationCreate',
        issue_id: 'lin_parent',
        result: {
          relation_id: 'rel_parent_child',
          type: 'blocks',
          related_issue_id: 'lin_child',
        },
      }),
    ]));
  });
});
