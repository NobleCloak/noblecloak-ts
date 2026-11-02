// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { WAITING_KEY, createConnectionsStore, toolRowsOf } from './connections-store.js';
import type {
  ConnectionToolInfo,
  ConnectionsSnapshot,
  ConnectionsStore,
  UseConnectionsOptions,
} from './connections-types.js';
import {
  inProcessFetch,
  jsonResponse,
  problemResponse,
  recorder,
  startHarness,
} from './testing/approvals-harness.js';
import type { Harness, Recorder } from './testing/approvals-harness.js';
import { untilState } from './testing/permissions-harness.js';

/** The origin the mock admits for an authorization's return. */
const RETURN_TO = 'https://module.mock.test/connections';

let unique = 0;
const host = (): string => {
  unique += 1;
  return `https://server-${String(unique)}.example.com/mcp`;
};

interface Live {
  readonly store: ConnectionsStore;
  close(): void;
}

const settled = (store: ConnectionsStore): Promise<ConnectionsSnapshot> =>
  untilState(store, (s) => s.status !== 'loading' && s.status !== 'idle');

describe('on the default service', () => {
  let h: Harness;
  const opened: Live[] = [];
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
    extra: Partial<UseConnectionsOptions> = {}
  ): Live => {
    const store = createConnectionsStore({
      baseUrl: h.baseUrl,
      getToken: () => token,
      fetch: rec?.fetch ?? inProcessFetch(h.mock),
      returnTo: RETURN_TO,
      onNavigate: () => undefined,
      ...extra,
    });
    const unsubscribe = store.subscribe(() => undefined);
    const live = {
      store,
      close: () => {
        unsubscribe();
        store.dispose();
      },
    };
    opened.push(live);
    return live;
  };

  it('reads the capabilities it acts on, and the registrations', async () => {
    const { store } = open(h.tokens.admin);
    const s = await settled(store);
    expect(s.status).toBe('ready');
    expect(s.facts).toEqual({
      served: true,
      oauth: true,
      userLinks: true,
      transports: ['mcp', 'a2a'],
    });
    expect(s.administration).toEqual({ readOnly: false });
  });

  it('registers each kind of authentication, and keeps no credential of an org_shared bearer server', async () => {
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.admin, rec);
    await settled(store);
    const none = await store.create({
      name: 'none',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
    });
    expect(none).toMatchObject({
      ok: true,
      connection: { state: 'connected', authKind: 'none', credentialTier: 'per_user' },
    });
    const bearer = await store.create({
      name: 'bearer',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
      authKind: 'bearer',
      credentialTier: 'org_shared',
      orgCredential: 'secret-org-token',
    });
    expect(bearer).toMatchObject({ ok: true, connection: { credentialTier: 'org_shared' } });
    const oauth = await store.create({
      name: 'oauth',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
      authKind: 'oauth',
      oauth: { scopes: ['read'], issuer: 'https://issuer.example.com', clientId: 'c1' },
      credentialTier: 'org_shared',
    });
    expect(oauth).toMatchObject({ ok: true, connection: { state: 'pending_authorization' } });
    // The organisation credential went to the service in one body, as `org_credential.token`.
    const sent = rec.calls.filter((c) => c.method === 'POST' && c.path === '/v1/connections');
    expect(sent[1]?.body).toMatchObject({ org_credential: { token: 'secret-org-token' } });
    expect(sent[2]?.body).toMatchObject({
      auth: {
        kind: 'oauth',
        scopes: ['read'],
        issuer: 'https://issuer.example.com',
        client_id: 'c1',
      },
    });
    // It is in nothing the store holds.
    expect(
      JSON.stringify(store.getSnapshot(), (_k, v: unknown) => (v instanceof Set ? [...v] : v))
    ).not.toContain('secret-org-token');
    expect(store.getSnapshot().connections.map((c) => c.name)).toEqual(
      expect.arrayContaining(['none', 'bearer', 'oauth'])
    );
  });

  it('answers a second registration of a server with the existing one', async () => {
    const { store } = open(h.tokens.admin);
    await settled(store);
    const url = host();
    const first = await store.create({ name: 'a', url, transport: 'mcp', ownerKind: 'org' });
    const again = await store.create({
      name: 'b',
      url: `${url}/`,
      transport: 'mcp',
      ownerKind: 'org',
    });
    expect(again.ok).toBe(false);
    if (again.ok || !first.ok) throw new Error('unexpected');
    expect(again.error).toMatchObject({
      kind: 'conflict',
      code: 'connection_exists',
      connectionId: first.connection.id,
    });
  });

  it('turns the administrator changes off for its life after a 403, and refuses them without a request', async () => {
    const admin = open(h.tokens.admin);
    await settled(admin.store);
    const made = await admin.store.create({
      name: 'org',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
    });
    if (!made.ok) throw new Error('create failed');
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.member, rec);
    await settled(store);
    const renamed = await store.rename(made.connection.id, 'taken');
    expect(renamed).toMatchObject({ ok: false, error: { kind: 'forbidden' } });
    expect(store.getSnapshot().administration).toEqual({ readOnly: true, reason: 'forbidden' });
    const before = rec.calls.length;
    const removed = await store.remove(made.connection.id);
    expect(removed).toMatchObject({
      ok: false,
      error: { kind: 'precondition', code: 'read_only' },
    });
    expect(rec.calls.length).toBe(before);
  });

  it('lets a principal register and change its own registration after a 403 turned administrator changes off', async () => {
    const admin = open(h.tokens.admin);
    await settled(admin.store);
    const org = await admin.store.create({
      name: 'org',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
    });
    if (!org.ok) throw new Error('create failed');
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.member, rec);
    await settled(store);
    expect(await store.rename(org.connection.id, 'taken')).toMatchObject({
      ok: false,
      error: { kind: 'forbidden' },
    });
    expect(store.getSnapshot().administration).toEqual({ readOnly: true, reason: 'forbidden' });
    const mine = await store.create({
      name: 'mine',
      url: host(),
      transport: 'mcp',
      ownerKind: 'principal',
    });
    if (!mine.ok) throw new Error('create failed');
    expect(await store.rename(mine.connection.id, 'still mine')).toMatchObject({
      ok: true,
      connection: { name: 'still mine' },
    });
    expect(await store.refresh(mine.connection.id)).toMatchObject({ ok: true });
  });

  it("with readOnly from the host, refuses the organisation's changes without a request and leaves a principal its own", async () => {
    const admin = open(h.tokens.admin);
    await settled(admin.store);
    const org = await admin.store.create({
      name: 'org',
      url: host(),
      transport: 'mcp',
      ownerKind: 'org',
    });
    if (!org.ok) throw new Error('create failed');
    const rec = recorder(inProcessFetch(h.mock));
    const { store } = open(h.tokens.member, rec, { readOnly: true });
    const s = await settled(store);
    expect(s.administration).toEqual({ readOnly: true, reason: 'host' });
    const before = rec.calls.length;
    for (const refused of [
      await store.rename(org.connection.id, 'x'),
      await store.refresh(org.connection.id),
      await store.remove(org.connection.id),
    ])
      expect(refused).toMatchObject({ ok: false, error: { code: 'read_only' } });
    expect(rec.calls.length).toBe(before);
    // Registering is the service's to refuse where any principal may register.
    const plain = await store.create({
      name: 'mine',
      url: host(),
      transport: 'mcp',
      ownerKind: 'principal',
    });
    if (!plain.ok) throw new Error('create failed');
    expect(await store.rename(plain.connection.id, 'mine still')).toMatchObject({ ok: true });
    // The organisation credential is an administrator's whoever owns the registration.
    expect(await store.rotateOrgCredential(plain.connection.id, 't')).toMatchObject({
      ok: false,
      error: { code: 'read_only' },
    });
  });

  it('refuses an owner kind the service does not register without a request, and latches nothing', async () => {
    const restricted = await startHarness({
      connectionRegistration: { owner_kinds: ['org'], who: 'any' },
    });
    try {
      const rec = recorder(inProcessFetch(restricted.mock));
      const store = createConnectionsStore({
        baseUrl: restricted.baseUrl,
        getToken: () => restricted.tokens.admin,
        fetch: rec.fetch,
      });
      const stop = store.subscribe(() => undefined);
      await settled(store);
      const org = await store.create({
        name: 'o',
        url: host(),
        transport: 'mcp',
        ownerKind: 'org',
      });
      if (!org.ok) throw new Error('create failed');
      const posts = rec.calls.filter((c) => c.method === 'POST').length;
      expect(
        await store.create({ name: 'p', url: host(), transport: 'mcp', ownerKind: 'principal' })
      ).toMatchObject({ ok: false, error: { code: 'owner_kind_not_offered' } });
      expect(rec.calls.filter((c) => c.method === 'POST').length).toBe(posts);
      expect(store.getSnapshot().administration).toEqual({ readOnly: false });
      expect(await store.rename(org.connection.id, 'still mine to change')).toMatchObject({
        ok: true,
      });
      stop();
      store.dispose();
    } finally {
      await restricted.stop();
    }
  });

  it('where only administrators register, refuses a registration without a request once it knows', async () => {
    const restricted = await startHarness({
      connectionRegistration: { owner_kinds: ['org'], who: 'administrators' },
    });
    try {
      const rec = recorder(inProcessFetch(restricted.mock));
      const store = createConnectionsStore({
        baseUrl: restricted.baseUrl,
        getToken: () => restricted.tokens.member,
        fetch: rec.fetch,
        readOnly: true,
      });
      const stop = store.subscribe(() => undefined);
      await settled(store);
      expect(
        await store.create({ name: 'x', url: host(), transport: 'mcp', ownerKind: 'org' })
      ).toMatchObject({ ok: false, error: { code: 'read_only' } });
      expect(rec.calls.some((c) => c.method === 'POST')).toBe(false);
      stop();
      store.dispose();
    } finally {
      await restricted.stop();
    }
  });

  it('refreshes: registers the tools, reports the counts, reads the registration and its tools again', async () => {
    const { store } = open(h.tokens.admin);
    await settled(store);
    const made = await store.create({ name: 'r', url: host(), transport: 'mcp', ownerKind: 'org' });
    if (!made.ok) throw new Error('create failed');
    const detail = store.detail(made.connection.id);
    const stop = detail.subscribe(() => undefined);
    await untilState(detail, (s) => s.status === 'ready');
    expect(detail.getSnapshot().tools).toEqual([]);
    await detail.discover();
    const discovered = detail.getSnapshot();
    expect(discovered.discovery.tools.length).toBe(2);
    expect(discovered.rows.every((r) => r.standing === 'offered')).toBe(true);
    // Discover registered nothing.
    await detail.reload();
    expect(detail.getSnapshot().tools).toEqual([]);
    const refreshed = await store.refresh(made.connection.id);
    expect(refreshed).toEqual({
      ok: true,
      counts: {
        toolCount: 2,
        added: 2,
        removed: 0,
        reactivated: 0,
        emptyUpstreamSuppressed: false,
      },
    });
    const after = detail.getSnapshot();
    expect(after.tools.map((t) => t.status)).toEqual(['active', 'active']);
    expect(after.tools.every((t) => t.connectionId === made.connection.id)).toBe(true);
    expect(after.rows.every((r) => r.standing === 'registered')).toBe(true);
    // The registration was read again: the service checked it just now.
    expect(
      store.getSnapshot().connections.find((c) => c.id === made.connection.id)?.lastVerifiedAt
    ).toEqual(expect.any(String));
    // Deleting withdraws them; the view reads them again with their standing.
    expect(await store.remove(made.connection.id)).toEqual({ ok: true });
    await untilState(
      detail,
      (s) => s.tools.every((t) => t.status === 'withdrawn') && s.tools.length === 2
    );
    // The last discover still lists them as offered: a withdrawn tool its server offers reads as offered again.
    expect(detail.getSnapshot().rows.every((r) => r.standing === 'offered')).toBe(true);
    expect(store.getSnapshot().connections.some((c) => c.id === made.connection.id)).toBe(false);
    stop();
  });

  describe("the caller's own link", () => {
    it('links a bearer credential with consent, revokes consent, gives it again, and unlinks; the token is in no read', async () => {
      const admin = open(h.tokens.admin);
      await settled(admin.store);
      const made = await admin.store.create({
        name: 'per user',
        url: host(),
        transport: 'mcp',
        ownerKind: 'org',
        authKind: 'bearer',
        credentialTier: 'per_user',
      });
      if (!made.ok) throw new Error('create failed');
      expect(made.connection.myLink).toEqual({ status: 'none', consent: 'none' });
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.member, rec);
      await settled(store);
      const id = made.connection.id;
      const linked = await store.link(id, { consent: true, token: 'member-secret' });
      expect(linked).toMatchObject({
        ok: true,
        connection: { myLink: { status: 'linked', consent: 'given' } },
      });
      expect(rec.calls.at(-1)?.body).toEqual({ consent: true, token: 'member-secret' });
      // The administrator reads its own link, never the member's.
      const adminRead = await admin.store.reload().then(() => admin.store.getSnapshot());
      expect(adminRead.connections.find((c) => c.id === id)?.myLink).toEqual({
        status: 'none',
        consent: 'none',
      });
      expect(await store.revokeConsent(id)).toEqual({ ok: true });
      expect(store.getSnapshot().connections.find((c) => c.id === id)?.myLink).toMatchObject({
        status: 'linked',
        consent: 'revoked',
      });
      // Consent again keeps the stored token: no token is sent.
      const again = await store.link(id, { consent: true });
      expect(again).toMatchObject({ ok: true, connection: { myLink: { consent: 'given' } } });
      expect(rec.calls.at(-1)?.body).toEqual({ consent: true });
      expect(await store.unlink(id)).toEqual({ ok: true });
      expect(store.getSnapshot().connections.find((c) => c.id === id)?.myLink).toEqual({
        status: 'none',
        consent: 'none',
      });
      const replacer = (_k: string, v: unknown): unknown => (v instanceof Set ? [...v] : v);
      expect(JSON.stringify(store.getSnapshot(), replacer)).not.toContain('member-secret');
    });

    it('sends no link without consent, and none to a registration that takes no link', async () => {
      const admin = open(h.tokens.admin);
      await settled(admin.store);
      const shared = await admin.store.create({
        name: 'shared',
        url: host(),
        transport: 'mcp',
        ownerKind: 'org',
        authKind: 'bearer',
        credentialTier: 'org_shared',
        orgCredential: 'o',
      });
      const perUser = await admin.store.create({
        name: 'pu',
        url: host(),
        transport: 'mcp',
        ownerKind: 'org',
        authKind: 'bearer',
        credentialTier: 'per_user',
      });
      if (!shared.ok || !perUser.ok) throw new Error('create failed');
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.member, rec);
      await settled(store);
      const before = rec.calls.length;
      expect(await store.link(shared.connection.id, { consent: true, token: 't' })).toMatchObject({
        ok: false,
        error: { code: 'nothing_to_link' },
      });
      expect(
        await store.link(perUser.connection.id, { consent: false as unknown as true, token: 't' })
      ).toMatchObject({ ok: false, error: { code: 'consent_required' } });
      expect(rec.calls.length).toBe(before);
    });

    it('authorizes an OAuth link: consent, then the authorization URL, and the browser returns with nc_*', async () => {
      const admin = open(h.tokens.admin);
      await settled(admin.store);
      const made = await admin.store.create({
        name: 'oauth per user',
        url: host(),
        transport: 'mcp',
        ownerKind: 'org',
        authKind: 'oauth',
        credentialTier: 'per_user',
      });
      if (!made.ok) throw new Error('create failed');
      const navigate = vi.fn();
      const rec = recorder(inProcessFetch(h.mock));
      const { store } = open(h.tokens.member, rec, { onNavigate: navigate });
      await settled(store);
      const id = made.connection.id;
      // Authorize before linking is the service's 400: link first.
      expect(await store.authorize(id)).toMatchObject({
        ok: false,
        error: { kind: 'invalid_request' },
      });
      const linked = await store.link(id, { consent: true });
      expect(linked).toMatchObject({
        ok: true,
        connection: { myLink: { status: 'pending_authorization', consent: 'given' } },
      });
      const started = await store.authorize(id);
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error('authorize failed');
      expect(navigate).toHaveBeenCalledWith(started.url);
      // The page it returns to carries the nonce this browser keeps for the return.
      const sentTo = new URL((rec.calls.at(-1)?.body as { return_to: string }).return_to);
      const state = sentTo.searchParams.get('nc_state');
      expect(sentTo.origin + sentTo.pathname).toBe(RETURN_TO);
      expect(JSON.parse(window.sessionStorage.getItem(WAITING_KEY) ?? '{}')).toEqual({
        state,
        connectionId: id,
      });
      // The mock's consent page completes it and sends the browser back with the result.
      const page = await h.mock.app.fetch(new Request(started.url));
      const back = new URL(page.headers.get('location') ?? '');
      expect(back.origin + back.pathname).toBe(RETURN_TO);
      expect(Object.fromEntries(back.searchParams)).toEqual({
        nc_state: state,
        nc_connection: id,
        nc_result: 'connected',
      });
      await store.reload();
      expect(store.getSnapshot().connections.find((c) => c.id === id)?.myLink).toMatchObject({
        status: 'linked',
        consent: 'given',
      });
    });

    it('starts no round trip where it is not offered, and none without a way to leave the page', async () => {
      const { store } = open(h.tokens.admin, undefined, {
        onNavigate: undefined,
        returnTo: undefined,
      });
      await settled(store);
      const made = await store.create({
        name: 'o',
        url: host(),
        transport: 'mcp',
        ownerKind: 'org',
        authKind: 'oauth',
        credentialTier: 'org_shared',
      });
      if (!made.ok) throw new Error('create failed');
      // jsdom has a window: the round trip may start there. Without one (a server), the store refuses.
      const saved = globalThis.window;
      vi.stubGlobal('window', undefined);
      try {
        expect(await store.authorize(made.connection.id)).toMatchObject({
          ok: false,
          error: { code: 'cannot_navigate' },
        });
      } finally {
        vi.stubGlobal('window', saved);
      }
    });
  });
});

