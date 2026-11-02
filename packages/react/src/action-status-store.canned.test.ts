import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActionStatusStore } from './action-status-store.js';
import type { ActionStatusState, UseActionStatusOptions } from './action-status-types.js';
import { untilStatus } from './testing/action-status-harness.js';
import {
  cannedApproval,
  eventFrame,
  jsonResponse,
  problemResponse,
} from './testing/approvals-harness.js';
import { canned } from './testing/canned-api.js';
import type { Canned } from './testing/canned-api.js';

// The status of one approval against a canned API, for the replies the mock cannot produce: a user creator
// that is told who it waits on, a service that omits `waiting_on` or `on_deny`, `halt`, an expiry, a failed
// read, and a stream or list that missed a change.

const ID = 'apr_1';
const RECORD = 'rec_1';
const when = '2026-10-05T01:02:03.000Z';

let closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers) close();
  closers = [];
  vi.restoreAllMocks();
});

function statusOf(api: Canned, extra: Partial<UseActionStatusOptions> = {}) {
  const store = createActionStatusStore(ID, {
    baseUrl: 'https://canned.test',
    getToken: () => 'tok',
    fetch: api.fetch,
    reconcileMs: 600_000,
    ...extra,
  });
  const unsubscribe = store.subscribe(() => undefined);
  closers.push(() => {
    unsubscribe();
    store.dispose();
  });
  return store;
}

const readOf =
  (approval: () => Record<string, unknown>, record?: () => Response) =>
  (id: string): Response =>
    id === RECORD && record !== undefined ? record() : jsonResponse({ data: approval() });

const ready = (s: ActionStatusState): Extract<ActionStatusState, { status: 'ready' }> => {
  if (s.status !== 'ready') throw new Error(`not ready: ${s.status}`);
  return s;
};

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('who a pending approval waits on', () => {
  it('names the eligible approvers to a user creator, with the count', async () => {
    const api = canned();
    const principals = [
      { id: 'user_a', kind: 'user', display_name: 'Ann' },
      { id: 'user_b', kind: 'user' },
    ];
    api.read = readOf(() => cannedApproval(ID, { waiting_on: { count: 7, principals } }));
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect(s.pendingOn).toEqual({ kind: 'principals', count: 7, principals });
  });

  it('gives a count and no names when the service gave only a count, zero included', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID, { waiting_on: { count: 0 } }));
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect(s.pendingOn).toEqual({ kind: 'count', count: 0 });
  });

  it('says unknown, not nothing, when waiting_on is absent', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID));
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect(s.pendingOn).toEqual({ kind: 'unknown' });
  });

  it('holds no waiting-on for an approval that is not pending, even if the service sent one', async () => {
    const api = canned();
    api.read = readOf(() =>
      cannedApproval(ID, { state: 'approved', waiting_on: { count: 3 }, resolved_at: when })
    );
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect(s.pendingOn).toBeUndefined();
  });
});

describe('what happens on deny', () => {
  it.each([
    ['resume', 'resume'],
    ['halt', 'halt'],
    [undefined, 'not_stated'],
    ['abort', 'not_stated'],
    [null, 'not_stated'],
  ])('on_deny %s is %s', async (given, expected) => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID, given === undefined ? {} : { on_deny: given }));
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect(s.onDeny).toBe(expected);
  });
});

