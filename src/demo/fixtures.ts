import type { Issue } from '../domain.js';

export const fakeDemoIssue: Issue = {
  id: 'fake-issue-1',
  identifier: 'FAKE-1',
  title: 'Fake demo issue for local check mode',
  description: 'This issue exists only for the fake-only local CLI check.',
  priority: 1,
  state: 'In Progress',
  branch_name: null,
  url: null,
  labels: ['demo', 'fake'],
  blocked_by: [],
  created_at: new Date('2026-01-02T03:04:05.000Z'),
  updated_at: new Date('2026-01-02T03:04:05.000Z'),
};

export const fakeTracker = {
  fetch_candidate_issues: () => Promise.resolve([fakeDemoIssue] as const),
  fetch_terminal_issues: () => Promise.resolve([] as const),
  fetch_issue_states_by_ids: () => Promise.resolve([] as const),
};
