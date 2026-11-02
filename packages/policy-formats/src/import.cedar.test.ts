import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalPolicy } from './canonical.js';
import { PolicyFormatError } from './errors.js';
import { exportCedar } from './export.js';
import { cedar, fixture } from './fixtures.test-support.js';
import { importCedar } from './import.js';
import type { ExportablePolicy } from './types.js';

const ACTION = 'action == NobleCloak::Action::"tool_invocation"';

/** One statement this package would write for policy `p`, with the annotations given (in that order). */
function statement(annotations: Record<string, string>, body: string): string {
  const lines = Object.entries(annotations).map(
    ([key, value]) => `@${key}(${JSON.stringify(value)})`
  );
  return `${lines.join('\n')}\n${body}\n`;
}

const ORG_ALL = `(\n  principal,\n  ${ACTION},\n  resource\n);`;

async function run(text: string) {
  return importCedar(text, { cedar });
}

describe('importCedar: statements written elsewhere', () => {
  it('a bare permit, forbid and principal/resource forms import by their body, each as a policy without a key', async () => {
    const result = await run(`
      permit (principal == NobleCloak::User::"u1", ${ACTION}, resource == NobleCloak::Tool::"t1");
      forbid (principal in NobleCloak::Role::"member", action, resource)
        when { [NobleCloak::Tool::"a", NobleCloak::Tool::"b"].contains(resource) };
      permit (principal, action in [NobleCloak::Action::"tool_invocation"], resource);
      permit (principal, action in [NobleCloak::Action::"tool_invocation", NobleCloak::Action::"tool_invocation"], resource);
    `);
    expect(result.policies.map((policy) => policy.key)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.policies.map((policy) => policy.write)).toEqual([
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'user', id: 'u1' }],
        targets: { tools: ['t1'] },
        config: { mode: 'always_allow' },
      },
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'role', id: 'member' }],
        targets: { tools: ['a', 'b'] },
        config: { mode: 'deny' },
      },
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'organization' }],
        targets: { tools: 'all' },
        config: { mode: 'always_allow' },
      },
      {
        kind: 'tool_invocation',
        subjects: [{ type: 'organization' }],
        targets: { tools: 'all' },
        config: { mode: 'always_allow' },
      },
    ]);
    expect(result.unsupported).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('a permit with @advice escalate imports as ask; its foreign reason and other annotations are reported as lossy', async () => {
    const result = await run(
      statement(
        { advice: '{"verdict":"escalate","reason":"approval_required"}', id: 'x', owner: 'me' },
        `permit ${ORG_ALL}`
      )
    );
    expect(result.policies.map((policy) => (policy.write.config as { mode: string }).mode)).toEqual(
      ['ask']
    );
    expect(result.lossy.map((entry) => entry.path).sort()).toEqual([
      '/policies/0/annotations/advice',
      '/policies/0/annotations/id',
      '/policies/0/annotations/owner',
    ]);
    expect(result.lossy.find((entry) => entry.path.endsWith('/advice'))?.reason).toContain(
      '"approval_required"'
    );
  });

  it('an @advice escalate with no reason imports as ask, reported', async () => {
    const result = await run(statement({ advice: '{"verdict":"escalate"}' }, `permit ${ORG_ALL}`));
    expect(result.policies).toHaveLength(1);
    expect(result.lossy).toEqual([
      { path: '/policies/0/annotations/advice', reason: 'an escalate advice is imported as ask' },
    ]);
  });

  it('@advice warn or transform, or advice that is not JSON, is unsupported', async () => {
    const result = await run(
      [
        statement({ advice: '{"verdict":"warn"}' }, `permit ${ORG_ALL}`),
        statement(
          { advice: '{"verdict":"transform","transform":{"path":"$target","value":1}}' },
          `permit ${ORG_ALL}`
        ),
        statement({ advice: 'not json' }, `permit ${ORG_ALL}`),
      ].join('\n')
    );
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/policies/0/annotations/advice',
      '/policies/1/annotations/advice',
      '/policies/2/annotations/advice',
    ]);
  });

  it('constructs outside the subset are unsupported with path-level reasons, never dropped', async () => {
    const result = await run(`
      permit (principal is NobleCloak::User, ${ACTION}, resource);
      permit (principal, action == NobleCloak::Action::"other", resource);
      permit (principal, action in [NobleCloak::Action::"tool_invocation", NobleCloak::Action::"other"], resource);
      permit (principal, ${ACTION}, resource in NobleCloak::Tool::"t");
      permit (principal, ${ACTION}, resource) when { context.amount > 10 };
      permit (principal, ${ACTION}, resource) unless { [NobleCloak::Tool::"a"].contains(resource) };
      permit (principal, ${ACTION}, resource == NobleCloak::Tool::"x") when { [NobleCloak::Tool::"a"].contains(resource) };
      permit (principal == NobleCloak::Role::"r", ${ACTION}, resource);
      permit (principal == ?principal, ${ACTION}, resource);
    `);
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/policies/0/principal',
      '/policies/1/action',
      '/policies/2/action',
      '/policies/3/resource',
      '/policies/4/conditions/0',
      '/policies/5/conditions/0',
      '/policies/6/conditions/0',
      '/policies/7/principal',
      '/templates/0',
    ]);
  });

  it('a policy outside rev 10 (an illegal member for its mode, an unknown NobleCloak annotation) is unsupported', async () => {
    const result = await run(
      [
        statement(
          { noblecloak_policy: 'a', noblecloak_mode: 'deny', noblecloak_on_deny: 'halt' },
          `forbid ${ORG_ALL}`
        ),
        statement({ noblecloak_policy: 'b', noblecloak_future: 'x' }, `forbid ${ORG_ALL}`),
        statement({ noblecloak_policy: 'c', noblecloak_kind: 'spending' }, `forbid ${ORG_ALL}`),
        statement({ noblecloak_policy: 'd', noblecloak_on_deny: 'later' }, `forbid ${ORG_ALL}`),
        statement(
          { noblecloak_policy: 'e', noblecloak_approver_groups: '[1]' },
          `forbid ${ORG_ALL}`
        ),
        statement(
          { noblecloak_policy: 'f', noblecloak_approver_groups: 'nope' },
          `forbid ${ORG_ALL}`
        ),
        statement({ noblecloak_policy: '' }, `forbid ${ORG_ALL}`),
      ].join('\n')
    );
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => [entry.policy, entry.path])).toEqual([
      ['b', '/policies/1/annotations/noblecloak_future'],
      ['c', '/policies/2/annotations/noblecloak_kind'],
      ['d', '/policies/3/annotations/noblecloak_on_deny'],
      ['e', '/policies/4/annotations/noblecloak_approver_groups'],
      ['f', '/policies/5/annotations/noblecloak_approver_groups'],
      [undefined, '/policies/6/annotations/noblecloak_policy'],
      ['a', '/policies/0'],
    ]);
    expect(result.unsupported.at(-1)?.reason).toContain('/config/on_deny');
  });

  it('a bare annotation reads as the empty string', async () => {
    const result = await run(`@noblecloak_policy("p")\n@noblecloak_description\nforbid ${ORG_ALL}`);
    expect(result.policies[0]?.write.description).toBe('');
  });
});

