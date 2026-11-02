import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildPermissionsMatrix } from './permissions-matrix.js';
import type { MatrixCell, PermissionsMatrix, PolicySubject } from './permissions-types.js';
import {
  call,
  inProcessFetch,
  jsonResponse,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness, Recorder } from './testing/approvals-harness.js';
import { livePolicies, settled, untilState } from './testing/permissions-harness.js';
import type { LivePolicies } from './testing/permissions-harness.js';

const fail = (): never => {
  throw new Error('missing fixture value');
};

const MEMBER: PolicySubject = { type: 'role', id: 'member' };
/** The tools `pol_default` targets in the mock's seed. */
const DEFAULT_TARGETS = [
  'mcp:tracker:search',
  'mcp:tracker:create_issue',
  'ext:local:send_email',
  'mcp:crm:delete_account',
];

function cell(m: PermissionsMatrix | undefined, columnKey: string, toolRef: string): MatrixCell {
  for (const group of m?.groups ?? [])
    for (const row of group.rows)
      if (row.tool.toolRef === toolRef) {
        const found = row.cells.find((c) => c.columnKey === columnKey);
        if (found) return found;
      }
  throw new Error(`no cell ${columnKey} × ${toolRef}`);
}

/** Policy writes to `/v1/policies*` other than simulate. */
const writes = (rec: Recorder): number =>
  rec.calls.filter(
    (c) =>
      (c.method === 'POST' || c.method === 'PUT') &&
      c.path.startsWith('/v1/policies') &&
      !c.path.endsWith('/simulate')
  ).length;

let unique = 0;
/** A role no other test uses, so tests that publish never meet each other's pairs. */
const freshRole = (): PolicySubject => {
  unique += 1;
  return { type: 'role', id: `reviewer_${String(unique)}` };
};