describe('states', () => {
  it('shows expired from the read, settled, with the time it was created', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID, { state: 'expired', resolved_at: when }));
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect([s.state, s.settled, s.since]).toEqual(['expired', true, '2026-10-05T00:00:00.000Z']);
  });

  it('takes the new state from a stream event for this approval, without reading it again', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID, { waiting_on: { count: 2 } }));
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'ready');
    await settle(50);
    const reads = api.calls.filter((c) => c === `GET /v1/approvals/${ID}`).length;
    api.stream.push(eventFrame(cannedApproval(ID, { state: 'expired', resolved_at: when })));
    const s = ready(await untilStatus(store, (x) => x.status === 'ready' && x.state === 'expired'));
    expect(s.settled).toBe(true);
    expect(api.calls.filter((c) => c === `GET /v1/approvals/${ID}`).length).toBe(reads);
  });

  it('keeps the content and says it is refreshing while a pending approval is read again', async () => {
    const api = canned();
    let release: (() => void) | undefined;
    let reads = 0;
    api.read = (id) => {
      reads += 1;
      const body = jsonResponse({ data: cannedApproval(id, { waiting_on: { count: reads } }) });
      if (reads === 1) return body;
      return new Promise<Response>((resolve) => {
        release = () => {
          resolve(body);
        };
      });
    };
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'ready');
    await settle(50);
    api.stream.push(eventFrame(cannedApproval(ID)));
    const refreshing = ready(await untilStatus(store, (x) => x.status === 'ready' && x.refreshing));
    expect(refreshing.pendingOn).toEqual({ kind: 'count', count: 1 });
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    const after = ready(await untilStatus(store, (x) => x.status === 'ready' && !x.refreshing));
    expect(after.pendingOn).toEqual({ kind: 'count', count: 2 });
  });
});

describe('failures', () => {
  it('is not_found for a gone approval', async () => {
    const api = canned();
    api.read = () => problemResponse(404, 'not_found');
    const s = await untilStatus(statusOf(api), (x) => x.status !== 'loading');
    expect(s).toEqual({ approvalId: ID, status: 'not_found' });
  });

  it('reads a not_found approval afresh on retry(), and shows it once it is visible', async () => {
    const api = canned();
    let visible = false;
    api.read = (id) =>
      visible ? jsonResponse({ data: cannedApproval(id) }) : problemResponse(404, 'not_found');
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'not_found');
    visible = true;
    store.retry();
    expect(ready(await untilStatus(store, (x) => x.status === 'ready')).state).toBe('pending');
  });

  it('is forbidden on a 403, and reads again on retry', async () => {
    const api = canned();
    let allow = false;
    api.read = (id) =>
      allow ? jsonResponse({ data: cannedApproval(id) }) : problemResponse(403, 'forbidden');
    const store = statusOf(api);
    const failed = await untilStatus(store, (x) => x.status === 'forbidden');
    expect(failed).toMatchObject({ error: { kind: 'forbidden', status: 403 } });
    allow = true;
    store.retry();
    expect(ready(await untilStatus(store, (x) => x.status === 'ready')).state).toBe('pending');
  });

  it('is unauthorized when the session is over, and tells the host', async () => {
    const api = canned();
    api.read = () => problemResponse(401, 'unauthorized');
    const onSessionExpired = vi.fn();
    const s = await untilStatus(
      statusOf(api, { onSessionExpired }),
      (x) => x.status === 'unauthorized'
    );
    expect(s).toMatchObject({ error: { kind: 'unauthorized' } });
    expect(onSessionExpired).toHaveBeenCalled();
  });

  it('is unavailable on a 503, and recovers by itself', async () => {
    const api = canned();
    let failures = 1;
    api.read = (id) =>
      failures-- > 0 ? problemResponse(503, 'down') : jsonResponse({ data: cannedApproval(id) });
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'unavailable');
    expect((await untilStatus(store, (x) => x.status === 'ready', 8000)).status).toBe('ready');
  });

  it('is an error, not an empty status, for a reply that is not an approval', async () => {
    const api = canned();
    api.read = () => jsonResponse({ data: { id: ID } });
    const s = await untilStatus(statusOf(api), (x) => x.status === 'error');
    expect(s).toMatchObject({ error: { kind: 'malformed_response' } });
  });

  it('is an error for the reply to another approval', async () => {
    const api = canned();
    api.read = () => jsonResponse({ data: cannedApproval('apr_other') });
    const s = await untilStatus(statusOf(api), (x) => x.status === 'error');
    expect(s).toMatchObject({ error: { kind: 'malformed_response' } });
  });
});