describe('importCedar: body and annotations', () => {
  const conflicts: readonly [string, Record<string, string>, 'permit' | 'forbid'][] = [
    ['ask on a forbid without the fail-closed marker', { noblecloak_mode: 'ask' }, 'forbid'],
    [
      'the marker on a permit',
      { noblecloak_mode: 'ask', noblecloak_encoding: 'fail_closed' },
      'permit',
    ],
    [
      'the marker on a deny',
      { noblecloak_mode: 'deny', noblecloak_encoding: 'fail_closed' },
      'forbid',
    ],
    [
      'the marker with a value other than fail_closed',
      { noblecloak_mode: 'ask', noblecloak_encoding: 'x' },
      'forbid',
    ],
    ['always_allow on a forbid', { noblecloak_mode: 'always_allow' }, 'forbid'],
    ['deny on a permit', { noblecloak_mode: 'deny' }, 'permit'],
    ['ask on a permit without @advice', { noblecloak_mode: 'ask' }, 'permit'],
    ['a mode that is no mode', { noblecloak_mode: 'maybe' }, 'forbid'],
    [
      '@advice on a forbid',
      { noblecloak_mode: 'deny', advice: '{"verdict":"escalate"}' },
      'forbid',
    ],
    [
      '@advice on an always_allow permit',
      { noblecloak_mode: 'always_allow', advice: '{"verdict":"escalate"}' },
      'permit',
    ],
    [
      'an @advice reason naming the other approval mode',
      { noblecloak_mode: 'ask', advice: '{"verdict":"escalate","reason":"noblecloak.escalate:p"}' },
      'permit',
    ],
    [
      'an @advice reason naming another policy',
      { noblecloak_mode: 'ask', advice: '{"verdict":"escalate","reason":"noblecloak.ask:q"}' },
      'permit',
    ],
    [
      'an @id that is not the derived reason',
      { noblecloak_mode: 'deny', id: 'noblecloak.deny:q' },
      'forbid',
    ],
  ];

  for (const [label, annotations, effect] of conflicts) {
    it(`a conflict, and nothing imported: ${label}`, async () => {
      const result = await run(
        statement({ noblecloak_policy: 'p', ...annotations }, `${effect} ${ORG_ALL}`)
      );
      expect(result.policies).toEqual([]);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.policy).toBe('p');
      expect(result.unsupported).toEqual([]);
    });
  }

  it('the fail-closed marker is honoured: a forbid marked ask imports as ask', async () => {
    const result = await run(
      statement(
        {
          noblecloak_policy: 'p',
          noblecloak_mode: 'ask',
          noblecloak_encoding: 'fail_closed',
          id: 'noblecloak.ask:p',
        },
        `forbid ${ORG_ALL}`
      )
    );
    expect(result.conflicts).toEqual([]);
    expect(result.policies[0]?.write.config).toEqual({ mode: 'ask' });
  });

  it('a permit with our @advice and no mode annotation takes the mode from the reason', async () => {
    const result = await run(
      statement(
        {
          noblecloak_policy: 'p',
          advice: '{"verdict":"escalate","reason":"noblecloak.escalate:p"}',
        },
        `permit ${ORG_ALL}`
      )
    );
    expect(result.policies[0]?.write.config).toEqual({ mode: 'escalate' });
    expect(result.lossy).toEqual([]);
  });

  it('an edited body wins over nothing: a statement whose subject was edited imports the edit', async () => {
    const policy: ExportablePolicy = {
      id: 'p',
      kind: 'tool_invocation',
      subjects: [{ type: 'user', id: 'u1' }],
      config: { mode: 'deny' },
    };
    const edited = exportCedar([policy]).text.replace('User::"u1"', 'User::"u2"');
    const result = await run(edited);
    expect(result.policies[0]?.write.subjects).toEqual([{ type: 'user', id: 'u2' }]);
  });

  it('a policy is imported whole or not at all: one bad statement keeps its siblings out', async () => {
    const policy: ExportablePolicy = {
      id: 'p',
      kind: 'tool_invocation',
      subjects: [
        { type: 'user', id: 'u1' },
        { type: 'user', id: 'u2' },
      ],
      config: { mode: 'deny' },
    };
    const text = exportCedar([policy]).text.replace(
      'User::"u2",\n  action == NobleCloak::Action::"tool_invocation",\n  resource\n);',
      'User::"u2",\n  action == NobleCloak::Action::"tool_invocation",\n  resource\n) when { context.x };'
    );
    const result = await run(text);
    expect(result.policies).toEqual([]);
    expect(result.unsupported.map((entry) => entry.path)).toEqual([
      '/policies/1/conditions/0',
      '/policies/0',
    ]);
    expect(result.unsupported[1]?.reason).toContain('another statement of policy "p"');
  });

  it('statements of one policy that disagree on anything but the principal are a conflict', async () => {
    const policy: ExportablePolicy = {
      id: 'p',
      kind: 'tool_invocation',
      name: 'n',
      subjects: [
        { type: 'user', id: 'u1' },
        { type: 'user', id: 'u2' },
      ],
      config: { mode: 'deny' },
    };
    const text = exportCedar([policy]).text.replace(
      /@noblecloak_name\("n"\)\n(?![\s\S]*@noblecloak_name)/,
      '@noblecloak_name("m")\n'
    );
    const result = await run(text);
    expect(result.policies).toEqual([]);
    expect(result.conflicts.map((entry) => entry.path)).toEqual(['/policies/0', '/policies/1']);
  });

  it('two statements of one policy with the same principal are an invalid policy (duplicate subject)', async () => {
    const one = statement({ noblecloak_policy: 'p', noblecloak_mode: 'deny' }, `forbid ${ORG_ALL}`);
    const result = await run(`${one}\n${one}`);
    expect(result.policies).toEqual([]);
    expect(result.unsupported[0]?.reason).toContain('subjects must be unique');
  });
});

