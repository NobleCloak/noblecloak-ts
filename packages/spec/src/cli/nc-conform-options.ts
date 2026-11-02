/** The command line of nc-conform, parsed into a conformance target. No process exit: tested directly. */
import { parseArgs } from 'node:util';

import type { Alias, Target, WebhookSink } from '../conformance/types.js';

export interface ConformArgs {
  readonly target: Target;
  readonly json: boolean;
  readonly allowSkips: boolean;
  /** Lines to print on stderr about flags that still parse but no longer do anything. */
  readonly deprecations: readonly string[];
}

/**
 * `--face public` is accepted and ignored, with a deprecation line, so that scripts written for the flag keep
 * working for a release; any other value is a usage error. The package has one document, so there is nothing to
 * choose. Shared by nc-conform and nc-mock.
 */
export function faceDeprecation(command: string, face: string | undefined): string[] {
  if (face === undefined) return [];
  if (face !== 'public')
    throw new Error(
      '--face is deprecated and takes no value but public: the package has one document'
    );
  return [
    `${command}: --face is deprecated and ignored: the package has one document. Remove the flag; a later release rejects it.`,
  ];
}

/** Parses `argv` (without the executable and script). Throws an Error whose message is the usage problem. */
export function parseConformArgs(argv: readonly string[]): ConformArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'base-url': { type: 'string' },
      token: { type: 'string' },
      'approver-token': { type: 'string' },
      'admin-token': { type: 'string' },
      'member-token': { type: 'string' },
      'creator-user-token': { type: 'string' },
      'other-org-token': { type: 'string' },
      'entitled-token': { type: 'string' },
      'wrong-audience-token': { type: 'string' },
      'forged-token': { type: 'string' },
      'expired-token': { type: 'string' },
      'dpop-bound-token': { type: 'string' },
      'no-org-token': { type: 'string' },
      'no-scope-token': { type: 'string' },
      'other-service-token': { type: 'string' },
      'approver-surface-token': { type: 'string' },
      'approver-token-without-resolve-scope': { type: 'string' },
      face: { type: 'string' },
      deployment: { type: 'string', default: 'hosted' },
      'proxied-tool': { type: 'string', default: 'mcp:tracker:create_issue' },
      'allow-tool': { type: 'string', default: 'mcp:tracker:search' },
      'deny-tool': { type: 'string', default: 'mcp:crm:delete_account' },
      'default-tool': { type: 'string', default: 'mcp:tracker:list_labels' },
      'reserved-tool-ref': { type: 'string' },
      'system-tool-ref': { type: 'string' },
      'tool-ref-in-use': { type: 'string' },
      'on-deny-tool-ref': { type: 'string' },
      'on-deny-silent-tool-ref': { type: 'string' },
      'admin-role': { type: 'string' },
      'connection-server-url': { type: 'string' },
      'oauth-return-to': { type: 'string' },
      'no-on-deny': { type: 'boolean', default: false },
      'clock-control': { type: 'string' },
      'mock-control': { type: 'string' },
      'webhook-sink': { type: 'string' },
      'webhook-sink-token': { type: 'string' },
      'webhook-sink-wait': { type: 'string' },
      'webhook-sink-settle': { type: 'string' },
      'allow-skips': { type: 'boolean', default: false },
      'reject-undeclared': { type: 'boolean', default: false },
      'allow-undeclared': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const need = <T>(value: T | undefined, message: string): T => {
    if (value === undefined) throw new Error(message);
    return value;
  };
  const baseUrl = need(values['base-url'], '--base-url is required');
  const creator = need(
    values.token,
    '--token is required (the principal that creates obligations)'
  );
  if (values.deployment !== 'edge' && values.deployment !== 'hosted')
    throw new Error('--deployment is hosted or edge');
  const deprecations = faceDeprecation('nc-conform', values.face);
  if (values['no-on-deny'] && values['on-deny-tool-ref'] !== undefined)
    throw new Error('--no-on-deny and --on-deny-tool-ref contradict each other');
  if (values['reject-undeclared'] && values['allow-undeclared'])
    throw new Error('--reject-undeclared and --allow-undeclared contradict each other');

  const webhookSink = parseWebhookSink(values);

  // The approver is optional like every other flavour: absent, each scenario that needs one is skipped as
  // `unconfigured`. Given, it should be a different principal from --token (the one that resolves what --token creates).
  const tokens: Partial<Record<Alias, string>> = { creator };
  if (values['approver-token'] !== undefined) tokens.approver = values['approver-token'];
  if (values['admin-token'] !== undefined) tokens.admin = values['admin-token'];
  if (values['member-token'] !== undefined) tokens.member = values['member-token'];
  if (values['creator-user-token'] !== undefined)
    tokens.creator_user = values['creator-user-token'];
  if (values['other-org-token'] !== undefined) tokens.other_org = values['other-org-token'];
  if (values['entitled-token'] !== undefined) tokens.entitled = values['entitled-token'];
  if (values['wrong-audience-token'] !== undefined)
    tokens.wrong_audience = values['wrong-audience-token'];
  if (values['forged-token'] !== undefined) tokens.forged = values['forged-token'];
  if (values['expired-token'] !== undefined) tokens.expired = values['expired-token'];
  if (values['dpop-bound-token'] !== undefined) tokens.dpop_bound = values['dpop-bound-token'];
  if (values['no-org-token'] !== undefined) tokens.no_org = values['no-org-token'];
  if (values['no-scope-token'] !== undefined) tokens.no_scope = values['no-scope-token'];
  if (values['other-service-token'] !== undefined)
    tokens.other_service = values['other-service-token'];
  if (values['approver-surface-token'] !== undefined)
    tokens.approver_surface_token = values['approver-surface-token'];
  if (values['approver-token-without-resolve-scope'] !== undefined)
    tokens.approver_token_without_resolve_scope = values['approver-token-without-resolve-scope'];

  // The document is the contract a server is held to: an undeclared field fails unless the caller says otherwise.
  const rejectUndeclared = values['reject-undeclared'] || !values['allow-undeclared'];

  return {
    json: values.json,
    allowSkips: values['allow-skips'],
    deprecations,
    target: {
      baseUrl: baseUrl.replace(/\/$/, ''),
      deployment: values.deployment,
      tokens,
      fixtures: {
        proxied_tool: values['proxied-tool'],
        allow_tool: values['allow-tool'],
        deny_tool: values['deny-tool'],
        default_tool: values['default-tool'],
        ...(values['reserved-tool-ref'] === undefined
          ? {}
          : { reserved_tool_ref: values['reserved-tool-ref'] }),
        ...(values['system-tool-ref'] === undefined
          ? {}
          : { system_tool_ref: values['system-tool-ref'] }),
        ...(values['tool-ref-in-use'] === undefined
          ? {}
          : { tool_ref_in_use: values['tool-ref-in-use'] }),
        ...(values['on-deny-tool-ref'] === undefined
          ? {}
          : { on_deny_tool_ref: values['on-deny-tool-ref'] }),
        ...(values['on-deny-silent-tool-ref'] === undefined
          ? {}
          : { on_deny_silent_tool_ref: values['on-deny-silent-tool-ref'] }),
        ...(values['admin-role'] === undefined ? {} : { admin_role: values['admin-role'] }),
        ...(values['connection-server-url'] === undefined
          ? {}
          : { connection_server_url: values['connection-server-url'] }),
        ...(values['oauth-return-to'] === undefined
          ? {}
          : { oauth_return_to: values['oauth-return-to'] }),
      },
      ...(values['no-on-deny'] ? { noOnDeny: true as const } : {}),
      ...(rejectUndeclared ? { rejectUndeclared: true } : {}),
      ...(values['clock-control'] === undefined ? {} : { clockControl: values['clock-control'] }),
      ...(values['mock-control'] === undefined ? {} : { mockControl: values['mock-control'] }),
      ...(webhookSink === undefined ? {} : { webhookSink }),
    },
  };
}