describe('the round trip return', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
  });

  const waiting = (state: string, connectionId: string): void => {
    window.sessionStorage.setItem(WAITING_KEY, JSON.stringify({ state, connectionId }));
  };
  const unavailable = () => Promise.resolve(problemResponse(503, 'service_unavailable'));
  const subscribed = (): ConnectionsStore => {
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch: vi.fn(unavailable),
    });
    store.subscribe(() => undefined);
    return store;
  };

  it('reads nc_* once on the first subscribe, for the authorization this browser started, and takes it out of the address', () => {
    waiting('n1', 'conn_1');
    window.history.replaceState(
      null,
      '',
      '/connections?tab=1&nc_state=n1&nc_connection=conn_1&nc_result=error&nc_error=consent_denied'
    );
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch: vi.fn(unavailable),
    });
    expect(store.getSnapshot().lastReturn).toBeUndefined();
    const stop = store.subscribe(() => undefined);
    expect(store.getSnapshot().lastReturn).toEqual({
      connectionId: 'conn_1',
      result: 'error',
      error: 'consent_denied',
    });
    expect(window.location.search).toBe('?tab=1');
    // Used once: the record is gone.
    expect(window.sessionStorage.getItem(WAITING_KEY)).toBeNull();
    store.dismissReturn();
    expect(store.getSnapshot().lastReturn).toBeUndefined();
    stop();
    store.dispose();
  });

  it.each([
    ['no authorization is waiting', undefined, 'n1', 'conn_1'],
    ['no nonce comes back', ['n1', 'conn_1'], undefined, 'conn_1'],
    ['another nonce comes back', ['n1', 'conn_1'], 'n2', 'conn_1'],
    ['another registration comes back', ['n1', 'conn_1'], 'n1', 'conn_2'],
  ] as const)(
    'shows nothing when %s, and still takes the parameters out of the address',
    (_label, recorded, state, connectionId) => {
      if (recorded !== undefined) waiting(recorded[0], recorded[1]);
      window.history.replaceState(
        null,
        '',
        `/connections?${state === undefined ? '' : `nc_state=${state}&`}nc_connection=${connectionId}&nc_result=connected`
      );
      const store = subscribed();
      expect(store.getSnapshot().lastReturn).toBeUndefined();
      expect(window.location.search).toBe('');
      store.dispose();
    }
  );

  it.each([
    '/c?nc_state=n1',
    '/c?nc_error=consent_denied&nc_connection=x',
    '/c?nc_connection=x&nc_result=',
  ])('takes a partial set of the parameters out of the address too (%s)', (path) => {
    window.history.replaceState(null, '', path);
    const store = subscribed();
    expect(window.location.search).toBe('');
    expect(store.getSnapshot().lastReturn).toBeUndefined();
    store.dispose();
  });

  it('keeps no text of the address: an unknown result is an error, and an unknown code is left out', () => {
    waiting('n1', 'conn_1');
    window.history.replaceState(
      null,
      '',
      '/connections?nc_state=n1&nc_connection=conn_1&nc_result=Your%20account%20is%20locked&nc_error=call%20555'
    );
    const store = subscribed();
    expect(store.getSnapshot().lastReturn).toEqual({ connectionId: 'conn_1', result: 'error' });
    store.dispose();
  });

  it('drops a return for a registration the list does not hold', async () => {
    waiting('n1', 'conn_gone');
    window.history.replaceState(
      null,
      '',
      '/connections?nc_state=n1&nc_connection=conn_gone&nc_result=connected'
    );
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      return Promise.resolve(
        path === '/v1/capabilities'
          ? jsonResponse({ data: { features: ['connections'] }, meta: {} })
          : jsonResponse({ data: [], meta: { next: null } })
      );
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const stop = store.subscribe(() => undefined);
    expect(store.getSnapshot().lastReturn).toBeDefined();
    const s = await settled(store);
    expect(s.status).toBe('ready');
    expect(s.lastReturn).toBeUndefined();
    stop();
    store.dispose();
  });

  it('returns to the current page without the nc_* parameters by default', async () => {
    window.history.replaceState(null, '', '/connections?view=list');
    const calls: unknown[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities')
        return Promise.resolve(
          jsonResponse({ data: { features: ['connections', 'connections.oauth'] }, meta: {} })
        );
      if (path === '/v1/connections')
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: 'c1',
                name: 'one',
                url: 'https://one.example.com/mcp',
                transport: 'mcp',
                owner: { kind: 'org', id: 'org_1' },
                created_at: '2026-10-22T00:00:00Z',
                auth_kind: 'oauth',
                credential_tier: 'org_shared',
                status: 'pending_authorization',
              },
            ],
            meta: { next: null },
          })
        );
      return request.json().then((body: unknown) => {
        calls.push(body);
        return jsonResponse({
          data: {
            authorization_url: 'https://as.example.com/authorize?x=1',
            expires_at: '2026-10-22T00:05:00Z',
          },
          meta: {},
        });
      });
    });
    const navigate = vi.fn();
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
      onNavigate: navigate,
    });
    const stop = store.subscribe(() => undefined);
    await settled(store);
    expect(await store.authorize('c1')).toEqual({
      ok: true,
      url: 'https://as.example.com/authorize?x=1',
    });
    expect(calls).toHaveLength(1);
    const sentTo = new URL((calls[0] as { return_to: string }).return_to);
    expect(sentTo.origin + sentTo.pathname + `?view=${sentTo.searchParams.get('view') ?? ''}`).toBe(
      `${window.location.origin}/connections?view=list`
    );
    expect(sentTo.searchParams.get('nc_state')).toMatch(/^[0-9a-f-]{36}$/);
    expect(navigate).toHaveBeenCalledWith('https://as.example.com/authorize?x=1');
    stop();
    store.dispose();
  });

  it('takes the nc_* parameters out of a return_to the host gives, and keeps its own query', async () => {
    const calls: unknown[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities')
        return Promise.resolve(
          jsonResponse({ data: { features: ['connections', 'connections.oauth'] }, meta: {} })
        );
      if (path === '/v1/connections')
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: 'c1',
                name: 'one',
                url: 'https://one.example.com/mcp',
                transport: 'mcp',
                owner: { kind: 'org', id: 'org_1' },
                created_at: '2026-10-22T00:00:00Z',
                auth_kind: 'oauth',
                credential_tier: 'org_shared',
                status: 'pending_authorization',
              },
            ],
            meta: { next: null },
          })
        );
      return request.json().then((body: unknown) => {
        calls.push(body);
        return jsonResponse({
          data: {
            authorization_url: 'https://as.example.com/authorize?x=1',
            expires_at: '2026-10-22T00:05:00Z',
          },
          meta: {},
        });
      });
    });
    const navigate = vi.fn();
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
      onNavigate: navigate,
      returnTo:
        'https://app.example.test/c?keep=1&nc_result=connected&nc_error=expired&nc_state=old&nc_connection=c9',
    });
    const stop = store.subscribe(() => undefined);
    await settled(store);
    expect(await store.authorize('c1')).toEqual({
      ok: true,
      url: 'https://as.example.com/authorize?x=1',
    });
    expect(calls).toHaveLength(1);
    const sentTo = new URL((calls[0] as { return_to: string }).return_to);
    expect(`${sentTo.origin}${sentTo.pathname}`).toBe('https://app.example.test/c');
    expect(sentTo.searchParams.get('keep')).toBe('1');
    for (const name of ['nc_result', 'nc_error', 'nc_connection'])
      expect(sentTo.searchParams.has(name)).toBe(false);
    expect(sentTo.searchParams.getAll('nc_state')).toHaveLength(1);
    expect(sentTo.searchParams.get('nc_state')).toMatch(/^[0-9a-f-]{36}$/);
    expect(navigate).toHaveBeenCalledWith('https://as.example.com/authorize?x=1');
    stop();
    store.dispose();
  });

  it('follows no authorization URL that is not a web URL', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === '/v1/capabilities')
        return Promise.resolve(
          jsonResponse({ data: { features: ['connections', 'connections.oauth'] }, meta: {} })
        );
      if (path === '/v1/connections')
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: 'c1',
                name: 'one',
                url: 'https://one.example.com/mcp',
                transport: 'mcp',
                owner: { kind: 'org', id: 'org_1' },
                created_at: '2026-10-22T00:00:00Z',
                auth_kind: 'oauth',
                credential_tier: 'org_shared',
              },
            ],
            meta: { next: null },
          })
        );
      return Promise.resolve(
        jsonResponse({
          data: { authorization_url: 'javascript:alert(1)', expires_at: 'x' },
          meta: {},
        })
      );
    });
    const navigate = vi.fn();
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
      onNavigate: navigate,
      returnTo: 'https://app.example.test/c',
    });
    const stop = store.subscribe(() => undefined);
    await settled(store);
    expect(await store.authorize('c1')).toMatchObject({
      ok: false,
      error: { kind: 'malformed_response' },
    });
    expect(navigate).not.toHaveBeenCalled();
    stop();
    store.dispose();
  });
});