describe('importCedar: what advice and baseline carry beyond the mode', () => {
  it('an @advice message is lossy; transform, an unknown member or a non-string reason is unsupported', async () => {
    const message = await run(
      statement(
        {
          noblecloak_policy: 'p',
          advice:
            '{"verdict":"escalate","reason":"noblecloak.ask:p","message":"Call security first"}',
        },
        `permit ${ORG_ALL}`
      )
    );
    expect(message.policies).toHaveLength(1);
    expect(message.lossy.map((entry) => entry.reason)).toEqual([
      'the @advice message "Call security first" is not kept',
    ]);
    const rejected = await run(
      [
        statement(
          { advice: '{"verdict":"escalate","transform":{"path":"$target","value":1}}' },
          `permit ${ORG_ALL}`
        ),
        statement({ advice: '{"verdict":"escalate","extra":1}' }, `permit ${ORG_ALL}`),
        statement({ advice: '{"verdict":"escalate","reason":42}' }, `permit ${ORG_ALL}`),
        statement({ advice: '{"verdict":"escalate","message":{}}' }, `permit ${ORG_ALL}`),
      ].join('\n')
    );
    expect(rejected.policies).toEqual([]);
    expect(rejected.unsupported.map((entry) => entry.path)).toEqual(
      [0, 1, 2, 3].map((n) => `/policies/${String(n)}/annotations/advice`)
    );
  });

  it('a mode annotation makes a reasonless advice exact; a keyless statement whose reason names a key reports the key', async () => {
    const annotated = await run(
      statement(
        { noblecloak_mode: 'escalate', advice: '{"verdict":"escalate"}' },
        `permit ${ORG_ALL}`
      )
    );
    expect(annotated.policies[0]?.write.config).toEqual({ mode: 'escalate' });
    expect(annotated.lossy).toEqual([]);
    const keyless = await run(
      statement(
        { advice: '{"verdict":"escalate","reason":"noblecloak.escalate:foo"}' },
        `permit ${ORG_ALL}`
      )
    );
    expect(keyless.policies[0]?.key).toBeUndefined();
    expect(keyless.lossy.map((entry) => entry.reason)).toEqual([
      expect.stringContaining('names policy "foo"'),
    ]);
  });

  it('foreign annotations on the baseline statement are lossy', async () => {
    const result = await run(
      statement(
        { noblecloak_baseline: 'allow', id: 'why', owner: 'secops' },
        `permit (\n  principal,\n  ${ACTION},\n  resource\n);`
      )
    );
    expect(result.options).toEqual({ baseline: 'allow' });
    expect(result.lossy.map((entry) => entry.path)).toEqual([
      '/policies/0/annotations/id',
      '/policies/0/annotations/owner',
    ]);
  });
});