describe('a change the stream did not deliver', () => {
  it('reads a pending approval again when a complete pending list no longer holds it', async () => {
    const api = canned([]);
    let reads = 0;
    api.read = (id) => {
      reads += 1;
      return jsonResponse({
        data: cannedApproval(id, reads === 1 ? {} : { state: 'rejected', resolved_at: when }),
      });
    };
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'ready' && x.state === 'pending');
    await settle(50);
    // A change to some other approval makes a list read; this one is not in it, so it was decided meanwhile.
    api.stream.push(eventFrame(cannedApproval('apr_other')));
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.state === 'rejected', 8000)
    );
    expect(s.settled).toBe(true);
  }, 15_000);

  /** The canned API with a pending list that has a next page, so it says nothing about what it leaves out. */
  const truncated = (api: Canned): { readonly fetch: typeof fetch } => ({
    fetch: (input, init) =>
      new URL(new Request(input, init).url).pathname === '/v1/approvals'
        ? Promise.resolve(jsonResponse({ data: [], meta: { next: 'cursor_1' } }))
        : api.fetch(input, init),
  });

  it('reads a pending approval again when the list has a next page and does not hold it: the row may be beyond the page, and a decision the stream missed must still be seen', async () => {
    const api = canned([]);
    let reads = 0;
    api.read = readOf(() => {
      reads += 1;
      return cannedApproval(ID, reads === 1 ? {} : { state: 'rejected', resolved_at: when });
    });
    const store = statusOf(api, { fetch: truncated(api).fetch });
    await untilStatus(store, (x) => x.status === 'ready' && x.state === 'pending');
    await settle(50);
    api.stream.push(eventFrame(cannedApproval('apr_other')));
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.state === 'rejected', 8000)
    );
    expect(s.settled).toBe(true);
  }, 15_000);

  it('sees a decision while polling with the stream down, when the pending list is partial', async () => {
    const api = canned([]);
    let reads = 0;
    api.read = readOf(() => {
      reads += 1;
      return cannedApproval(ID, reads === 1 ? {} : { state: 'rejected', resolved_at: when });
    });
    const down: typeof fetch = (input, init) =>
      new URL(new Request(input, init).url).pathname === '/v1/approvals/stream'
        ? Promise.resolve(problemResponse(503, 'unavailable'))
        : truncated(api).fetch(input, init);
    const store = statusOf(api, { fetch: down, pollMs: 1000 });
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.state === 'rejected', 12_000)
    );
    expect(s.settled).toBe(true);
  }, 20_000);

  it('reads an approved approval again whatever the list holds, since a pending list never shows it', async () => {
    const api = canned([]);
    let reads = 0;
    api.read = (id) => {
      reads += 1;
      return jsonResponse({
        data: cannedApproval(id, {
          state: reads === 1 ? 'approved' : 'rejected',
          resolved_at: when,
        }),
      });
    };
    const store = statusOf(api, { fetch: truncated(api).fetch });
    await untilStatus(store, (x) => x.status === 'ready' && x.state === 'approved');
    await settle(50);
    api.stream.push(eventFrame(cannedApproval('apr_other')));
    await untilStatus(store, (x) => x.status === 'ready' && x.state === 'rejected', 8000);
  }, 15_000);

  it('does not read a pending approval again while the list still holds it', async () => {
    const api = canned([ID]);
    api.read = readOf(() => cannedApproval(ID));
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'ready');
    api.stream.push(eventFrame(cannedApproval('apr_other')));
    await settle(1800);
    expect(api.calls.filter((c) => c === `GET /v1/approvals/${ID}`).length).toBe(1);
  });

  it('finds that an approved approval was consumed, and reads its outcome record', async () => {
    const api = canned([]);
    let reads = 0;
    api.read = (id) => {
      if (id === RECORD) {
        return jsonResponse({
          data: { id: RECORD, ts: when, approval_id: ID, outcome: { status: 'succeeded' } },
        });
      }
      reads += 1;
      return jsonResponse({
        data: cannedApproval(
          ID,
          reads === 1
            ? { state: 'approved', resolved_at: when }
            : { state: 'consumed', resolved_at: when, outcome_record_id: RECORD }
        ),
      });
    };
    const store = statusOf(api);
    const approved = ready(await untilStatus(store, (x) => x.status === 'ready'));
    expect([approved.state, approved.settled]).toEqual(['approved', false]);
    await settle(50);
    api.stream.push(eventFrame(cannedApproval('apr_other')));
    const s = ready(
      await untilStatus(
        store,
        (x) => x.status === 'ready' && x.outcome?.status === 'recorded',
        8000
      )
    );
    expect(s.outcome).toEqual({
      status: 'recorded',
      recordId: RECORD,
      result: 'succeeded',
      recordedAt: when,
    });
    expect(s.settled).toBe(true);
  }, 15_000);
});

