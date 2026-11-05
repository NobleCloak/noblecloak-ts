import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PolicyRule } from './permissions-rules.js';
import type { PoliciesStore, PolicyEditorStore } from './permissions-types.js';
import {
  call,
  inProcessFetch,
  jsonResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness, Recorder } from './testing/approvals-harness.js';
import { livePolicies, settled, untilState } from './testing/permissions-harness.js';
import type { LivePolicies } from './testing/permissions-harness.js';

type Json = Record<string, unknown>;

const AMOUNT_RULE: PolicyRule = {
  when: [{ fact: 'amount', op: 'gt', value: 5000 }],
  then: 'deny',
};

let h: Harness;
const opened: LivePolicies[] = [];
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  for (const l of opened) l.close();
  await h.stop();
});

let unique = 0;

function open(rec?: Recorder, token: string = h.tokens.admin): LivePolicies {
  const l = livePolicies({
    baseUrl: h.baseUrl,
    getToken: () => token,
    fetch: rec?.fetch ?? inProcessFetch(h.mock),
  });
  opened.push(l);
  return l;
}

/** Registers an organisation tool with an `amount` fact, and returns its reference. */
async function registerTool(facts: Json = { amount: { path: '.amount', type: 'number' } }) {
  unique += 1;
  const ref = `ext:rules:${String(unique)}`;
  const response = await call(h.baseUrl, h.tokens.admin, 'POST', '/v1/tools', {
    tool_ref: ref,
    transport: 'external',
    input_schema: { type: 'object' },
    side_effect_level: 'write',
    owner_kind: 'org',
    facts,
  });
  if (response.status !== 201) throw new Error(`tool: ${String(response.status)}`);
  return ref;
}

/** A store, a draft policy on a new tool, and its subscribed editor. */
async function withEditor(rec?: Recorder) {
  const ref = await registerTool();
  const live = open(rec);
  await settled(live.store);
  const created = await live.store.create({
    kind: 'tool_invocation',
    subjects: [{ type: 'organization' }],
    targets: [ref],
    config: { mode: 'ask' },
  });
  if (!created.ok) throw new Error('create failed');
  const id = created.policy.id;
  const editor: PolicyEditorStore = live.store.editor(id);
  const stop = editor.subscribe(() => undefined);
  opened.push({ store: live.store, close: stop });
  await untilState(editor, (x) => x.status === 'ready');
  return { store: live.store, editor, id, ref };
}

const config = (editor: PolicyEditorStore): Json => editor.getSnapshot().working?.config ?? {};

const puts = (rec: Recorder) => rec.calls.filter((c) => c.method === 'PUT');

describe('what the store reads for rules', () => {
  it('reads the facts of a tool and the config members and approval_routing form the service lists', async () => {
    const ref = await registerTool();
    const live = open();
    const s = await settled(live.store);
    const tool = s.tools.find((t) => t.toolRef === ref);
    expect(tool?.facts).toEqual({ amount: { path: '.amount', type: 'number' } });
    expect(s.facts?.policyForms?.toolInvocation?.configMembers).toEqual(
      expect.arrayContaining(['rules', 'approvers', 'exclude'])
    );
    expect(s.facts?.policyForms?.approvalRouting).toBe(true);
  });

  it('reads no facts for a tool whose facts it cannot read in full', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const ref = await registerTool();
    rec.intercept(async (c, request) => {
      if (c.method !== 'GET' || c.path !== '/v1/tools') return undefined;
      const body = (await (await inProcessFetch(h.mock)(request)).json()) as { data: Json[] };
      return jsonResponse({
        ...body,
        data: body.data.map((t) => (t.tool_ref === ref ? { ...t, facts: { amount: 3 } } : t)),
      });
    });
    const s = await settled(open(rec).store);
    const tool = s.tools.find((t) => t.toolRef === ref);
    expect(tool).toBeDefined();
    expect(tool?.facts).toBeUndefined();
  });

  it('lists no routing form where the service does not serve approvals', async () => {
    const edge = await startHarness({ advertise: ['policies', 'agents', 'principals'] });
    try {
      const live = livePolicies({
        baseUrl: edge.baseUrl,
        getToken: () => edge.tokens.admin,
        fetch: inProcessFetch(edge.mock),
      });
      const s = await settled(live.store);
      expect(s.facts?.policyForms?.approvalRouting).toBeUndefined();
      live.close();
    } finally {
      await edge.stop();
    }
  });
});