describe('importCedar: grouping', () => {
  it('statements of one policy may interleave with another and come in any subject order', async () => {
    const a: ExportablePolicy = {
      id: 'a',
      kind: 'tool_invocation',
      subjects: [
        { type: 'user', id: 'u1' },
        { type: 'user', id: 'u2' },
      ],
      config: { mode: 'deny' },
    };
    const b: ExportablePolicy = { ...a, id: 'b', config: { mode: 'always_allow' } };
    const statements = exportCedar([a, b]).text.split('\n\n').slice(1);
    const [a1, a2, b1, b2] = statements;
    const result = await run([a2, b1, a1, b2].join('\n\n'));
    expect(result.policies.map((policy) => [policy.key, canonicalPolicy(policy.write)])).toEqual([
      ['a', canonicalPolicy(a)],
      ['b', canonicalPolicy(b)],
    ]);
  });

  it('a policy rejected for a conflict reports its siblings as conflicts too', async () => {
    const result = await run(
      [
        statement({ noblecloak_policy: 'p', noblecloak_mode: 'always_allow' }, `forbid ${ORG_ALL}`),
        statement(
          { noblecloak_policy: 'p', noblecloak_mode: 'deny' },
          `forbid (principal == NobleCloak::User::"u", ${ACTION}, resource);`
        ),
      ].join('\n')
    );
    expect(result.unsupported).toEqual([]);
    expect(result.conflicts.map((entry) => entry.path)).toEqual(['/policies/0', '/policies/1']);
  });

  it('an invalid policy (a duplicated subject) is reported on every one of its statements', async () => {
    const one = statement({ noblecloak_policy: 'p', noblecloak_mode: 'deny' }, `forbid ${ORG_ALL}`);
    const result = await run(`${one}\n${one}`);
    expect(result.unsupported.map((entry) => entry.path)).toEqual(['/policies/0', '/policies/1']);
  });
});

