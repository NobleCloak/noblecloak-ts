import { describe, expect, it } from 'vitest';

import { APPROVAL_ID, DIGEST, MESSAGE_ID } from './fixtures.test-support.js';
import { parseActionPayload, parseExecuteData } from './payload.js';

const payload = {
  v: 1,
  approval_id: APPROVAL_ID,
  sent_message_id: MESSAGE_ID,
  expected_action_digest: DIGEST,
};

describe('parseExecuteData: the data of a Teams Action.Execute click', () => {
  it('refuses the merged shape as a payload, which is why it exists', () => {
    expect(parseActionPayload({ ...payload, reason: 'ok' })).toBeUndefined();
  });

  it('splits a click with a note into the payload and the input', () => {
    expect(parseExecuteData({ ...payload, reason: 'looks fine' })).toEqual({
      payload,
      inputs: { reason: 'looks fine' },
    });
  });

  it('reads a click without a note: the payload alone and no inputs', () => {
    expect(parseExecuteData({ ...payload })).toEqual({ payload, inputs: {} });
    expect(parseExecuteData({ ...payload, reason: '' })).toEqual({
      payload,
      inputs: { reason: '' },
    });
  });

  it('keeps an own key named __proto__ from changing the inputs object', () => {
    const data = JSON.parse(
      `{"v":1,"approval_id":"${APPROVAL_ID}","sent_message_id":"${MESSAGE_ID}","expected_action_digest":"${DIGEST}","__proto__":"x","reason":"r"}`
    ) as unknown;
    const read = parseExecuteData(data);
    expect(read?.inputs).toEqual({ reason: 'r' });
    expect(Object.getPrototypeOf(read?.inputs)).toBe(Object.prototype);
    expect(Object.keys(read?.inputs ?? {})).toEqual(['reason']);
  });

  it('keeps no payload key in the inputs', () => {
    const read = parseExecuteData({ ...payload, reason: 'r' });
    expect(Object.keys(read?.inputs ?? {})).toEqual(['reason']);
  });

  it('leaves out an input whose value is not a string', () => {
    expect(
      parseExecuteData({ ...payload, reason: 'r', n: 5, o: { a: 1 }, list: ['x'], no: null })
    ).toEqual({ payload, inputs: { reason: 'r' } });
  });

  it.each([
    [
      'a payload key replaced by an input of the same name',
      { ...payload, approval_id: 'not-a-uuid' },
    ],
    ['a payload key that is missing', { ...payload, approval_id: undefined, reason: 'r' }],
    ['a different version', { ...payload, v: 2 }],
    ['an empty digest', { ...payload, expected_action_digest: '' }],
    ['a digest past the payload bound', { ...payload, expected_action_digest: 'd'.repeat(2000) }],
    ['a null', null],
    ['an array', [payload]],
    ['a string', JSON.stringify(payload)],
    ['undefined', undefined],
  ])('answers undefined on %s', (_name, data) => {
    expect(parseExecuteData(data)).toBeUndefined();
  });

  it('does not throw on a getter that throws, or on a revoked proxy', () => {
    const getter = {
      ...payload,
      get reason(): string {
        throw new Error('boom');
      },
    };
    expect(parseExecuteData(getter)).toBeUndefined();
    const { proxy, revoke } = Proxy.revocable({ ...payload }, {});
    revoke();
    expect(parseExecuteData(proxy)).toBeUndefined();
    const keys = new Proxy(
      { ...payload },
      {
        ownKeys() {
          throw new Error('boom');
        },
      }
    );
    expect(parseExecuteData(keys)).toBeUndefined();
  });
});

describe('parseActionPayload bounds the object path like the string path', () => {
  it('refuses an object whose digest makes the payload longer than 2000 characters', () => {
    expect(
      parseActionPayload({ ...payload, expected_action_digest: 'd'.repeat(2000) })
    ).toBeUndefined();
    expect(parseActionPayload({ ...payload, expected_action_digest: 'd'.repeat(100) })).toEqual({
      ...payload,
      expected_action_digest: 'd'.repeat(100),
    });
  });

  it('answers undefined, not a throw, on a getter that throws', () => {
    const getter = {
      ...payload,
      get approval_id(): string {
        throw new Error('boom');
      },
    };
    expect(parseActionPayload(getter)).toBeUndefined();
  });
});