describe('the editor actions for rules, approvers and exclude', () => {
  it('sets the rules in order, marks the copy changed, and removes the member for none or an empty list', async () => {
    const { editor } = await withEditor();
    expect(editor.getSnapshot().dirty).toBe(false);
    const second: PolicyRule = {
      when: [{ fact: 'amount', op: 'lte', value: 50 }],
      then: 'always_allow',
    };
    editor.setRules([AMOUNT_RULE, second]);
    expect(config(editor).rules).toEqual([AMOUNT_RULE, second]);
    expect(editor.getSnapshot().dirty).toBe(true);
    editor.setRules([second, AMOUNT_RULE]);
    expect(config(editor).rules).toEqual([second, AMOUNT_RULE]);
    editor.setRules([]);
    expect(config(editor)).not.toHaveProperty('rules');
    expect(editor.getSnapshot().dirty).toBe(false);
    editor.setRules([AMOUNT_RULE]);
    editor.setRules(undefined);
    expect(config(editor)).not.toHaveProperty('rules');
  });

  it('sets the policy approvers and exclude, and removes each for none or an empty list', async () => {
    const { editor } = await withEditor();
    editor.setApprovers([
      { role: 'finance' },
      { user: 'u-1', when: [{ fact: 'amount', op: 'exists' }] },
    ]);
    editor.setExclude(['requester']);
    expect(config(editor)).toMatchObject({
      mode: 'ask',
      approvers: [{ role: 'finance' }, { user: 'u-1', when: [{ fact: 'amount', op: 'exists' }] }],
      exclude: ['requester'],
    });
    editor.setApprovers([]);
    editor.setExclude(undefined);
    expect(config(editor)).toEqual({ mode: 'ask' });
    expect(editor.getSnapshot().dirty).toBe(false);
  });

  it('keeps the rules when the mode changes, and clears the ask members only', async () => {
    const { editor } = await withEditor();
    editor.setCondition('on_deny', 'halt');
    editor.setRules([AMOUNT_RULE]);
    editor.setApprovers([{ role: 'finance' }]);
    editor.setExclude(['requester']);
    editor.setMode('deny');
    expect(config(editor)).toEqual({
      mode: 'deny',
      rules: [AMOUNT_RULE],
      approvers: [{ role: 'finance' }],
      exclude: ['requester'],
    });
    expect(editor.getSnapshot().notes).toContain('conditions_cleared');
  });

  it('saves the rules and reads them back from the service', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { editor, id } = await withEditor(rec);
    editor.setRules([AMOUNT_RULE]);
    editor.setApprovers([{ role: 'finance' }]);
    editor.setExclude(['requester']);
    const saved = await editor.save();
    expect(saved.ok).toBe(true);
    expect(puts(rec).at(-1)?.body).toMatchObject({
      config: {
        mode: 'ask',
        rules: [AMOUNT_RULE],
        approvers: [{ role: 'finance' }],
        exclude: ['requester'],
      },
    });
    await editor.reload();
    await untilState(editor, (x) => x.status === 'ready' && !x.dirty);
    expect(editor.getSnapshot().pendingDraft?.config).toMatchObject({ rules: [AMOUNT_RULE] });
    expect(id).toBeTruthy();
  });

  it('sends nothing and says rules_invalid while a rule holds what the contract refuses', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { editor } = await withEditor(rec);
    const before = puts(rec).length;
    editor.setRules([{ when: [{ fact: 'amount', op: 'gt' }], then: 'deny' }]);
    const refused = await editor.save();
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'rules_invalid' },
    });
    expect(puts(rec).length).toBe(before);
    expect(editor.getSnapshot().error).toMatchObject({ code: 'rules_invalid' });
    // Fixed, it is sent.
    editor.setRules([AMOUNT_RULE]);
    expect((await editor.save()).ok).toBe(true);
  });

  it('sends nothing for a fact the one registered target does not declare: the contract refuses it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { editor } = await withEditor(rec);
    const before = puts(rec).length;
    editor.setRules([{ when: [{ fact: 'ghost', op: 'exists' }], then: 'deny' }]);
    const result = await editor.save();
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'rules_invalid' },
    });
    expect(puts(rec).length).toBe(before);
  });

  it('does not block a save on a warning: with every tool as the target the contract accepts an undeclared fact', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { editor } = await withEditor(rec);
    editor.edit({ targets: 'all' });
    editor.setRules([{ when: [{ fact: 'ghost', op: 'exists' }], then: 'deny' }]);
    const before = puts(rec).length;
    const result = await editor.save();
    expect(puts(rec).length).toBeGreaterThan(before);
    expect(result.ok).toBe(true);
  });

  it('never replaces a rules member it could not read, and a save sends it as it was', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { editor, id, ref } = await withEditor(rec);
    editor.setRules([AMOUNT_RULE]);
    await editor.save();
    // Another reader sees the policy with a `rules` member of a shape this module does not know.
    const odd = { unknown_shape: true };
    const store2 = open(
      (() => {
        const r = recorder(inProcessFetch(h.mock));
        r.intercept(async (c, request) => {
          if (c.method !== 'GET' || !c.path.startsWith(`/v1/policies/${id}`)) return undefined;
          const text = await (await inProcessFetch(h.mock)(request)).text();
          return jsonResponse(
            JSON.parse(text.replaceAll('"rules":[', `"rules":${JSON.stringify(odd)},"was":[`))
          );
        });
        return r;
      })()
    );
    await settled(store2.store);
    const editor2 = store2.store.editor(id);
    const stop = editor2.subscribe(() => undefined);
    await untilState(editor2, (x) => x.status === 'ready');
    expect(config(editor2).rules).toEqual(odd);
    editor2.setRules([]);
    editor2.setRules(undefined);
    editor2.setRules([AMOUNT_RULE]);
    expect(config(editor2).rules).toEqual(odd);
    // The other members are still editable.
    editor2.setExclude(['requester']);
    expect(config(editor2).exclude).toEqual(['requester']);
    stop();
    expect(ref).toBeTruthy();
  });
});