describe('importCedar: baseline, comments, origin, errors', () => {
  it('reads the baseline statement back as options.baseline', async () => {
    const { text } = exportCedar([], { baseline: 'allow' });
    const result = await run(text);
    expect(result.options).toEqual({ baseline: 'allow' });
    expect(result.policies).toEqual([]);
  });

  it('a baseline marker on anything but an unconditional permit for everyone is unsupported', async () => {
    const result = await run(
      [
        statement({ noblecloak_baseline: 'allow' }, `forbid ${ORG_ALL}`),
        statement({ noblecloak_baseline: 'deny' }, `permit ${ORG_ALL}`),
        statement({ noblecloak_baseline: 'allow', noblecloak_mode: 'ask' }, `permit ${ORG_ALL}`),
        statement(
          { noblecloak_baseline: 'allow' },
          `permit (principal, ${ACTION}, resource) when { true };`
        ),
      ].join('\n')
    );
    expect(result.options).toEqual({});
    expect(result.unsupported).toHaveLength(4);
  });

  it('notes that comments are not kept, except for the comment block this package writes', async () => {
    const policy: ExportablePolicy = {
      id: 'p',
      kind: 'tool_invocation',
      subjects: [{ type: 'organization' }],
      targets: { tools: ['a//b'] },
      config: { mode: 'ask' },
    };
    const { text } = exportCedar([policy]);
    expect((await run(text)).notes).toEqual([]);
    expect((await run(`${text}// a reviewer's note\n`)).notes).toEqual([
      'Comments and formatting are not kept: an export writes its own layout and comment block.',
    ]);
    expect((await run(`// hand-written\n${text}`)).notes).toHaveLength(1);
    // A comment added directly under the block, with no blank line between, is still noticed.
    const [block = '', ...rest] = text.split('\n\n');
    expect(
      (await run(`${block}\n// TODO: do not ship until legal signs off\n\n${rest.join('\n\n')}`))
        .notes
    ).toHaveLength(1);
  });

  it('notes a file that holds no statement', async () => {
    const empty = 'The policy set holds no statement, so there is nothing to import.';
    expect((await run('')).notes).toEqual([empty]);
    expect((await run(exportCedar([]).text)).notes).toEqual([empty]);
    expect((await run('// only a comment\n')).notes).toEqual([
      empty,
      expect.stringContaining('Comments'),
    ]);
  });

  it('an unpaired surrogate in the text is a parse error, and the digest of BOM-prefixed text is of its UTF-8 bytes', async () => {
    await expect(
      run('@noblecloak_name("x\uD800")\nforbid (principal, action, resource);')
    ).rejects.toMatchObject({
      code: 'parse_error',
    });
    const text = `\ufeff${exportCedar([]).text}`;
    expect((await run(text)).origin.digest).toBe(
      createHash('sha256').update(text, 'utf8').digest('hex')
    );
  });

  it('origin is the lowercase hex SHA-256 of the file bytes, as given', async () => {
    const { text } = exportCedar([]);
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    expect((await run(text)).origin).toEqual({ format: 'cedar', digest: expected });
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    const fromBytes = await importCedar(bytes, { cedar });
    expect(fromBytes.origin.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await run(`\ufeff${text}`)).policies).toEqual([]);
  });

  it('throws parse_error for text that is not Cedar, and for bytes that are not UTF-8', async () => {
    await expect(run('permit (principal, action, resource) garbage')).rejects.toMatchObject({
      name: 'PolicyFormatError',
      code: 'parse_error',
    });
    await expect(importCedar(new Uint8Array([0xff, 0xfe, 0x00]), { cedar })).rejects.toMatchObject({
      code: 'parse_error',
    });
  });

  it('throws parse_error when a statement does not convert to JSON', async () => {
    const broken = {
      policySetTextToParts: () => ({
        type: 'success' as const,
        policies: ['x'],
        policy_templates: [],
      }),
      policyToJson: () => ({ type: 'failure' as const, errors: [{ message: 'boom' }] }),
    };
    await expect(importCedar('x', { cedar: broken })).rejects.toBeInstanceOf(PolicyFormatError);
  });

  it('takes the parser as a loader function', async () => {
    const result = await importCedar(exportCedar([]).text, { cedar: () => Promise.resolve(cedar) });
    expect(result.policies).toEqual([]);
  });

  it('loads @cedar-policy/cedar-wasm by itself when no parser is given', async () => {
    const policy: ExportablePolicy = {
      id: 'p',
      kind: 'tool_invocation',
      subjects: [{ type: 'organization' }],
      config: { mode: 'deny' },
    };
    const result = await importCedar(exportCedar([policy]).text);
    expect(result.policies.map((imported) => canonicalPolicy(imported.write))).toEqual([
      canonicalPolicy(policy),
    ]);
  });

  it("AGT's approval.cedar, read as Cedar, imports nothing and reports every statement with a path", async () => {
    for (const pin of ['agt-v5.0.0', 'agt-main']) {
      const result = await run(fixture(`upstream/${pin}/approval.cedar`));
      expect(result.policies).toEqual([]);
      expect(result.unsupported.map((entry) => entry.path)).toEqual([
        '/policies/0/conditions/0',
        '/policies/1/conditions/0',
      ]);
      expect(result.notes).toHaveLength(1);
    }
  });
});