describe('the outcome record', () => {
  const consumed = (extra: Record<string, unknown> = {}) =>
    cannedApproval(ID, {
      state: 'consumed',
      resolved_at: when,
      outcome_record_id: RECORD,
      ...extra,
    });

  it('reads a record that states no outcome as unavailable (no_outcome), not as a stated result', async () => {
    const api = canned();
    api.read = readOf(consumed, () => jsonResponse({ data: { id: RECORD, ts: when } }));
    const s = ready(
      await untilStatus(
        statusOf(api),
        (x) => x.status === 'ready' && x.outcome?.status === 'unavailable'
      )
    );
    expect(s.outcome).toEqual({ status: 'unavailable', reason: 'no_outcome', recordId: RECORD });
    expect(s.settled).toBe(true);
  });

  it('keeps an explicit outcome status "unknown" as a stated result', async () => {
    const api = canned();
    api.read = readOf(consumed, () =>
      jsonResponse({ data: { id: RECORD, ts: when, outcome: { status: 'unknown' } } })
    );
    const s = ready(
      await untilStatus(
        statusOf(api),
        (x) => x.status === 'ready' && x.outcome?.status === 'recorded'
      )
    );
    expect(s.outcome).toMatchObject({ status: 'recorded', result: 'unknown' });
  });

  it('shows the outcome as loading while a retried read is under way', async () => {
    const api = canned();
    let reply: ((r: Response) => void) | undefined;
    let reads = 0;
    const held = new Promise<Response>((resolve) => {
      reply = resolve;
    });
    const base = readOf(consumed, () => {
      reads += 1;
      return problemResponse(500, 'internal');
    });
    api.read = base;
    const store = statusOf({
      ...api,
      fetch: (input, init) =>
        new URL(new Request(input, init).url).pathname === `/v1/records/${RECORD}` && reads > 0
          ? held
          : api.fetch(input, init),
    });
    await untilStatus(
      store,
      (x) =>
        x.status === 'ready' &&
        x.outcome?.status === 'unavailable' &&
        x.outcome.reason === 'unavailable'
    );
    store.retry();
    expect(ready(store.getSnapshot()).outcome).toEqual({ status: 'loading', recordId: RECORD });
    reply?.(jsonResponse({ data: { id: RECORD, ts: when, outcome: { status: 'succeeded' } } }));
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'recorded')
    );
    expect(s.outcome).toMatchObject({ result: 'succeeded' });
  });

  // A reply that is not a record for this approval that this version can read: a retry reads the same record and
  // cannot change it, so it is `malformed`, settled, with no re-read, and reported through onFault.
  it.each([
    [
      'an outcome status this version does not know',
      { id: RECORD, ts: when, outcome: { status: 'exploded' } },
    ],
    ['a record that names another approval', { id: RECORD, ts: when, approval_id: 'apr_other' }],
    ['another record', { id: 'rec_other', ts: when, outcome: { status: 'succeeded' } }],
  ])('is malformed for %s, reported, and not read again on retry', async (_what, body) => {
    const api = canned();
    api.read = readOf(consumed, () => jsonResponse({ data: body }));
    const onFault = vi.fn();
    const store = statusOf(api, { onFault });
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'unavailable')
    );
    expect(s.outcome).toEqual({
      status: 'unavailable',
      reason: 'malformed',
      recordId: RECORD,
      error: expect.objectContaining({ kind: 'malformed_response', status: 200 }) as unknown,
    });
    expect(s.settled).toBe(true);
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: 'malformed_response' }));
    const reads = api.calls.filter((c) => c === `GET /v1/records/${RECORD}`).length;
    store.retry();
    await settle(50);
    expect(api.calls.filter((c) => c === `GET /v1/records/${RECORD}`).length).toBe(reads);
  });

  it('carries the failed read, with its request id, on an outcome that could not be read', async () => {
    const api = canned();
    api.read = readOf(consumed, () => problemResponse(503, 'unavailable'));
    const s = ready(
      await untilStatus(
        statusOf(api),
        (x) => x.status === 'ready' && x.outcome?.status === 'unavailable'
      )
    );
    expect(s.outcome).toMatchObject({
      reason: 'unavailable',
      error: { kind: 'unavailable', requestId: 'req_t' },
    });
  });

  it('is unauthorized, and tells the host, when the session ends before the record is read', async () => {
    const api = canned();
    api.read = readOf(consumed, () => problemResponse(401, 'unauthorized'));
    const onSessionExpired = vi.fn();
    const s = ready(
      await untilStatus(
        statusOf(api, { onSessionExpired }),
        (x) => x.status === 'ready' && x.outcome?.status === 'unavailable'
      )
    );
    expect(s.outcome).toMatchObject({ reason: 'unauthorized' });
    expect(onSessionExpired).toHaveBeenCalled();
  });

  it('shows the outcome as loading until the record answers', async () => {
    const api = canned();
    let release: (() => void) | undefined;
    api.read = (id) =>
      id === RECORD
        ? new Promise<Response>((resolve) => {
            release = () => {
              resolve(
                jsonResponse({ data: { id: RECORD, ts: when, outcome: { status: 'failed' } } })
              );
            };
          })
        : jsonResponse({ data: consumed() });
    const store = statusOf(api);
    const loading = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'loading')
    );
    expect(loading.outcome).toEqual({ status: 'loading', recordId: RECORD });
    expect(loading.settled).toBe(false);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    const done = ready(await untilStatus(store, (x) => x.status === 'ready' && x.settled));
    expect(done.outcome).toMatchObject({ result: 'failed' });
  });

  it('shows no outcome for an approval that is not consumed', async () => {
    const api = canned();
    api.read = readOf(() =>
      cannedApproval(ID, { state: 'rejected', resolved_at: when, outcome_record_id: RECORD })
    );
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready'));
    expect(s.outcome).toBeUndefined();
    expect(api.calls).not.toContain(`GET /v1/records/${RECORD}`);
  });
});

