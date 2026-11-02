import type { RefreshTokenStore } from '../auth-types.js';

/**
 * A refresh-token store that lives in this object only. For tests, and for a host that wants no token to
 * outlive the page (every reload then needs a new sign-in).
 */
export function memoryRefreshStore(): RefreshTokenStore {
  let token: string | null = null;
  return {
    get: () => token,
    set: (value) => {
      token = value;
    },
    clear: () => {
      token = null;
    },
  };
}

const sessionArea = (): Storage | null => {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * The default store: the refresh token in `sessionStorage` under `nc.auth.refresh.<clientId>`. It is
 * tab-scoped and cleared when the tab closes, and it does not stop script injected into the page, which can
 * read it as it could read memory; a content-security policy is the defence. Where `sessionStorage` is
 * missing or refuses a write, the token is kept in this store's memory instead.
 */
export function sessionStorageRefreshStore(clientId: string): RefreshTokenStore {
  const key = `nc.auth.refresh.${clientId}`;
  const fallback = memoryRefreshStore();
  return {
    get: () => {
      try {
        // A value in memory is newer than the one in sessionStorage: it is only set when a write was refused.
        return fallback.get() ?? sessionArea()?.getItem(key) ?? null;
      } catch {
        return fallback.get();
      }
    },
    set: (value) => {
      try {
        const area = sessionArea();
        if (area === null) {
          fallback.set(value);
        } else {
          area.setItem(key, value);
          fallback.clear();
        }
      } catch {
        fallback.set(value);
        // Drop the older stored value so it cannot be read back as current (a replayed refresh token).
        try {
          sessionArea()?.removeItem(key);
        } catch {
          // get() prefers the memory value, so a value that cannot be removed is still never returned.
        }
      }
    },
    clear: () => {
      fallback.clear();
      try {
        sessionArea()?.removeItem(key);
      } catch {
        // Nothing stored that could be removed.
      }
    },
  };
}