const DEFAULT_SINK_WAIT_SECONDS = 60;
const DEFAULT_SINK_SETTLE_SECONDS = 10;

/** A whole number of seconds in `min..max`; the message names the flag, never a value that might be a token. */
function seconds(
  flag: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max)
    throw new Error(`--${flag} is a whole number of seconds from ${String(min)} to ${String(max)}`);
  return value;
}

/** `--webhook-sink` and `--webhook-sink-token` go together; the sink is an `https://` base with no query or userinfo. */
function parseWebhookSink(values: {
  'webhook-sink'?: string | undefined;
  'webhook-sink-token'?: string | undefined;
  'webhook-sink-wait'?: string | undefined;
  'webhook-sink-settle'?: string | undefined;
}): WebhookSink | undefined {
  const url = values['webhook-sink'];
  const token = values['webhook-sink-token'];
  if (url === undefined && token === undefined) {
    if (values['webhook-sink-wait'] !== undefined || values['webhook-sink-settle'] !== undefined)
      throw new Error('--webhook-sink-wait and --webhook-sink-settle need --webhook-sink');
    return undefined;
  }
  if (url === undefined || token === undefined)
    throw new Error('--webhook-sink and --webhook-sink-token are given together or not at all');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('--webhook-sink is not a URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('--webhook-sink is an https:// URL');
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    // `new URL` reports an empty query or fragment (`…?`, `…#`) as none, so the raw text is checked too.
    url.includes('?') ||
    url.includes('#')
  )
    throw new Error('--webhook-sink takes no credentials, query or fragment');
  if (token === '') throw new Error('--webhook-sink-token is empty');
  return {
    // The WHATWG form (lower-case host, default port dropped), as the sink's URLs come back.
    baseUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, ''),
    token,
    waitSeconds: seconds(
      'webhook-sink-wait',
      values['webhook-sink-wait'],
      DEFAULT_SINK_WAIT_SECONDS,
      1,
      300
    ),
    settleSeconds: seconds(
      'webhook-sink-settle',
      values['webhook-sink-settle'],
      DEFAULT_SINK_SETTLE_SECONDS,
      0,
      60
    ),
  };
}