describe('lifecycle', () => {
  it('reads nothing while disabled', async () => {
    const api = canned();
    const store = statusOf(api, { enabled: false });
    await settle(100);
    expect(store.getSnapshot()).toEqual({ approvalId: ID, status: 'loading' });
    expect(api.calls).toEqual([]);
  });

  it('is loading on a server render', () => {
    const store = createActionStatusStore(ID, { baseUrl: 'https://x.test', getToken: () => 't' });
    expect(store.getServerSnapshot()).toEqual({ approvalId: ID, status: 'loading' });
  });

  it('starts again after the last unsubscribe (a StrictMode re-mount) and stops for good once disposed', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID));
    const store = createActionStatusStore(ID, {
      baseUrl: 'https://canned.test',
      getToken: () => 'tok',
      fetch: api.fetch,
      reconcileMs: 600_000,
    });
    const first = store.subscribe(() => undefined);
    await untilStatus(store, (x) => x.status === 'ready');
    first();
    expect(store.getSnapshot().status).toBe('loading');
    const second = store.subscribe(() => undefined);
    await untilStatus(store, (x) => x.status === 'ready');
    second();
    store.dispose();
    const calls = api.calls.length;
    store.subscribe(() => undefined)();
    expect(api.calls.length).toBe(calls);
  });

  it('keeps going when a listener throws, and reports it', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID));
    const onFault = vi.fn();
    const store = createActionStatusStore(ID, {
      baseUrl: 'https://canned.test',
      getToken: () => 'tok',
      fetch: api.fetch,
      reconcileMs: 600_000,
      onFault,
    });
    closers.push(
      store.subscribe(() => {
        throw new Error('listener');
      })
    );
    closers.push(() => {
      store.dispose();
    });
    await vi.waitFor(() => {
      expect(onFault).toHaveBeenCalled();
    });
    expect(store.getSnapshot().status === 'loading' || store.getSnapshot().status === 'ready').toBe(
      true
    );
  });
});