describe('on the default service', () => {
  let h: Harness;
  const opened: LivePolicies[] = [];
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    for (const l of opened) l.close();
    await h.stop();
  });

  const open = (
    token: string,
    rec?: Recorder,
    extra: Record<string, unknown> = {}
  ): LivePolicies => {
    const l = livePolicies({
      baseUrl: h.baseUrl,
      getToken: () => token,
      fetch: rec?.fetch ?? inProcessFetch(h.mock),
      ...extra,
    });
    opened.push(l);
    return l;
  };

  describe('capabilities', () => {
    it('reads author and publish where they are advertised', async () => {
      const { store } = open(h.tokens.admin);
      const s = await settled(store);
      expect(s.status).toBe('ready');
      expect(s.facts).toMatchObject({ served: true, author: true, publish: true });
      expect(s.authoring).toEqual({ readOnly: false, canPublish: true, canRetire: true });
    });

    it('turns authoring off when the host passes readOnly', async () => {
      const { store } = open(h.tokens.admin, undefined, { readOnly: true });
      const s = await settled(store);
      expect(s.authoring).toEqual({
        readOnly: true,
        reason: 'host',
        canPublish: false,
        canRetire: false,
      });
    });
  });

  describe('the matrix of the seeded policies', () => {
    it('shows member × each target of pol_default as ask, with its provenance', async () => {
      const { store } = open(h.tokens.admin);
      const s = await settled(store);
      const m = buildPermissionsMatrix(s, [{ id: 'member' }]);
      for (const toolRef of DEFAULT_TARGETS) {
        expect(cell(m, 'role:member', toolRef)).toMatchObject({
          state: 'governed',
          policy: {
            policyId: 'pol_default',
            name: 'Ask the members before a call',
            version: 3,
            mode: 'ask',
            updatedBy: { id: 'user_admin', kind: 'user' },
            soleCell: false,
          },
        });
      }
      expect(cell(m, 'role:member', 'mcp:tracker:add_comment')).toMatchObject({
        state: 'governed',
        policy: { policyId: 'pol_silent', soleCell: true },
      });
      // A tool no policy governs shows no mode.
      const none = cell(m, 'role:member', 'mcp:tracker:list_labels');
      expect(none.state).toBe('none');
      expect(none).not.toHaveProperty('policy');
    });

    it('shows conflict when a list returns two policies on one pair', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const row = (id: string): Record<string, unknown> => ({
        id,
        version: 1,
        source: 'authored',
        kind: 'tool_invocation',
        state: 'published',
        subjects: [MEMBER],
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'deny' },
        published_at: '2026-10-01T00:00:00.000Z',
      });
      rec.intercept((c) =>
        c.method === 'GET' && c.path === '/v1/policies' && c.query.includes('kind=tool_invocation')
          ? jsonResponse({ data: [row('pol_a'), row('pol_b')], meta: { next: null } })
          : undefined
      );
      const { store } = open(h.tokens.admin, rec);
      const m = buildPermissionsMatrix(await settled(store));
      const c = cell(m, 'role:member', 'mcp:tracker:search');
      expect(c.state).toBe('conflict');
      expect(c.state === 'conflict' && c.policies.map((p) => p.policyId)).toEqual([
        'pol_a',
        'pol_b',
      ]);
      // Not editable: setCell refuses without a request.
      const before = writes(rec);
      const result = await store.setCell(MEMBER, 'mcp:tracker:search', 'ask');
      expect(result).toMatchObject({
        kind: 'error',
        error: { kind: 'precondition', code: 'pair_conflict' },
      });
      expect(writes(rec)).toBe(before);
    });

    it('places an organisation policy in the Organisation column once published', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [{ type: 'organization' }],
        targets: ['mcp:tracker:list_labels'],
        config: { mode: 'deny' },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const published = await store.publish(created.policy.id, created.policy);
      expect(published.ok).toBe(true);
      const s = await untilState(store, (x) =>
        x.policies.some((p) => p.id === created.policy.id && p.state === 'published')
      );
      expect(
        cell(buildPermissionsMatrix(s), 'organization', 'mcp:tracker:list_labels')
      ).toMatchObject({
        state: 'governed',
        policy: { policyId: created.policy.id, mode: 'deny' },
      });
    });

    it('lists a user subject under Other subjects', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [{ type: 'user', id: 'user_member' }],
        targets: ['mcp:tracker:search'],
        config: { mode: 'always_allow' },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const s = await untilState(store, (x) => x.policies.some((p) => p.id === created.policy.id));
      expect(buildPermissionsMatrix(s).otherSubjects).toContainEqual({
        subject: { type: 'user', id: 'user_member' },
        policy: expect.objectContaining({ id: created.policy.id }) as unknown,
      });
    });
  });

  describe('setCell', () => {
    it('creates a draft for a pair no policy governs, then writes that draft again', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const first = await store.setCell(role, 'mcp:tracker:search', 'ask', {
        name: 'Reviewers search',
      });
      expect(first).toMatchObject({
        kind: 'written',
        policy: { state: 'draft', version: 1, name: 'Reviewers search' },
      });
      expect(rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/policies')?.body).toEqual(
        {
          kind: 'tool_invocation',
          name: 'Reviewers search',
          subjects: [role],
          targets: { tools: ['mcp:tracker:search'] },
          config: { mode: 'ask' },
        }
      );
      const s = await untilState(store, (x) =>
        x.drafts.some((d) => d.policyId === (first.kind === 'written' ? first.policy.id : ''))
      );
      const c = cell(buildPermissionsMatrix(s), `role:${role.id ?? ''}`, 'mcp:tracker:search');
      expect(c.state).toBe('none');
      expect(c.pending).toHaveLength(1);
      const second = await store.setCell(role, 'mcp:tracker:search', 'deny');
      expect(second).toMatchObject({ kind: 'written', policy: { version: 1, mode: 'deny' } });
      expect(rec.count('POST', '/v1/policies')).toBe(1);
      expect(rec.count('PUT', /^\/v1\/policies\/pol_/)).toBe(1);
    });

    it('writes the next draft of a policy that governs only that pair, and the cell marks it pending', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:tracker:create_issue'],
        config: { mode: 'ask', on_deny: 'halt' },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      expect((await store.publish(created.policy.id, created.policy)).ok).toBe(true);
      // The cell is written once the grid shows the published policy.
      await untilState(store, (x) =>
        x.policies.some((p) => p.id === created.policy.id && p.state === 'published')
      );
      const result = await store.setCell(role, 'mcp:tracker:create_issue', 'deny');
      // The mode that takes no conditions clears them, so the write is legal.
      expect(result).toMatchObject({
        kind: 'written',
        policy: { version: 2, state: 'draft', config: { mode: 'deny' } },
      });
      const s = await untilState(store, (x) =>
        x.drafts.some((d) => d.policyId === created.policy.id && d.version === 2)
      );
      expect(
        cell(buildPermissionsMatrix(s), `role:${role.id ?? ''}`, 'mcp:tracker:create_issue')
      ).toMatchObject({
        state: 'governed',
        policy: { version: 1, mode: 'ask' },
        pending: [{ policyId: created.policy.id, version: 2 }],
      });
    });

    it('never writes on top of a pending draft the cell did not show: it opens the editor instead', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['ext:local:send_email'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      expect((await store.publish(id, created.policy)).ok).toBe(true);
      await untilState(store, (x) =>
        x.policies.some((p) => p.id === id && p.state === 'published')
      );
      // Another administrator writes a draft the store has not read.
      const other = await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${id}`, {
        kind: 'tool_invocation',
        name: 'Someone else',
        subjects: [role],
        targets: { tools: ['ext:local:send_email'] },
        config: { mode: 'escalate' },
      });
      expect(other.status).toBe(200);
      const puts = rec.count('PUT', `/v1/policies/${id}`);
      const result = await store.setCell(role, 'ext:local:send_email', 'deny');
      expect(result).toEqual({ kind: 'open_editor', policyId: id });
      expect(rec.count('PUT', `/v1/policies/${id}`)).toBe(puts);
      // The draft is now known, so the next cell write builds on it.
      expect(store.getSnapshot().drafts).toContainEqual(
        expect.objectContaining({ policyId: id, version: 2, neverPublished: false })
      );
    });

    it('opens the editor for a never-published draft that changed since this store wrote it', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const first = await store.setCell(role, 'mcp:tracker:search', 'ask');
      if (first.kind !== 'written') throw new Error('setCell failed');
      await new Promise((r) => setTimeout(r, 5));
      const other = await call(
        h.baseUrl,
        h.tokens.admin,
        'PUT',
        `/v1/policies/${first.policy.id}`,
        {
          kind: 'tool_invocation',
          subjects: [role],
          targets: { tools: ['mcp:tracker:search'] },
          config: { mode: 'always_allow' },
        }
      );
      expect(other.status).toBe(200);
      const puts = rec.count('PUT', `/v1/policies/${first.policy.id}`);
      const result = await store.setCell(role, 'mcp:tracker:search', 'deny');
      expect(result).toEqual({ kind: 'open_editor', policyId: first.policy.id });
      expect(rec.count('PUT', `/v1/policies/${first.policy.id}`)).toBe(puts);
    });

    it('a second cell write after open_editor still writes nothing on the unseen draft (adv-2)', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:tracker:create_issue'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      expect((await store.publish(id, created.policy)).ok).toBe(true);
      await untilState(store, (x) =>
        x.policies.some((p) => p.id === id && p.state === 'published')
      );
      await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${id}`, {
        kind: 'tool_invocation',
        subjects: [role],
        targets: { tools: ['mcp:tracker:create_issue'] },
        config: { mode: 'ask', approver_groups: ['OUTSIDER_UNSEEN'] },
      });
      const puts = rec.count('PUT', `/v1/policies/${id}`);
      for (let i = 0; i < 2; i += 1)
        expect(await store.setCell(role, 'mcp:tracker:create_issue', 'escalate')).toEqual({
          kind: 'open_editor',
          policyId: id,
        });
      expect(rec.count('PUT', `/v1/policies/${id}`)).toBe(puts);
    });

    it('writes nothing while the lists are still loading (adv-3)', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      rec.intercept(async (c) => {
        if (c.method === 'GET' && c.path === '/v1/policies') await gate;
        return undefined;
      });
      const { store } = open(h.tokens.admin, rec);
      await untilState(store, (x) => x.facts !== undefined);
      expect(store.getSnapshot().status).toBe('loading');
      expect(await store.setCell(MEMBER, 'mcp:tracker:add_comment', 'deny')).toMatchObject({
        kind: 'error',
        error: { code: 'not_loaded' },
      });
      expect(writes(rec)).toBe(0);
      release();
      await settled(store);
    });

    it('matches an organisation subject as the grid places it, an id or none (adv-6)', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.method === 'GET' && c.path === '/v1/policies' && c.query.includes('kind=tool_invocation')
          ? jsonResponse({
              data: [
                {
                  id: 'pol_org',
                  version: 1,
                  source: 'authored',
                  kind: 'tool_invocation',
                  state: 'published',
                  subjects: [{ type: 'organization', id: 'org_mock' }],
                  targets: { tools: ['mcp:tracker:search', 'mcp:tracker:list_labels'] },
                  config: { mode: 'deny' },
                  published_at: '2026-10-01T00:00:00.000Z',
                },
              ],
              meta: { next: null },
            })
          : undefined
      );
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      expect(await store.setCell({ type: 'organization' }, 'mcp:tracker:search', 'ask')).toEqual({
        kind: 'open_editor',
        policyId: 'pol_org',
      });
      expect(writes(rec)).toBe(0);
    });

    it('two writes to one policy at once: the second waits its turn (adv-7)', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const [a, b] = await Promise.all([
        store.publish(created.policy.id, created.policy),
        store.publish(created.policy.id, created.policy),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect([a, b].find((r) => !r.ok)).toMatchObject({ error: { code: 'write_in_flight' } });
      expect(store.getSnapshot().busy.size).toBe(0);
    });

    it('a cell builds on the published version again once someone else publishes its draft (FD-1)', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:crm:delete_account'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      // Another administrator publishes it, then writes and publishes a newer version.
      const admin = (method: string, path: string, body?: unknown): Promise<Response> =>
        call(h.baseUrl, h.tokens.admin, method, path, body);
      expect((await admin('POST', `/v1/policies/${id}/publish`)).status).toBe(200);
      const next = await admin('PUT', `/v1/policies/${id}`, {
        kind: 'tool_invocation',
        subjects: [role],
        targets: { tools: ['mcp:crm:delete_account'] },
        config: { mode: 'escalate' },
      });
      expect(next.status).toBe(200);
      expect((await admin('POST', `/v1/policies/${id}/publish`)).status).toBe(200);
      await store.refresh();
      expect(await store.setCell(role, 'mcp:crm:delete_account', 'deny')).toMatchObject({
        kind: 'written',
        policy: { version: 3, config: { mode: 'deny' } },
      });
    });

    it('opens the editor for a policy that governs several pairs, and writes nothing', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const result = await store.setCell(MEMBER, 'mcp:tracker:search', 'deny');
      expect(result).toEqual({ kind: 'open_editor', policyId: 'pol_default' });
      expect(writes(rec)).toBe(0);
    });
  });

  describe('the editor', () => {
    it('create → draft v1; publish → v1; PUT on published → draft v2 while the read stays v1; publish → v2', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        name: 'Reviewers ask',
        subjects: [role],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      expect(created).toMatchObject({ ok: true, policy: { version: 1, state: 'draft' } });
      if (!created.ok) return;
      const id = created.policy.id;
      const editor = store.editor(id);
      let e = await untilState(editor, (x) => x.status === 'ready');
      expect(e.pendingDraft?.version).toBe(1);
      expect((await editor.publish()).ok).toBe(true);
      e = await untilState(editor, (x) => x.status === 'ready' && x.current?.state === 'published');
      expect(e.current?.version).toBe(1);
      expect(e.lastPublished?.version).toBe(1);

      editor.setMode('deny');
      const saved = await editor.save();
      expect(saved).toMatchObject({ ok: true, policy: { version: 2, state: 'draft' } });
      // The read still returns the published version.
      const read = (await (
        await call(h.baseUrl, h.tokens.admin, 'GET', `/v1/policies/${id}`)
      ).json()) as {
        data: { version: number };
      };
      expect(read.data.version).toBe(1);
      e = editor.getSnapshot();
      expect(e.current?.version).toBe(1);
      expect(e.pendingDraft?.version).toBe(2);
      expect(e.dirty).toBe(false);

      expect(await editor.publish()).toMatchObject({
        ok: true,
        policy: { version: 2, state: 'published' },
      });
      e = await untilState(editor, (x) => x.current?.version === 2);
      expect(e.versions.map((v) => [v.version, v.state])).toEqual([
        [2, 'published'],
        [1, 'published'],
      ]);
    });

    it('retires a published policy: it leaves the lists at once, its pending draft with it, and its editor finds it gone', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        name: 'To retire',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      expect(await store.publish(id, created.policy)).toMatchObject({ ok: true });
      const editor = store.editor(id);
      const unsubscribe = editor.subscribe(() => undefined);
      await untilState(editor, (x) => x.status === 'ready' && x.current?.state === 'published');
      editor.setMode('deny');
      expect((await editor.save()).ok).toBe(true);
      expect(store.getSnapshot().drafts.some((d) => d.policyId === id)).toBe(true);

      const retired = await store.retire(id);
      expect(retired).toMatchObject({ ok: true, policy: { id, version: 1, state: 'published' } });
      expect(rec.count('POST', `/v1/policies/${id}/retire`)).toBe(1);
      const now = store.getSnapshot();
      expect(now.policies.some((p) => p.id === id)).toBe(false);
      expect(now.drafts.some((d) => d.policyId === id)).toBe(false);
      // The open editor reads it again by itself, and finds it gone.
      await untilState(editor, (x) => x.status === 'not_found');
      await store.refresh();
      expect(store.getSnapshot().policies.some((p) => p.id === id)).toBe(false);
      // Retired already: the service answers 404.
      expect(await store.retire(id)).toMatchObject({ ok: false, error: { kind: 'not_found' } });
      unsubscribe();
    });

    it('a retired policy of another kind leaves the list of other policies at once', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/policies', {
        kind: 'duplicate_requests',
        name: `dup ${String(++unique)}`,
        subjects: [{ type: 'organization' }],
        targets: { tools: 'all' },
        config: { after_rejection: 'deny' },
      });
      const { data } = (await created.json()) as { data: { id: string } };
      await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/policies/${data.id}/publish`);
      await store.refresh();
      expect(store.getSnapshot().others.policies.some((o) => o.policy.id === data.id)).toBe(true);
      // The list is not read again after the retire, so only the store's own change can take it out.
      const rec = recorder(inProcessFetch(h.mock));
      let block = false;
      rec.intercept((c) =>
        block && c.method === 'GET' && c.path === '/v1/policies'
          ? new Response('', { status: 503 })
          : undefined
      );
      const second = open(h.tokens.admin, rec);
      await settled(second.store);
      expect(second.store.getSnapshot().others.policies.some((o) => o.policy.id === data.id)).toBe(
        true
      );
      block = true;
      expect((await second.store.retire(data.id)).ok).toBe(true);
      expect(second.store.getSnapshot().others.policies.some((o) => o.policy.id === data.id)).toBe(
        false
      );
    });

    it("discards a published policy's pending draft and keeps the published version; a policy never published is deleted", async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const published = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!published.ok) throw new Error('create failed');
      const id = published.policy.id;
      expect((await store.publish(id, published.policy)).ok).toBe(true);
      const editor = store.editor(id);
      const unsubscribe = editor.subscribe(() => undefined);
      await untilState(editor, (x) => x.status === 'ready' && x.current?.state === 'published');
      editor.setMode('deny');
      expect((await editor.save()).ok).toBe(true);
      expect(store.getSnapshot().drafts.some((d) => d.policyId === id && !d.neverPublished)).toBe(
        true
      );
      expect(await store.discardDraft(id)).toEqual({ ok: true, deleted: false });
      expect(rec.count('DELETE', `/v1/policies/${id}/draft`)).toBe(1);
      expect(store.getSnapshot().drafts.some((d) => d.policyId === id)).toBe(false);
      // The listed row no longer names a draft, before any list is read again.
      expect(store.getSnapshot().policies.find((p) => p.id === id)?.draftVersion).toBeUndefined();
      const e = await untilState(
        editor,
        (x) => x.status === 'ready' && x.pendingDraft === undefined && !x.stale
      );
      expect(e.current).toMatchObject({ version: 1, state: 'published' });
      expect(e.pendingDraft).toBeUndefined();
      await store.refresh();
      expect(store.getSnapshot().policies.find((p) => p.id === id)?.state).toBe('published');
      // Nothing left to discard: the versions say so, and nothing is sent.
      const deletes = rec.count('DELETE', `/v1/policies/${id}/draft`);
      expect(await store.discardDraft(id)).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'no_pending_draft' },
      });
      expect(rec.count('DELETE', `/v1/policies/${id}/draft`)).toBe(deletes);
      unsubscribe();

      const never = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!never.ok) throw new Error('create failed');
      expect(store.getSnapshot().drafts.some((d) => d.policyId === never.policy.id)).toBe(true);
      // A policy never published is not retired: the service says to discard it.
      expect(await store.retire(never.policy.id)).toMatchObject({
        ok: false,
        error: { kind: 'invalid_request' },
      });
      expect(await store.discardDraft(never.policy.id)).toEqual({ ok: true, deleted: true });
      const after = store.getSnapshot();
      expect(after.drafts.some((d) => d.policyId === never.policy.id)).toBe(false);
      expect(after.policies.some((p) => p.id === never.policy.id)).toBe(false);
    });

    it('refuses a retire or a discard without a request where the service does not offer them, or while a write is in flight', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/capabilities'
          ? jsonResponse({
              data: {
                features: ['policies', 'policies.author', 'policies.publish'],
                entitlements: [],
                resolutions: ['approved'],
              },
            })
          : undefined
      );
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      expect(store.getSnapshot().authoring.canRetire).toBe(false);
      expect(await store.retire('pol_default')).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'retire_not_offered' },
      });
      expect(await store.discardDraft('pol_default')).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'retire_not_offered' },
      });
      expect(rec.count('POST', /\/retire$/)).toBe(0);
      expect(rec.count('DELETE', /\/draft$/)).toBe(0);

      const busy = recorder(inProcessFetch(h.mock));
      const second = open(h.tokens.admin, busy);
      await settled(second.store);
      const created = await second.store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const first = second.store.discardDraft(created.policy.id);
      expect(await second.store.retire(created.policy.id)).toMatchObject({
        ok: false,
        error: { code: 'write_in_flight' },
      });
      expect(await first).toEqual({ ok: true, deleted: true });
    });

    it('discards only the draft shown: one rewritten since is refused with draft_changed and nothing is deleted', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'deny' },
      });
      if (!created.ok) throw new Error('create failed');
      const shown = created.policy;
      // Another administrator rewrites the draft in place.
      await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${shown.id}`, {
        kind: 'tool_invocation',
        subjects: shown.subjects,
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'always_allow' },
      });
      expect(await store.discardDraft(shown.id, shown)).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'draft_changed' },
      });
      expect(rec.count('DELETE', `/v1/policies/${shown.id}/draft`)).toBe(0);
      const now = await store.latest(shown.id);
      if (!now.ok) throw new Error('latest failed');
      expect(await store.discardDraft(shown.id, now.policy)).toEqual({ ok: true, deleted: true });
    });

    it('a policy retired elsewhere leaves no pending draft behind once the lists are read, and a retire answered 404 forgets it', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      expect((await store.publish(id, created.policy)).ok).toBe(true);
      const editor = store.editor(id);
      const unsubscribe = editor.subscribe(() => undefined);
      await untilState(editor, (x) => x.status === 'ready' && x.current?.state === 'published');
      editor.setMode('deny');
      expect((await editor.save()).ok).toBe(true);
      expect(store.getSnapshot().drafts.some((d) => d.policyId === id)).toBe(true);
      unsubscribe();
      // Another administrator retires it.
      expect(
        (await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/policies/${id}/retire`)).status
      ).toBe(200);
      await store.refresh();
      expect(store.getSnapshot().drafts.some((d) => d.policyId === id)).toBe(false);
      expect(store.getSnapshot().policies.some((p) => p.id === id)).toBe(false);

      // A store that still lists it learns from the 404.
      const other = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!other.ok) throw new Error('create failed');
      expect((await store.publish(other.policy.id, other.policy)).ok).toBe(true);
      await store.refresh();
      await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/policies/${other.policy.id}/retire`);
      expect(store.getSnapshot().policies.some((p) => p.id === other.policy.id)).toBe(true);
      expect(await store.retire(other.policy.id)).toMatchObject({
        ok: false,
        error: { kind: 'not_found' },
      });
      expect(store.getSnapshot().policies.some((p) => p.id === other.policy.id)).toBe(false);
    });

    it('a member refused a retire with 403 gets authoring off for the life of the store', async () => {
      const { store } = open(h.tokens.member);
      await settled(store);
      if (store.getSnapshot().authoring.readOnly) return expect.fail('member authoring is off');
      const refused = await store.retire('pol_default');
      expect(refused).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } });
      expect(store.getSnapshot().authoring).toMatchObject({ readOnly: true, reason: 'forbidden' });
    });

    it('keeps the draft and the detail of a 422 unsupported_policy_form (not_granted)', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const editor = store.editor(created.policy.id);
      await untilState(editor, (x) => x.status === 'ready');
      editor.setMode('not_granted');
      const result = await editor.save();
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'unprocessable', code: 'unsupported_policy_form', status: 422 },
      });
      expect(!result.ok && result.error.detail).toMatch(/^config\.mode: not_granted/);
      const e = editor.getSnapshot();
      expect(e.working?.config).toEqual({ mode: 'not_granted' });
      expect(e.dirty).toBe(true);
      expect(e.error?.kind).toBe('unprocessable');
    });

    it('answers a config that does not fit its kind with 400 invalid_request and its detail', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const result = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { after_rejection: 'deny' },
      });
      expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request', status: 400 } });
      expect(!result.ok && result.error.detail).toMatch(/config does not fit/);
    });

    it('a 403 on a write turns authoring off for the life of the store', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.member, rec);
      const s = await settled(store);
      expect(s.authoring.readOnly).toBe(false);
      const refused = await store.create({
        kind: 'tool_invocation',
        subjects: [freshRole()],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      expect(refused).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } });
      expect(store.getSnapshot().authoring).toEqual({
        readOnly: true,
        reason: 'forbidden',
        canPublish: false,
        canRetire: false,
      });
      const sent = writes(rec);
      const again = await store.setCell(freshRole(), 'mcp:tracker:search', 'ask');
      expect(again).toMatchObject({
        kind: 'error',
        error: { kind: 'precondition', code: 'read_only' },
      });
      const editor = store.editor('pol_silent');
      await untilState(editor, (x) => x.status === 'ready');
      editor.setMode('deny');
      expect(await editor.save()).toMatchObject({ ok: false, error: { code: 'read_only' } });
      expect(writes(rec)).toBe(sent);
    });

    it('names the governing policy of a 409 policy_conflict, from the list', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      // member × search is already governed by pol_default.
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [MEMBER],
        targets: ['mcp:tracker:search'],
        config: { mode: 'deny' },
      });
      if (!created.ok) throw new Error('create failed');
      const editor = store.editor(created.policy.id);
      await untilState(editor, (x) => x.status === 'ready');
      const result = await editor.publish();
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'conflict', code: 'policy_conflict', policyId: 'pol_default' },
      });
      expect(editor.getSnapshot().conflict).toEqual({
        policyId: 'pol_default',
        name: 'Ask the members before a call',
      });
    });

    it('clears on_deny, expires_after and approver_groups when the mode takes none, with a note', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const editor = store.editor('pol_default');
      const e = await untilState(editor, (x) => x.status === 'ready');
      expect(e.working?.config).toMatchObject({
        mode: 'ask',
        on_deny: 'resume',
        expires_after: 'PT1H',
      });
      editor.setCondition('approver_groups', ['grp_ops']);
      editor.setMode('deny');
      const after = editor.getSnapshot();
      expect(after.working?.config).toEqual({ mode: 'deny' });
      expect(after.notes).toEqual(['conditions_cleared']);
      expect(after.dirty).toBe(true);
      editor.setMode('escalate');
      expect(editor.getSnapshot().working?.config).toEqual({ mode: 'escalate' });
    });

    it('refuses to publish a draft that changed since it was loaded, until reloaded', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      const editor = store.editor(id);
      await untilState(editor, (x) => x.status === 'ready');
      // Another administrator writes the draft meanwhile.
      await new Promise((r) => setTimeout(r, 5));
      const other = await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${id}`, {
        kind: 'tool_invocation',
        subjects: [role],
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'deny' },
      });
      expect(other.status).toBe(200);
      const result = await editor.publish();
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'draft_changed' },
      });
      expect(editor.getSnapshot().stale).toBe(true);
      expect(rec.count('POST', `/v1/policies/${id}/publish`)).toBe(0);
      await editor.reload();
      expect(editor.getSnapshot().stale).toBe(false);
      expect(editor.getSnapshot().working?.config).toEqual({ mode: 'deny' });
      expect((await editor.publish()).ok).toBe(true);
    });

    it('an editor reopened after a cell write reads the policy again', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:crm:delete_account'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      const editor = store.editor(id);
      const first = await untilState(editor, (x) => x.status === 'ready');
      expect(first.working?.config).toEqual({ mode: 'ask' });
      // untilState unsubscribed: the editor is closed. A cell write changes the draft meanwhile.
      await untilState(store, (x) => x.policies.some((p) => p.id === id));
      expect(await store.setCell(role, 'mcp:crm:delete_account', 'deny')).toMatchObject({
        kind: 'written',
      });
      const reopened = await untilState(
        editor,
        (x) => x.status === 'ready' && x.working?.config.mode === 'deny'
      );
      expect(reopened.stale).toBe(false);
    });

    it('an open editor turns stale when a cell writes its policy, and its save refuses', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:crm:delete_account'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      const editor = store.editor(id);
      const stop = editor.subscribe(() => undefined);
      try {
        await untilState(editor, (x) => x.status === 'ready');
        await untilState(store, (x) => x.policies.some((p) => p.id === id));
        expect(await store.setCell(role, 'mcp:crm:delete_account', 'deny')).toMatchObject({
          kind: 'written',
        });
        expect(editor.getSnapshot().stale).toBe(true);
        editor.edit({ name: 'Mine' });
        const puts = rec.count('PUT', `/v1/policies/${id}`);
        expect(await editor.save()).toMatchObject({ ok: false, error: { code: 'draft_changed' } });
        expect(rec.count('PUT', `/v1/policies/${id}`)).toBe(puts);
        await editor.reload();
        expect(editor.getSnapshot()).toMatchObject({
          stale: false,
          working: { config: { mode: 'deny' } },
        });
      } finally {
        stop();
      }
    });

    it('publishing twice what was shown never publishes an unseen draft (adv-1)', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      await new Promise((r) => setTimeout(r, 5));
      await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${id}`, {
        kind: 'tool_invocation',
        subjects: [role],
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'ask', approver_groups: ['OUTSIDER_UNSEEN'] },
      });
      for (let i = 0; i < 2; i += 1)
        expect(await store.publish(id, created.policy)).toMatchObject({
          ok: false,
          error: { code: 'draft_changed' },
        });
      expect(rec.count('POST', `/v1/policies/${id}/publish`)).toBe(0);
    });

    it('a draft rewritten in place without updated_at is still told apart by its content (adv-4)', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const base = inProcessFetch(h.mock);
      rec.intercept(async (c, request) => {
        if (c.method !== 'GET' || !c.path.startsWith('/v1/policies/')) return undefined;
        const body = (await (await base(request)).json()) as {
          data: Record<string, unknown> | Record<string, unknown>[];
          meta?: unknown;
        };
        const strip = (row: Record<string, unknown>): Record<string, unknown> => {
          const rest = { ...row };
          Reflect.deleteProperty(rest, 'updated_at');
          return rest;
        };
        return jsonResponse({
          ...body,
          data: Array.isArray(body.data) ? body.data.map(strip) : strip(body.data),
        });
      });
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const id = created.policy.id;
      const editor = store.editor(id);
      await untilState(editor, (x) => x.status === 'ready');
      await call(h.baseUrl, h.tokens.admin, 'PUT', `/v1/policies/${id}`, {
        kind: 'tool_invocation',
        subjects: [role],
        targets: { tools: ['mcp:tracker:search'] },
        config: { mode: 'always_allow' },
      });
      expect(await editor.publish()).toMatchObject({ ok: false, error: { code: 'draft_changed' } });
      expect(rec.count('POST', `/v1/policies/${id}/publish`)).toBe(0);
    });

    it('a new publish clears the last publish line (A2)', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const role = freshRole();
      const created = await store.create({
        kind: 'tool_invocation',
        subjects: [role],
        targets: ['mcp:tracker:search'],
        config: { mode: 'ask' },
      });
      if (!created.ok) throw new Error('create failed');
      const editor = store.editor(created.policy.id);
      const stop = editor.subscribe(() => undefined);
      try {
        await untilState(editor, (x) => x.status === 'ready');
        expect((await editor.publish()).ok).toBe(true);
        await untilState(editor, (x) => x.lastPublished !== undefined && x.status === 'ready');
        // A newer draft from elsewhere, read by a reload: no save runs between the two publishes.
        const other = await call(
          h.baseUrl,
          h.tokens.admin,
          'PUT',
          `/v1/policies/${created.policy.id}`,
          {
            kind: 'tool_invocation',
            subjects: [role],
            targets: { tools: ['mcp:tracker:search'] },
            config: { mode: 'deny' },
          }
        );
        expect(other.status).toBe(200);
        await editor.reload();
        expect(editor.getSnapshot().lastPublished).toBeDefined();
        rec.intercept((c) =>
          c.path.endsWith('/publish') ? problemResponse(503, 'service_unavailable') : undefined
        );
        expect((await editor.publish()).ok).toBe(false);
        expect(editor.getSnapshot().lastPublished).toBeUndefined();
        expect(editor.getSnapshot().error?.kind).toBe('unavailable');
      } finally {
        stop();
      }
    });

    it('refuses to publish unsaved changes', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const editor = store.editor('pol_silent');
      await untilState(editor, (x) => x.status === 'ready');
      editor.edit({ name: 'Renamed' });
      expect(await editor.publish()).toMatchObject({
        ok: false,
        error: { code: 'unsaved_changes' },
      });
      expect(writes(rec)).toBe(0);
    });

    it('a policy whose targets were not stated has no working copy, and says why', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept(async (c, request) => {
        if (!c.path.startsWith('/v1/policies/pol_silent')) return undefined;
        const answer = (await inProcessFetch(h.mock)(request).then((r) => r.json())) as {
          data: Record<string, unknown> | Record<string, unknown>[];
        };
        const strip = (row: Record<string, unknown>): Record<string, unknown> => {
          const rest = { ...row };
          Reflect.deleteProperty(rest, 'targets');
          return rest;
        };
        return jsonResponse({
          ...answer,
          data: Array.isArray(answer.data) ? answer.data.map(strip) : strip(answer.data),
        });
      });
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const editor = store.editor('pol_silent');
      const e = await untilState(editor, (x) => x.status === 'ready');
      expect(e.working).toBeUndefined();
      expect(e.notes).toEqual(['targets_not_stated']);
      expect(await editor.save()).toMatchObject({
        ok: false,
        error: { code: 'targets_not_stated' },
      });
    });

    it('a policy that is not visible is not_found', async () => {
      const { store } = open(h.tokens.admin);
      const e = await untilState(store.editor('pol_nope'), (x) => x.status !== 'loading');
      expect(e.status).toBe('not_found');
    });
  });

  describe('simulate', () => {
    it('sends the version asked for, else the working version of the open editor', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.member, rec);
      await settled(store);
      const sim = store.simulation('pol_default');
      expect((await sim.run({ toolRef: 'mcp:tracker:search', draftVersion: 3 })).ok).toBe(true);
      const sent = rec.calls.filter((c) => c.path === '/v1/policies/pol_default/simulate');
      expect(sent.at(-1)?.body).toEqual({
        draft_version: 3,
        action: { tool_ref: 'mcp:tracker:search', arguments: {} },
      });
      expect(sim.getSnapshot().draftVersion).toBe(3);
      await untilState(store.editor('pol_default'), (x) => x.status === 'ready');
      await sim.run({ toolRef: 'mcp:tracker:search', agentId: 'agt_1', arguments: { q: 1 } });
      expect(
        rec.calls.filter((c) => c.path === '/v1/policies/pol_default/simulate').at(-1)?.body
      ).toEqual({
        draft_version: 3,
        actor: { agent_id: 'agt_1' },
        action: { tool_ref: 'mcp:tracker:search', arguments: { q: 1 } },
      });
    });

    it('a caller the draft names: the policy applied, and considered names it', async () => {
      // No seeded token holds the member role, so the draft names the member user itself.
      const { store: admin } = open(h.tokens.admin);
      await settled(admin);
      const created = await admin.create({
        kind: 'tool_invocation',
        name: 'Members deny',
        subjects: [{ type: 'user', id: 'user_member' }],
        targets: ['mcp:tracker:list_labels'],
        config: { mode: 'deny' },
      });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const { store } = open(h.tokens.member);
      await untilState(store, (x) => x.policies.some((p) => p.id === created.policy.id));
      const outcome = await store
        .simulation(created.policy.id)
        .run({ toolRef: 'mcp:tracker:list_labels' });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
      expect(outcome.result).toMatchObject({
        decision: 'deny',
        enforced: false,
        appliesToCaller: true,
        policy: { id: created.policy.id, version: 1 },
      });
      expect(outcome.result.considered?.policies).toContainEqual(
        expect.objectContaining({ id: created.policy.id, name: 'Members deny', result: 'deny' })
      );
    });

    it('an administrator who holds no member role: the policy does not apply, and the default is a null-id entry', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const outcome = await store.simulation('pol_default').run({ toolRef: 'mcp:tracker:search' });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
      expect(outcome.result.appliesToCaller).toBe(false);
      expect(outcome.result.policy).toBeUndefined();
      expect(outcome.result.considered?.policies).toContainEqual(
        expect.objectContaining({
          kind: 'tool_invocation',
          id: null,
          version: null,
          source: 'default',
        })
      );
      // No editor and no draft known: the version the list shows is named, never left to the service.
      expect(store.simulation('pol_default').getSnapshot()).toMatchObject({
        status: 'done',
        draftVersion: 3,
      });
    });

    it('sends nothing before the capabilities say policies are served', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const l = livePolicies({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.member,
        fetch: rec.fetch,
        enabled: false,
      });
      try {
        const outcome = await l.store
          .simulation('pol_default')
          .run({ toolRef: 'mcp:tracker:search' });
        expect(outcome).toMatchObject({ ok: false, error: { code: 'not_loaded' } });
        expect(rec.calls).toEqual([]);
      } finally {
        l.close();
      }
    });

    it('refuses a run id where runs is not advertised', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/capabilities'
          ? jsonResponse({ data: { features: ['policies'], entitlements: [], resolutions: [] } })
          : undefined
      );
      const { store } = open(h.tokens.member, rec);
      await settled(store);
      const outcome = await store.simulation('pol_default').run({
        toolRef: 'mcp:tracker:search',
        runId: 'run_1',
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: 'runs_not_offered' } });
      expect(rec.count('POST', '/v1/policies/pol_default/simulate')).toBe(0);
    });
  });

  describe('suggested policies', () => {
    it('are not asked for without the entitlement', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec, { suggested: true });
      const s = await settled(store);
      expect(s.suggested.status).toBe('off');
      expect(rec.calls.some((c) => c.query.includes('source=suggested'))).toBe(false);
    });

    it('are read where the organisation holds it: an empty page', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.entitled, rec, { suggested: true });
      const s = await untilState(
        store,
        (x) => x.suggested.status !== 'loading' && x.status === 'ready'
      );
      expect(s.suggested).toEqual({ status: 'ready', policies: [] });
      expect(rec.calls.some((c) => c.query.includes('source=suggested'))).toBe(true);
    });

    it.each([
      [403, 'entitlement_required'],
      [404, 'not_available_on_deployment'],
    ])('a %s %s hides them silently', async (status, code) => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.query.includes('source=suggested') ? problemResponse(status, code) : undefined
      );
      const { store } = open(h.tokens.entitled, rec, { suggested: true });
      const s = await untilState(
        store,
        (x) => x.status === 'ready' && x.suggested.status !== 'loading'
      );
      expect(s.suggested).toEqual({ status: 'hidden', policies: [] });
      expect(s.error).toBeUndefined();
    });
  });

  describe('the reads that do not block the grid', () => {
    it('say when the directory or the connection names could not be read', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/principals' || c.path === '/v1/connections'
          ? problemResponse(503, 'service_unavailable')
          : undefined
      );
      const { store } = open(h.tokens.admin, rec);
      const s = await untilState(
        store,
        (x) => x.status === 'ready' && x.sideErrors.connections !== undefined
      );
      expect(s.sideErrors.roles?.kind).toBe('unavailable');
      expect(s.sideErrors.connections?.kind).toBe('unavailable');
      expect(s.error).toBeUndefined();
    });

    it.each([
      [403, 'forbidden'],
      [404, 'entitlement_required'],
      [503, 'service_unavailable'],
    ])('suggested: a %s %s is an error, not hidden', async (status, code) => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.query.includes('source=suggested') ? problemResponse(status, code) : undefined
      );
      const { store } = open(h.tokens.entitled, rec, { suggested: true });
      const s = await untilState(
        store,
        (x) => x.status === 'ready' && x.suggested.status !== 'loading'
      );
      expect(s.suggested.status).toBe('error');
      expect(s.suggested.error?.code).toBe(code);
    });
  });

  describe('reads that fail', () => {
    it('a list that cannot be parsed is an error, never an empty list', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/policies' && c.query.includes('kind=tool_invocation')
          ? jsonResponse({ data: [{ id: 3 }], meta: { next: null } })
          : undefined
      );
      const { store } = open(h.tokens.admin, rec);
      const s = await settled(store);
      expect(s.status).toBe('error');
      expect(s.error?.kind).toBe('malformed_response');
      expect(s.policies).toEqual([]);
    });

    it('a failed policy read is an error, not a matrix of defaults', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/policies' ? problemResponse(503, 'service_unavailable') : undefined
      );
      const { store } = open(h.tokens.admin, rec);
      const s = await settled(store);
      expect(s.status).toBe('error');
      expect(s.error?.kind).toBe('unavailable');
    });

    it('a list read that fails after a write keeps the grid, says so, and clears on the next', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      const before = await settled(store);
      let failing = true;
      rec.intercept((c) =>
        failing && c.method === 'GET' && c.path === '/v1/policies'
          ? problemResponse(503, 'service_unavailable')
          : undefined
      );
      const write = (): Promise<unknown> =>
        store.create({
          kind: 'tool_invocation',
          subjects: [freshRole()],
          targets: ['mcp:tracker:search'],
          config: { mode: 'ask' },
        });
      await write();
      const failed = await untilState(store, (x) => x.error !== undefined);
      expect(failed.status).toBe('ready');
      expect(failed.error?.kind).toBe('unavailable');
      expect(failed.policies).toEqual(before.policies);
      failing = false;
      await write();
      const cleared = await untilState(store, (x) => x.error === undefined);
      expect(cleared.status).toBe('ready');
    });

    it('an older list read that answers last does not replace a newer one', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const base = inProcessFetch(h.mock);
      let delayNext = true;
      rec.intercept(async (c, request) => {
        if (!(delayNext && c.method === 'GET' && c.query.includes('kind=tool_invocation')))
          return undefined;
        delayNext = false;
        // The list as it is now, answered after the next one.
        const stale = await base(request);
        await new Promise((r) => setTimeout(r, 150));
        return stale;
      });
      const make = async (): Promise<string> => {
        const r = await store.create({
          kind: 'tool_invocation',
          subjects: [freshRole()],
          targets: ['mcp:tracker:search'],
          config: { mode: 'ask' },
        });
        if (!r.ok) throw new Error('create failed');
        return r.policy.id;
      };
      const first = await make();
      const second = await make();
      await untilState(store, (x) =>
        [first, second].every((id) => x.policies.some((p) => p.id === id))
      );
      await new Promise((r) => setTimeout(r, 250));
      const ids = store.getSnapshot().policies.map((p) => p.id);
      expect(ids).toContain(first);
      expect(ids).toContain(second);
    });

    it('follows meta.next across pages', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const toolPages = rec.calls.filter((c) => c.path === '/v1/tools');
      expect(toolPages[0]?.query).toContain('limit=200');
      rec.intercept((c) => {
        if (c.path !== '/v1/tools') return undefined;
        const page = new URLSearchParams(c.query).get('cursor') ?? '0';
        const tool = (ref: string): Record<string, unknown> => ({
          id: ref,
          tool_ref: ref,
          transport: 'mcp',
          side_effect_level: 'read',
          data_routing: 'x',
        });
        return page === '0'
          ? jsonResponse({ data: [tool('t:1')], meta: { next: 'p2' } })
          : jsonResponse({ data: [tool('t:2')], meta: { next: null } });
      });
      await store.refresh();
      expect(store.getSnapshot().tools.map((t) => t.toolRef)).toEqual(['t:1', 't:2']);
    });

    it('a 401 ends the session once and reports it', async () => {
      const onSessionExpired = vi.fn();
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept((c) =>
        c.path === '/v1/capabilities' ? problemResponse(401, 'invalid_token') : undefined
      );
      const { store } = open('bad', rec, { onSessionExpired });
      const s = await settled(store);
      expect(s.status).toBe('error');
      expect(s.error?.kind).toBe('unauthorized');
      expect(onSessionExpired).toHaveBeenCalledTimes(1);
    });
  });

  describe('withdrawn tools', () => {
    it('keeps a withdrawn row with its policy, and a cell on it writes nothing', async () => {
      const rec = recorder(inProcessFetch(h.mock));
      rec.intercept(async (c, request) => {
        if (c.path !== '/v1/tools') return undefined;
        // The mock's own list, with the seeded policy's first target withdrawn.
        const answer = await h.mock.app.fetch(request);
        const body = (await answer.json()) as { data: Record<string, unknown>[]; meta: unknown };
        return jsonResponse({
          ...body,
          data: body.data.map((row) =>
            row.tool_ref === DEFAULT_TARGETS[0] ? { ...row, status: 'withdrawn' } : row
          ),
        });
      });
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const ref = DEFAULT_TARGETS[0] ?? fail();
      expect(store.getSnapshot().tools.find((t) => t.toolRef === ref)).toMatchObject({
        status: 'withdrawn',
        statusKnown: true,
      });
      expect(cell(buildPermissionsMatrix(store.getSnapshot()), 'role:member', ref)).toMatchObject({
        state: 'governed',
        policy: { policyId: 'pol_default' },
      });
      const before = rec.calls.length;
      for (const subject of [MEMBER, freshRole(), { type: 'organization' }] as PolicySubject[]) {
        const result = await store.setCell(subject, ref, 'deny');
        expect(result).toMatchObject({
          kind: 'error',
          error: { kind: 'precondition', code: 'tool_not_callable' },
        });
      }
      expect(rec.calls.length).toBe(before);
    });

    it('on the mock, deleting a connection withdraws its tools: the row stays, read-only, and the policy names it unenforced', async () => {
      const made = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/connections', {
        name: 'withdrawn',
        url: `https://withdrawn-${String(Date.now())}.test/mcp`,
        transport: 'mcp',
        owner_kind: 'org',
      });
      expect(made.status).toBe(201);
      const connectionId = ((await made.json()) as { data: { id: string } }).data.id;
      expect(
        (await call(h.baseUrl, h.tokens.admin, 'POST', `/v1/connections/${connectionId}/refresh`))
          .status
      ).toBe(200);
      const listed = (await (
        await call(h.baseUrl, h.tokens.admin, 'GET', `/v1/tools?connection=${connectionId}`)
      ).json()) as { data: { tool_ref: string }[] };
      const ref = listed.data[0]?.tool_ref ?? fail();
      const role = freshRole();
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.admin, rec);
      await settled(store);
      const written = await store.setCell(role, ref, 'ask');
      if (written.kind !== 'written') throw new Error(JSON.stringify(written));
      expect(await store.publish(written.policy.id, written.policy)).toMatchObject({ ok: true });
      expect(
        (await call(h.baseUrl, h.tokens.admin, 'DELETE', `/v1/connections/${connectionId}`)).status
      ).toBe(204);
      await store.refresh();
      const s = store.getSnapshot();
      expect(s.tools.find((t) => t.toolRef === ref)).toMatchObject({ status: 'withdrawn' });
      expect(
        cell(buildPermissionsMatrix(store.getSnapshot()), `role:${role.id ?? ''}`, ref)
      ).toMatchObject({ state: 'governed', policy: { policyId: written.policy.id } });
      const before = rec.calls.length;
      expect(await store.setCell(role, ref, 'deny')).toMatchObject({
        kind: 'error',
        error: { code: 'tool_not_callable' },
      });
      expect(rec.calls.length).toBe(before);
      const editor = store.editor(written.policy.id);
      const ready = await untilState(editor, (e) => e.status === 'ready');
      expect(ready.current?.unenforcedTargets).toEqual([ref]);
    });
  });

  describe('other kinds', () => {
    it('lists a duplicate_requests policy read-only, summarized', async () => {
      const { store } = open(h.tokens.admin);
      await settled(store);
      const created = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/policies', {
        kind: 'duplicate_requests',
        subjects: [{ type: 'organization' }],
        config: { after_rejection: 'ask_again', max_reasks: 2 },
      });
      expect(created.status).toBe(201);
      await store.refresh();
      const s = store.getSnapshot();
      expect(s.others.status).toBe('ready');
      expect(s.others.policies.map((o) => o.view)).toContainEqual({
        kind: 'duplicate_requests',
        afterRejection: 'ask_again',
        maxReasks: 2,
      });
      expect(s.policies.every((p) => p.kind === 'tool_invocation')).toBe(true);
    });
  });
});