describe('simulating a policy with rules', () => {
  async function published() {
    const { store, editor, id, ref } = await withEditor();
    editor.setRules([
      AMOUNT_RULE,
      { when: [{ fact: 'amount', op: 'lte', value: 50 }], then: 'always_allow' },
    ]);
    expect((await editor.save()).ok).toBe(true);
    return { store, id, ref };
  }

  it('shows which rule decided and what it was', async () => {
    const { store, id, ref } = await published();
    const sim = store.simulation(id);
    const result = await sim.run({ toolRef: ref, arguments: { amount: 6000 } });
    if (!result.ok) throw new Error('simulation failed');
    const entry = result.result.considered?.policies.find((p) => p.id === id);
    expect(entry).toMatchObject({ result: 'deny', rule: { index: 0, then: 'deny' } });
    expect(entry?.missingFacts).toBeUndefined();
    expect(result.result.missingFacts).toBeUndefined();
    const second = await sim.run({ toolRef: ref, arguments: { amount: 10 } });
    if (!second.ok) throw new Error('simulation failed');
    expect(second.result.considered?.policies.find((p) => p.id === id)?.rule).toEqual({
      index: 1,
      then: 'always_allow',
    });
  });

  it('shows no rule when the mode decided, and the missing facts when the call did not carry them', async () => {
    const { store, id, ref } = await published();
    const sim = store.simulation(id);
    const mode = await sim.run({ toolRef: ref, arguments: { amount: 100 } });
    if (!mode.ok) throw new Error('simulation failed');
    const modeEntry = mode.result.considered?.policies.find((p) => p.id === id);
    expect(modeEntry?.result).toBe('ask');
    expect(modeEntry).not.toHaveProperty('rule');
    const missing = await sim.run({ toolRef: ref, arguments: {} });
    if (!missing.ok) throw new Error('simulation failed');
    const entry = missing.result.considered?.policies.find((p) => p.id === id);
    expect(entry).toMatchObject({ result: 'ask', missingFacts: ['amount'] });
    expect(entry).not.toHaveProperty('rule');
    expect(missing.result.missingFacts).toEqual(['amount']);
  });
});

