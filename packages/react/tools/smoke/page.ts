/**
 * The smoke page's script. It is bundled at start-up by `server.ts` from the TypeScript source and runs
 * in the browser at `http://localhost:3000`: it drives `createBrowserAuth` through sign-in, the callback, a
 * forced refresh, a reload (restore from `sessionStorage`) and sign-out, and shows the decoded claims of the
 * access token. The token is decoded here and never sent anywhere. Text is written with `textContent` only.
 */
import { createBrowserAuth } from '../../src/auth/index.js';
import type { AuthState } from '../../src/auth/index.js';
import { decodeClaims } from './claims.js';

interface SmokeConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly resource: string;
  readonly redirectUri: string;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the smoke page has no #${id}`);
  return found;
}

function describeState(state: AuthState): string {
  if (state.status === 'error') return `error: ${state.error.code}: ${state.error.message}`;
  if (state.status === 'signed_out' && state.message !== undefined) {
    return `signed_out: ${state.message}`;
  }
  return state.status;
}

async function start(): Promise<void> {
  const config = JSON.parse(element('smoke-config').textContent) as SmokeConfig;
  const auth = createBrowserAuth({
    issuer: config.issuer,
    clientId: config.clientId,
    resource: config.resource,
    redirectUri: config.redirectUri,
  });
  const stateOut = element('state');
  const claimsOut = element('claims');
  const log = element('log');
  const note = (line: string): void => {
    log.textContent = `${new Date().toISOString()} ${line}\n${log.textContent}`;
  };
  const render = (): void => {
    stateOut.textContent = describeState(auth.getSnapshot());
  };
  const showClaims = async (forceRefresh: boolean): Promise<void> => {
    try {
      const token = await auth.getToken({ forceRefresh });
      const claims = decodeClaims(token);
      claimsOut.textContent =
        claims === null ? 'The access token is not a JWT.' : JSON.stringify(claims, null, 2);
    } catch (error) {
      claimsOut.textContent = error instanceof Error ? `${error.name}: ${error.message}` : 'failed';
    }
  };
  auth.subscribe(() => {
    render();
    note(`state ${describeState(auth.getSnapshot())}`);
  });

  element('sign-in').addEventListener('click', () => {
    void auth.signIn('/');
  });
  element('refresh').addEventListener('click', () => {
    void showClaims(true);
  });
  element('reload').addEventListener('click', () => {
    window.location.reload();
  });
  element('sign-out').addEventListener('click', () => {
    void auth.signOut().then(() => {
      claimsOut.textContent = '';
    });
  });

  if (window.location.pathname === new URL(config.redirectUri).pathname) {
    await auth.completeSignIn();
    // The code is spent: the page goes back to the sign-in page, and a reload there restores the session.
    window.history.replaceState(null, '', '/');
  } else {
    await auth.restore();
  }
  render();
  if (auth.getSnapshot().status === 'signed_in') await showClaims(false);
}

void start();