describe('a fault handler that throws', () => {
  it('does not lose the fault: it is reported with reportError', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID));
    const reported: unknown[] = [];
    vi.stubGlobal('reportError', (fault: unknown) => reported.push(fault));
    try {
      const store = statusOf(api, {
        onFault: () => {
          throw new Error('handler failed');
        },
      });
      const boom = new Error('listener failed');
      closers.push(
        store.subscribe(() => {
          throw boom;
        })
      );
      await vi.waitFor(() => {
        expect(reported).toContain(boom);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the capabilities gate', () => {
  // A deployment that requires DPoP refuses every bearer request (401), and one that advertises no resolutions
  // serves no approvals family (404). A creator reads over bearer tokens and the approvals routes, so neither can
  // work: the status says the deployment does not serve it, not "sign in again" and not "gone".
  const unsupported = async (
    capabilities: Record<string, unknown>,
    others: () => Response
  ): Promise<{ s: ActionStatusState; api: Canned; onSessionExpired: ReturnType<typeof vi.fn> }> => {
    const api = canned();
    const onSessionExpired = vi.fn();
    const fetchWith: typeof fetch = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === '/v1/capabilities') {
        api.calls.push(`GET ${path}`);
        return Promise.resolve(jsonResponse({ data: capabilities }));
      }
      api.calls.push(`${new Request(input, init).method} ${path}`);
      return Promise.resolve(others());
    };
    const s = await untilStatus(
      statusOf(api, { fetch: fetchWith, onSessionExpired }),
      (x) => x.status === 'error'
    );
    return { s, api, onSessionExpired };
  };

  it('is unsupported, not a lost session, when DPoP is required and bearer requests get 401', async () => {
    const { s, api, onSessionExpired } = await unsupported(
      { resolutions: ['approved'], dpop: 'required' },
      () => problemResponse(401, 'unauthorized')
    );
    expect(s).toMatchObject({ status: 'error', error: { kind: 'unsupported' } });
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(api.calls).not.toContain('GET /v1/approvals/stream');
  });

  it('is unsupported, not gone, when no resolutions are advertised and the approvals routes are 404', async () => {
    const { s, api } = await unsupported({ resolutions: [], dpop: 'off' }, () =>
      problemResponse(404, 'not_found')
    );
    expect(s).toMatchObject({ status: 'error', error: { kind: 'unsupported' } });
    expect(api.calls).not.toContain('GET /v1/approvals/stream');
  });
});

describe('a session that ends after the detail was read', () => {
  it('shows unauthorized, and reads again after a new session', async () => {
    const api = canned([]);
    let state: 'pending' | 'rejected' = 'pending';
    api.read = readOf(() =>
      cannedApproval(ID, state === 'pending' ? {} : { state, resolved_at: when })
    );
    let dead = false;
    const onSessionExpired = vi.fn();
    const gated: typeof fetch = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      return dead && path === '/v1/approvals'
        ? Promise.resolve(problemResponse(401, 'unauthorized'))
        : api.fetch(input, init);
    };
    const store = statusOf(api, { fetch: gated, onSessionExpired });
    await untilStatus(store, (x) => x.status === 'ready' && x.state === 'pending');
    await settle(50);
    dead = true;
    api.stream.push(eventFrame(cannedApproval('apr_other')));
    await untilStatus(store, (x) => x.status === 'unauthorized', 8000);
    expect(onSessionExpired).toHaveBeenCalled();
    dead = false;
    state = 'rejected';
    store.retry();
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.state === 'rejected', 8000)
    );
    expect(s.settled).toBe(true);
  }, 20_000);
});