describe('what the service advertises', () => {
  it('is unavailable without the connections family, and reads no connection route', async () => {
    const h = await startHarness({ advertise: ['decisions'] });
    try {
      const rec = recorder(inProcessFetch(h.mock));
      const store = createConnectionsStore({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.admin,
        fetch: rec.fetch,
      });
      const stop = store.subscribe(() => undefined);
      const s = await settled(store);
      expect(s.status).toBe('unavailable');
      expect(rec.calls.map((c) => c.path)).toEqual(['/v1/capabilities']);
      stop();
      store.dispose();
    } finally {
      await h.stop();
    }
  });

  it('on edge, offers no OAuth and no links', async () => {
    const h = await startHarness({ deployment: 'edge' });
    try {
      const store = createConnectionsStore({
        baseUrl: h.baseUrl,
        getToken: () => h.tokens.admin,
        fetch: inProcessFetch(h.mock),
      });
      const stop = store.subscribe(() => undefined);
      const s = await settled(store);
      expect(s.facts).toMatchObject({ served: true, oauth: false, userLinks: false });
      const made = await store.create({
        name: 'e',
        url: 'https://edge.example.com/mcp',
        transport: 'mcp',
        ownerKind: 'org',
      });
      expect(made).toMatchObject({ ok: true, connection: { credentialTier: 'org_shared' } });
      if (!made.ok) throw new Error('create failed');
      expect(made.connection.myLink).toBeUndefined();
      expect(await store.authorize(made.connection.id)).toMatchObject({
        ok: false,
        error: { code: 'oauth_not_offered' },
      });
      expect(await store.unlink(made.connection.id)).toMatchObject({
        ok: false,
        error: { code: 'links_not_offered' },
      });
      stop();
      store.dispose();
    } finally {
      await h.stop();
    }
  });
});