describe('the organisation’s break-glass setting', () => {
  const routing = (store: PoliciesStore) =>
    store
      .getSnapshot()
      .others.policies.filter(
        (o) => o.policy.kind === 'approval_routing' && o.policy.state === 'published'
      );

  it('writes an approval_routing policy for the organisation, publishes it, and lists it', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const live = open(rec);
    await settled(live.store);
    const result = await live.store.setApprovalRouting(false);
    expect(result).toMatchObject({
      ok: true,
      policy: { kind: 'approval_routing', state: 'published' },
    });
    const post = rec.calls.find((c) => c.method === 'POST' && c.path === '/v1/policies');
    expect(post?.body).toMatchObject({
      kind: 'approval_routing',
      subjects: [{ type: 'organization' }],
      targets: { tools: 'all' },
      config: { org_admin_break_glass: false },
    });
    expect(rec.count('POST', /\/v1\/policies\/[^/]+\/publish$/)).toBe(1);
    await untilState(live.store, (s) =>
      s.others.policies.some(
        (o) => o.policy.id === (result.ok ? result.policy.id : '') && o.policy.state === 'published'
      )
    );
    expect(routing(live.store).at(-1)?.view).toEqual({
      kind: 'approval_routing',
      breakGlass: false,
    });
  });

  it('writes over the policy in force on a later change, so the organisation keeps one published policy', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const live = open(rec);
    await settled(live.store);
    const first = await live.store.setApprovalRouting(false);
    // Straight away, before the lists show the first write.
    const second = await live.store.setApprovalRouting(true);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(second.ok && first.ok && second.policy.id).toBe(first.ok ? first.policy.id : '');
    expect(rec.count('POST', /^\/v1\/policies$/)).toBeLessThanOrEqual(1);
    await untilState(live.store, () => {
      const listed = routing(live.store);
      return listed.length === 1 && JSON.stringify(listed[0]?.view).includes('true');
    });
    expect(routing(live.store)).toHaveLength(1);
  });

  it('refuses, and leaves alone, a pending draft someone else wrote over the policy in force', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const live = open(rec);
    await settled(live.store);
    const first = await live.store.setApprovalRouting(false);
    expect(first).toMatchObject({ ok: true });
    const id = first.ok ? first.policy.id : '';
    // Another administrator's draft, with an edit of its own beside the setting.
    const foreign = await inProcessFetch(h.mock)(`${h.baseUrl}/v1/policies/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${h.tokens.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'approval_routing',
        subjects: [{ type: 'organization' }],
        targets: { tools: 'all' },
        config: { org_admin_break_glass: false },
        description: 'pending review',
      }),
    });
    expect(foreign.ok).toBe(true);
    const publishes = rec.count('POST', /\/v1\/policies\/[^/]+\/publish$/);
    const result = await live.store.setApprovalRouting(true);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'draft_changed' },
    });
    expect(rec.count('POST', /\/v1\/policies\/[^/]+\/publish$/)).toBe(publishes);
    expect(rec.count('DELETE', /\/v1\/policies\/[^/]+\/draft$/)).toBe(0);
    const versions = (await (
      await inProcessFetch(h.mock)(`${h.baseUrl}/v1/policies/${id}/versions`, {
        headers: { authorization: `Bearer ${h.tokens.admin}` },
      })
    ).json()) as { data: readonly Json[] };
    expect(versions.data[0]).toMatchObject({ state: 'draft', description: 'pending review' });
    // The tests share one organisation: the other administrator withdraws their draft.
    const withdrawn = await inProcessFetch(h.mock)(`${h.baseUrl}/v1/policies/${id}/draft`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${h.tokens.admin}` },
    });
    expect(withdrawn.ok).toBe(true);
  });

  it('discards the draft it wrote when it cannot publish it, so none is left in the Drafts tray', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    rec.intercept((c) =>
      c.method === 'POST' && /\/v1\/policies\/[^/]+\/publish$/.test(c.path)
        ? new Response(
            JSON.stringify({ type: 'https://x/problems/unavailable', title: 'down', status: 503 }),
            { status: 503, headers: { 'content-type': 'application/problem+json' } }
          )
        : undefined
    );
    const live = open(rec);
    await settled(live.store);
    const result = await live.store.setApprovalRouting(true);
    expect(result).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
    expect(rec.count('DELETE', /\/v1\/policies\/[^/]+\/draft$/)).toBe(1);
    expect(
      live.store.getSnapshot().drafts.filter((d) => d.policy.kind === 'approval_routing')
    ).toEqual([]);
  });

  it('is refused without a request where the form is not listed, where authoring is off, and where publishing is not offered', async () => {
    const noApprovals = await startHarness({ advertise: ['policies', 'agents', 'principals'] });
    try {
      const rec = recorder(inProcessFetch(noApprovals.mock));
      const live = livePolicies({
        baseUrl: noApprovals.baseUrl,
        getToken: () => noApprovals.tokens.admin,
        fetch: rec.fetch,
      });
      await settled(live.store);
      const before = rec.calls.length;
      expect(await live.store.setApprovalRouting(true)).toMatchObject({
        ok: false,
        error: { code: 'approval_routing_not_offered' },
      });
      expect(rec.calls.length).toBe(before);
      live.close();
    } finally {
      await noApprovals.stop();
    }
    const rec = recorder(inProcessFetch(h.mock));
    const readOnly = livePolicies({
      baseUrl: h.baseUrl,
      getToken: () => h.tokens.admin,
      fetch: rec.fetch,
      readOnly: true,
    });
    await settled(readOnly.store);
    const before = rec.calls.length;
    expect(await readOnly.store.setApprovalRouting(true)).toMatchObject({
      ok: false,
      error: { code: 'read_only' },
    });
    expect(rec.calls.length).toBe(before);
    readOnly.close();
  });
});