describe('live updates that are failing', () => {
  it('says a pending status may be out of date while the stream and the lists fail', async () => {
    const api = canned([ID]);
    api.read = readOf(() => cannedApproval(ID));
    let down = false;
    const failing: typeof fetch = (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      return down && (path === '/v1/approvals/stream' || path === '/v1/approvals')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : api.fetch(input, init);
    };
    const store = statusOf(api, { fetch: failing, pollMs: 1000 });
    const live = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.connection === 'live')
    );
    expect(live.stale).toBe(false);
    down = true;
    api.stream.end();
    const s = ready(await untilStatus(store, (x) => x.status === 'ready' && x.stale, 8000));
    expect([s.state, s.connection, s.settled]).toEqual(['pending', 'polling', false]);
    // retry() starts the live updates again at once: a new capabilities read, and a list that succeeds.
    const capabilities = (): number => api.calls.filter((c) => c === 'GET /v1/capabilities').length;
    const before = capabilities();
    down = false;
    store.retry();
    // The run starts again from its capabilities read; `connecting` is not out of date, so wait past it.
    const back = ready(
      await untilStatus(
        store,
        (x) => x.status === 'ready' && !x.stale && x.connection !== 'connecting',
        8000
      )
    );
    expect(back.state).toBe('pending');
    expect(capabilities()).toBe(before + 1);
  }, 20_000);

  it('is never out of date on a healthy mount, while the stream is still connecting', async () => {
    const api = canned([ID]);
    api.read = readOf(() => cannedApproval(ID));
    // The capabilities read is slow, so the approval is read and shown before the stream is up.
    const slow: typeof fetch = (input, init) =>
      new URL(new Request(input, init).url).pathname === '/v1/capabilities'
        ? settle(40).then(() => api.fetch(input, init))
        : api.fetch(input, init);
    const store = statusOf(api, { fetch: slow });
    const seen: ActionStatusState[] = [];
    const unsubscribe = store.subscribe(() => {
      seen.push(store.getSnapshot());
    });
    closers.push(unsubscribe);
    await untilStatus(store, (x) => x.status === 'ready' && x.connection === 'live');
    await settle(50);
    const views = seen.filter((x) => x.status === 'ready');
    expect(views.some((x) => x.connection === 'connecting')).toBe(true);
    expect(views.filter((x) => x.stale)).toEqual([]);
  });

  it('is not out of date once settled: nothing further can change', async () => {
    const api = canned();
    api.read = readOf(() => cannedApproval(ID, { state: 'rejected', resolved_at: when }));
    const s = ready(await untilStatus(statusOf(api), (x) => x.status === 'ready' && x.settled));
    expect([s.stale, s.connection]).toEqual([false, 'offline']);
  });
});

describe('a fault that ends the live updates', () => {
  it('is an error, not a frozen pending status, and retry() starts the run again', async () => {
    const api = canned([ID]);
    api.read = readOf(() => cannedApproval(ID));
    const onFault = vi.fn();
    const store = statusOf(api, { onFault });
    await untilStatus(store, (x) => x.status === 'ready' && x.connection === 'live');
    const capabilities = (): number => api.calls.filter((c) => c === 'GET /v1/capabilities').length;
    const before = capabilities();
    // The next thing the run does with the clock, once the stream ends, fails: a bug in the run, which ends it.
    const boom = new Error('clock bug');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw boom;
    });
    api.stream.end();
    const failed = await untilStatus(store, (x) => x.status === 'error');
    clock.mockRestore();
    expect(failed).toMatchObject({
      status: 'error',
      error: { kind: 'malformed_response', code: 'internal_error' },
    });
    expect(onFault).toHaveBeenCalledWith(boom);
    store.retry();
    const s = ready(await untilStatus(store, (x) => x.status === 'ready'));
    expect(s.state).toBe('pending');
    await vi.waitFor(() => {
      expect(capabilities()).toBe(before + 1);
    });
  });
});

describe('a status nothing further can change', () => {
  /** The stream answers 503, so the store polls the list every `pollMs`: a store that keeps running keeps asking. */
  const streamDown =
    (api: Canned): typeof fetch =>
    (input, init) =>
      new URL(new Request(input, init).url).pathname === '/v1/approvals/stream'
        ? Promise.resolve(problemResponse(503, 'unavailable'))
        : api.fetch(input, init);

  it.each([
    ['a gone approval', () => problemResponse(404, 'not_found'), 'not_found'],
    ['a reply that is not an approval', () => jsonResponse({ data: { id: ID } }), 'error'],
  ] as const)(
    'stops the stream and the polls for %s',
    async (_what, reply, status) => {
      const api = canned([]);
      api.read = reply;
      const store = statusOf(api, { fetch: streamDown(api), pollMs: 1000 });
      await untilStatus(store, (x) => x.status === status);
      await settle(100);
      const calls = api.calls.length;
      await settle(2500);
      expect(api.calls.slice(calls)).toEqual([]);
    },
    10_000
  );

  it('reads again on retry() after it stopped for a reply that is not an approval', async () => {
    const api = canned([]);
    let good = false;
    api.read = (id) => jsonResponse({ data: good ? cannedApproval(id) : { id } });
    const store = statusOf(api);
    await untilStatus(store, (x) => x.status === 'error');
    good = true;
    store.retry();
    expect(ready(await untilStatus(store, (x) => x.status === 'ready')).state).toBe('pending');
  });
});