describe('failures', () => {
  const caps = jsonResponse({ data: { features: ['connections'] }, meta: {} });

  it('reports a list it cannot read as an error, never as an empty list', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(new Request(input, init).url).pathname;
      return Promise.resolve(
        path === '/v1/capabilities'
          ? caps.clone()
          : jsonResponse({ data: [{ id: 'x' }], meta: { next: null } })
      );
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const stop = store.subscribe(() => undefined);
    const s = await settled(store);
    expect(s).toMatchObject({
      status: 'error',
      error: { kind: 'malformed_response' },
      connections: [],
    });
    stop();
    store.dispose();
  });

  it('ends the session once on a 401 the token cannot fix', async () => {
    const expired = vi.fn();
    const fetch = vi.fn(() => Promise.resolve(problemResponse(401, 'invalid_token')));
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
      onSessionExpired: expired,
    });
    const stop = store.subscribe(() => undefined);
    const s = await settled(store);
    expect(s.error?.kind).toBe('unauthorized');
    expect(expired).toHaveBeenCalledTimes(1);
    stop();
    store.dispose();
  });

  it('aborts its reads on dispose and changes nothing after', async () => {
    let seen: AbortSignal | undefined;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen = input instanceof Request ? input.signal : (init?.signal ?? undefined);
      return new Promise<Response>(() => undefined);
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const listener = vi.fn();
    store.subscribe(listener);
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    store.dispose();
    expect(seen?.aborted).toBe(true);
    expect(await store.rename('x', 'y')).toMatchObject({
      ok: false,
      error: { code: 'not_loaded' },
    });
  });

  it('keeps a change that finished while a list read was in flight', async () => {
    const row = {
      id: 'c1',
      name: 'old',
      url: 'https://one.example.com/mcp',
      transport: 'mcp',
      owner: { kind: 'org', id: 'o' },
      created_at: '2026-10-22T00:00:00Z',
    };
    let lists = 0;
    let release: (() => void) | undefined;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities')
        return Promise.resolve(jsonResponse({ data: { features: ['connections'] }, meta: {} }));
      if (path === '/v1/connections') {
        lists += 1;
        if (lists === 1)
          return Promise.resolve(jsonResponse({ data: [row], meta: { next: null } }));
        // The second read answers what was true before the rename.
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(jsonResponse({ data: [row], meta: { next: null } }));
          };
        });
      }
      return Promise.resolve(jsonResponse({ data: { ...row, name: 'new' }, meta: {} }));
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const stop = store.subscribe(() => undefined);
    await settled(store);
    const reloading = store.reload();
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    expect(await store.rename('c1', 'new')).toMatchObject({ ok: true });
    release?.();
    await reloading;
    expect(store.getSnapshot().connections.map((c) => c.name)).toEqual(['new']);
    stop();
    store.dispose();
  });

  it('keeps a registration pending until the read that follows its change has settled', async () => {
    const row = {
      id: 'c1',
      name: 'one',
      url: 'https://one.example.com/mcp',
      transport: 'mcp',
      owner: { kind: 'org', id: 'o' },
      created_at: '2026-10-22T00:00:00Z',
    };
    let reads = 0;
    let release: (() => void) | undefined;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities')
        return Promise.resolve(
          jsonResponse({ data: { features: ['connections', 'connections.user_links'] }, meta: {} })
        );
      if (path === '/v1/connections')
        return Promise.resolve(jsonResponse({ data: [row], meta: { next: null } }));
      if (request.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      reads += 1;
      return new Promise<Response>((resolve) => {
        release = () => {
          resolve(jsonResponse({ data: row, meta: {} }));
        };
      });
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const stop = store.subscribe(() => undefined);
    await settled(store);
    const unlinking = store.unlink('c1');
    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });
    expect(store.getSnapshot().pending.has('c1')).toBe(true);
    expect(await store.rename('c1', 'two')).toMatchObject({
      ok: false,
      error: { code: 'write_in_flight' },
    });
    release?.();
    expect(await unlinking).toEqual({ ok: true });
    expect(store.getSnapshot().pending.has('c1')).toBe(false);
    stop();
    store.dispose();
  });

  it('refuses a second change to one registration while the first is in flight', async () => {
    let release: (() => void) | undefined;
    const row = {
      id: 'c1',
      name: 'one',
      url: 'https://one.example.com/mcp',
      transport: 'mcp',
      owner: { kind: 'org', id: 'o' },
      created_at: '2026-10-22T00:00:00Z',
    };
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/v1/capabilities') return Promise.resolve(caps.clone());
      if (request.method === 'GET')
        return Promise.resolve(jsonResponse({ data: [row], meta: { next: null } }));
      return new Promise<Response>((resolve) => {
        release = () => {
          resolve(jsonResponse({ data: { ...row, name: 'two' }, meta: {} }));
        };
      });
    });
    const store = createConnectionsStore({
      baseUrl: 'https://api.example.test',
      getToken: () => 't',
      fetch,
    });
    const stop = store.subscribe(() => undefined);
    await settled(store);
    const first = store.rename('c1', 'two');
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    expect(store.getSnapshot().pending.has('c1')).toBe(true);
    expect(await store.rename('c1', 'three')).toMatchObject({
      ok: false,
      error: { code: 'write_in_flight' },
    });
    release?.();
    expect(await first).toMatchObject({ ok: true, connection: { name: 'two' } });
    expect(store.getSnapshot().pending.has('c1')).toBe(false);
    stop();
    store.dispose();
  });
});

