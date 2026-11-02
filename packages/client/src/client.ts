/** The typed fetch client for the module API. */
import createFetchClient from 'openapi-fetch';
import type { Client, Middleware } from 'openapi-fetch';

import type { paths } from './schema.js';

/** What a DPoP proof is requested for. */
export interface DpopRequest {
  readonly method: string;
  /** The request URL without query or fragment, as RFC 9449 §4.2 requires for `htu`. */
  readonly url: string;
  readonly accessToken: string;
}

export interface ClientOptions {
  /** The API's base URL, for example `https://govern.example.com`. */
  readonly baseUrl: string;
  /** Returns the access token. Called for every request, so it may refresh. */
  readonly getToken: () => string | Promise<string>;
  /**
   * Optional DPoP proof hook (RFC 9449). When present, the request carries the proof in a `DPoP`
   * header and the token under the `DPoP` authorization scheme.
   */
  readonly dpopProof?: (request: DpopRequest) => string | Promise<string>;
  /** A fetch implementation. Defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The module API client. Request and response types come from the spec package's published document. */
export type ModuleApiClient = Client<paths>;

/** Builds a client that authenticates every request. */
export function createClient(options: ClientOptions): ModuleApiClient {
  const client = createFetchClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const authenticate: Middleware = {
    async onRequest({ request }) {
      const token = await options.getToken();
      if (options.dpopProof === undefined) {
        request.headers.set('Authorization', `Bearer ${token}`);
        return request;
      }
      const url = new URL(request.url);
      url.search = '';
      url.hash = '';
      const proof = await options.dpopProof({
        method: request.method,
        url: url.toString(),
        accessToken: token,
      });
      request.headers.set('Authorization', `DPoP ${token}`);
      request.headers.set('DPoP', proof);
      return request;
    },
  };
  client.use(authenticate);
  return client;
}