describe('X1: a service that advertises neither author nor publish', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ deployment: 'edge' });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('shows drafts read-only and makes no policy write, while simulate still runs', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const l = livePolicies({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.admin,
      fetch: rec.fetch,
    });
    try {
      const s = await settled(l.store);
      expect(s.status).toBe('ready');
      expect(s.facts).toMatchObject({ served: true, author: false, publish: false });
      expect(s.authoring).toEqual({
        readOnly: true,
        reason: 'not_offered',
        canPublish: false,
        canRetire: false,
      });
      const editor = l.store.editor('pol_default');
      const e = await untilState(editor, (x) => x.status === 'ready');
      expect(e.current?.version).toBe(3);
      editor.setMode('deny');
      expect(await editor.save()).toMatchObject({ ok: false, error: { code: 'read_only' } });
      expect(await editor.publish()).toMatchObject({ ok: false, error: { code: 'read_only' } });
      expect(await l.store.publish('pol_default', e.current ?? fail())).toMatchObject({
        ok: false,
      });
      expect(
        await l.store.setCell({ type: 'role', id: 'x' }, 'mcp:tracker:search', 'ask')
      ).toMatchObject({
        kind: 'error',
      });
      const sim = await l.store.simulation('pol_default').run({ toolRef: 'mcp:tracker:search' });
      expect(sim.ok).toBe(true);
      expect(writes(rec)).toBe(0);
    } finally {
      l.close();
    }
  });

  it('a pending draft is loaded with its version, and no publish is sent, when only publish is missing', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const version = (v: number, published: boolean): Record<string, unknown> => ({
      id: 'pol_default',
      version: v,
      source: 'authored',
      kind: 'tool_invocation',
      state: published ? 'published' : 'draft',
      subjects: [{ type: 'role', id: 'member' }],
      targets: { tools: ['mcp:tracker:search'] },
      config: { mode: published ? 'ask' : 'deny' },
      published_at: published ? '2026-10-01T00:00:00.000Z' : null,
      updated_at: '2026-10-02T00:00:00.000Z',
    });
    rec.intercept((c) =>
      c.path === '/v1/capabilities'
        ? jsonResponse({
            data: { features: ['policies', 'policies.author'], entitlements: [], resolutions: [] },
          })
        : c.path === '/v1/policies/pol_default/versions'
          ? jsonResponse({ data: [version(4, false), version(3, true)], meta: { next: null } })
          : undefined
    );
    const l = livePolicies({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.admin,
      fetch: rec.fetch,
    });
    try {
      const s = await settled(l.store);
      expect(s.authoring).toEqual({ readOnly: false, canPublish: false, canRetire: false });
      const editor = l.store.editor('pol_default');
      const e = await untilState(editor, (x) => x.status === 'ready');
      expect(e.pendingDraft?.version).toBe(4);
      expect(e.workingFrom).toEqual({ version: 4, state: 'draft' });
      expect(e.working?.config).toEqual({ mode: 'deny' });
      expect(l.store.getSnapshot().drafts).toContainEqual(
        expect.objectContaining({ policyId: 'pol_default', version: 4, neverPublished: false })
      );
      expect(await editor.publish()).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'publish_not_offered' },
      });
      expect(await l.store.publish('pol_default', e.pendingDraft ?? fail())).toMatchObject({
        ok: false,
        error: { kind: 'precondition', code: 'publish_not_offered' },
      });
      expect(rec.count('POST', /\/publish$/)).toBe(0);
      // The editor's read; neither refusal reads the versions again.
      expect(rec.count('GET', /\/versions$/)).toBe(1);
    } finally {
      l.close();
    }
  });
});

describe('a service that does not advertise the policies family', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ advertise: ['runs'] });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('is unavailable, and no policy route is called', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const l = livePolicies({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.admin,
      fetch: rec.fetch,
    });
    try {
      const s = await settled(l.store);
      expect(s.status).toBe('unavailable');
      expect(s.error).toBeUndefined();
      expect(rec.calls.filter((c) => c.path.startsWith('/v1/policies'))).toEqual([]);
    } finally {
      l.close();
    }
  });
});

describe('a service that leaves considered out of a simulation', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ breaks: new Set(['simulate_considered_missing']) });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('is still a result, with considered undefined', async () => {
    const l = livePolicies({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.member,
      fetch: inProcessFetch(h.mock),
    });
    try {
      await settled(l.store);
      const outcome = await l.store
        .simulation('pol_default')
        .run({ toolRef: 'mcp:tracker:search' });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
      expect(outcome.result.considered).toBeUndefined();
      expect(outcome.result.decision).toBe('allow');
      expect(outcome.result.appliesToCaller).toBeUndefined();
    } finally {
      l.close();
    }
  });
});