describe('toolRowsOf', () => {
  const tool = (toolRef: string, status = 'active'): ConnectionToolInfo => ({
    id: toolRef,
    toolRef,
    connectionId: 'c',
    transport: 'mcp',
    sideEffectLevel: 'read',
    status,
  });

  it('marks what is registered, offered and no longer offered', () => {
    const rows = toolRowsOf(
      [tool('a'), tool('b'), tool('w', 'withdrawn'), tool('back', 'withdrawn')],
      [tool('a'), tool('new'), tool('back')]
    );
    expect(rows.map((r) => [r.toolRef, r.standing])).toEqual([
      ['a', 'registered'],
      ['b', 'withdrawn'],
      ['w', 'withdrawn'],
      ['back', 'offered'],
      ['new', 'offered'],
    ]);
  });

  it('before a discover, reads standing from the registered status alone', () => {
    expect(
      toolRowsOf([tool('a'), tool('w', 'withdrawn'), tool('x', 'later')], undefined).map(
        (r) => r.standing
      )
    ).toEqual(['registered', 'withdrawn', 'unknown_status']);
  });

  it('says a status it does not know as such, offered or not, and never reads it as active', () => {
    expect(
      toolRowsOf([tool('x', 'paused'), tool('y', 'paused')], [tool('x')]).map((r) => [
        r.toolRef,
        r.standing,
      ])
    ).toEqual([
      ['x', 'unknown_status'],
      ['y', 'withdrawn'],
    ]);
  });
});
