// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPending, PENDING_MAX_AGE_MS, takePending, writePending } from './pending.js';
import { memoryRefreshStore, sessionStorageRefreshStore } from './stores.js';

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('memoryRefreshStore', () => {
  it('holds one token and forgets it on clear', () => {
    const store = memoryRefreshStore();
    expect(store.get()).toBeNull();
    store.set('a');
    expect(store.get()).toBe('a');
    store.set('b');
    expect(store.get()).toBe('b');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('is per store: two stores do not share a token', () => {
    const one = memoryRefreshStore();
    const two = memoryRefreshStore();
    one.set('a');
    expect(two.get()).toBeNull();
  });
});

describe('sessionStorageRefreshStore', () => {
  it('T20-A6: keeps the token only in sessionStorage under nc.auth.refresh.<clientId>', () => {
    const store = sessionStorageRefreshStore('client-1');
    store.set('rt');
    expect(sessionStorage.getItem('nc.auth.refresh.client-1')).toBe('rt');
    expect(store.get()).toBe('rt');
    expect(localStorage.length).toBe(0);
    store.clear();
    expect(sessionStorage.getItem('nc.auth.refresh.client-1')).toBeNull();
    expect(store.get()).toBeNull();
  });

  it('is shared by stores of one client in one tab, and separate for another client', () => {
    sessionStorageRefreshStore('a').set('rt');
    expect(sessionStorageRefreshStore('a').get()).toBe('rt');
    expect(sessionStorageRefreshStore('b').get()).toBeNull();
  });

  it('falls back to memory when a write is refused, and a later good write wins again', () => {
    const store = sessionStorageRefreshStore('c');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    store.set('held-in-memory');
    expect(store.get()).toBe('held-in-memory');
    expect(sessionStorage.getItem('nc.auth.refresh.c')).toBeNull();
    spy.mockRestore();
    store.set('stored');
    expect(store.get()).toBe('stored');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('returns the newest token when a later write is refused while an older one is stored', () => {
    const store = sessionStorageRefreshStore('e');
    store.set('a');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    store.set('b');
    expect(store.get()).toBe('b');
    spy.mockRestore();
    store.clear();
  });

  it('still returns the newest token when the older stored one cannot be removed', () => {
    const store = sessionStorageRefreshStore('f');
    store.set('a');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    store.set('b');
    expect(store.get()).toBe('b');
  });

  it('falls back to memory when reading or removing throws', () => {
    const store = sessionStorageRefreshStore('d');
    store.set('x');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(store.get()).toBeNull();
    expect(() => {
      store.clear();
    }).not.toThrow();
  });

  it('keeps the token in memory when sessionStorage is not available at all', () => {
    vi.stubGlobal('sessionStorage', undefined);
    const store = sessionStorageRefreshStore('e');
    store.set('m');
    expect(store.get()).toBe('m');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('treats a sessionStorage getter that throws as not available', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      const store = sessionStorageRefreshStore('f');
      store.set('m');
      expect(store.get()).toBe('m');
      expect(writePending('s', { verifier: 'v', returnTo: undefined, createdAt: 0 })).toBe(false);
      expect(takePending('s', 0)).toBeNull();
      expect(() => {
        clearPending();
      }).not.toThrow();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'sessionStorage');
      else Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });
});

describe('the pending record', () => {
  it('is read once, and ten minutes after it was written it is gone', () => {
    expect(writePending('s1', { verifier: 'v', returnTo: '/x', createdAt: 100 })).toBe(true);
    expect(takePending('s1', 100)).toEqual({ verifier: 'v', returnTo: '/x', createdAt: 100 });
    expect(takePending('s1', 100)).toBeNull();
    writePending('s2', { verifier: 'v', returnTo: undefined, createdAt: 100 });
    expect(takePending('s2', 100 + PENDING_MAX_AGE_MS + 1)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('clearPending removes every pending record and nothing else', () => {
    writePending('a', { verifier: 'v', returnTo: undefined, createdAt: 1 });
    writePending('b', { verifier: 'v', returnTo: undefined, createdAt: 1 });
    sessionStorage.setItem('nc.auth.refresh.x', 'rt');
    clearPending();
    expect(Object.keys(sessionStorage)).toEqual(['nc.auth.refresh.x']);
  });
});