describe('a failure that cannot be serialized', () => {
  it('keeps publishing when the record read fails with a self-referencing cause, and retry() recovers', async () => {
    const api = canned();
    api.read = readOf(
      () => cannedApproval(ID, { state: 'consumed', resolved_at: when, outcome_record_id: RECORD }),
      () => jsonResponse({ data: { id: RECORD, ts: when, outcome: { status: 'succeeded' } } })
    );
    // A host fetch that throws something that is not a failed fetch: the error holds it as its cause.
    const loop = new Error('a cause that names itself') as Error & { self?: unknown };
    loop.self = loop;
    let throws = true;
    const fetchWith: typeof fetch = (input, init) =>
      throws && new URL(new Request(input, init).url).pathname === `/v1/records/${RECORD}`
        ? Promise.reject(loop)
        : api.fetch(input, init);
    const onFault = vi.fn();
    const store = statusOf(api, { fetch: fetchWith, onFault });
    const failed = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'unavailable')
    );
    expect(failed.outcome).toMatchObject({
      reason: 'unavailable',
      error: { kind: 'network', code: 'client_error' },
    });
    expect(onFault).toHaveBeenCalledWith(loop);
    throws = false;
    store.retry();
    const s = ready(
      await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'recorded')
    );
    expect(s.outcome).toMatchObject({ result: 'succeeded' });
  });
});

describe('an outcome record read that failed in transit', () => {
  // Only a 200 that parsed but is not this approval's record is `malformed` (the same record gives the same
  // answer). A reply that is not the service's (a proxy's HTML page, a plain-text 404, a timeout) is not the
  // record's answer, so it keeps the reason the status gives and is read again on retry.
  const consumed = () =>
    cannedApproval(ID, { state: 'consumed', resolved_at: when, outcome_record_id: RECORD });
  const text = (status: number, body: string, type = 'text/plain'): Response =>
    new Response(body, { status, headers: { 'content-type': type } });
  const good = () =>
    jsonResponse({ data: { id: RECORD, ts: when, outcome: { status: 'succeeded' } } });

  it.each([
    [
      'a 200 that is an HTML page',
      'unavailable',
      () => text(200, '<html>sign in</html>', 'text/html'),
    ],
    ['a 403 that is not a problem document', 'forbidden', () => text(403, 'Forbidden')],
    ['a 404 that is not a problem document', 'not_found', () => text(404, 'Not Found')],
    ['a 408 that is not a problem document', 'unavailable', () => text(408, 'Request Timeout')],
    ['a 408 problem', 'unavailable', () => problemResponse(408, 'request_timeout')],
    ['a 425', 'unavailable', () => text(425, 'Too Early')],
    ['a 400 invalid_request', 'unavailable', () => problemResponse(400, 'invalid_request')],
  ] as const)(
    '%s is %s, not malformed, and retry() reads it again',
    async (_what, reason, first) => {
      const api = canned();
      let replies = 0;
      api.read = readOf(consumed, () => (replies++ === 0 ? first() : good()));
      const onFault = vi.fn();
      const store = statusOf(api, { onFault });
      const failed = ready(
        await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'unavailable')
      );
      expect(failed.outcome).toMatchObject({ status: 'unavailable', reason, recordId: RECORD });
      expect(onFault).not.toHaveBeenCalled();
      store.retry();
      const s = ready(
        await untilStatus(store, (x) => x.status === 'ready' && x.outcome?.status === 'recorded')
      );
      expect(s.outcome).toMatchObject({ result: 'succeeded' });
    }
  );
});
