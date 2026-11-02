import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { isWebUrl } from '../connections-parse.js';
import { ownedByOrganisation, takesLink } from '../connections-store.js';
import type {
  ConnectionInfo,
  ConnectionsController,
  ConnectionsError,
} from '../connections-types.js';
import { useConnection } from '../use-connection.js';
import { RenderBoundary } from './boundary.js';
import { createConnectionsTranslate, knownKey } from './connections-labels.js';
import type { ConnectionsLabels, ConnectionsTranslate } from './connections-labels.js';
import {
  ConnectionsErrorAlert,
  authText,
  dateText,
  ownerText,
  stateText,
  stateVariant,
  tierText,
} from './connections-parts.js';
import type { ErrorContext } from './connections-parts.js';
import { escapeInvisible } from './format-json.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

interface CommonProps {
  /** What `useConnections` returns. */
  readonly controller: ConnectionsController;
  /** Replaces any of the components' strings. A value may hold `{name}` placeholders, as the default does. */
  readonly labels?: ConnectionsLabels;
  /** Replaces any primitive by role (`Button`, `Input`, `Alert`, …), over any `NcProvider` around it. */
  readonly components?: ModuleComponents;
  /** Called by "Sign in again" when the session has expired. */
  readonly onSignIn?: () => void;
}

export interface ConnectionsProps extends CommonProps {
  readonly className?: string;
  /**
   * Servers the host offers to register in one step: each is a tile whose Connect opens the form filled in with it.
   * The module ships none; it never sends a preset by itself, and the form is the one a caller fills in by hand.
   */
  readonly catalog?: readonly ConnectionPreset[];
}

/** A server a host offers to register, as the form's starting values. Nothing here is a credential. */
export interface ConnectionPreset {
  /** The host's key for the tile; never sent. */
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** A sentence about the server, shown on its tile. */
  readonly description?: string;
  /** `mcp` or `a2a`; the form's default when absent or not served. */
  readonly transport?: string;
  /** `none`, `bearer` or `oauth`; the form's default when absent or not offered. */
  readonly authKind?: string;
  /** For `oauth`: the scopes to ask for, the authorization server and the deployment's client there. */
  readonly oauth?: {
    readonly scopes?: readonly string[];
    readonly issuer?: string;
    readonly clientId?: string;
  };
}

export interface ConnectionDetailProps extends CommonProps {
  readonly connectionId: string;
  readonly className?: string;
  /** Receives the sentence each finished action reports (the list puts it in its live region). */
  readonly onMessage?: (message: string) => void;
}

export interface AddConnectionProps extends CommonProps {
  readonly className?: string;
  /** Called with a registration once it is created. */
  readonly onCreated?: (connection: ConnectionInfo) => void;
  /** Opens a registration: a 409 `connection_exists` that names the existing one links it through this. */
  readonly onOpen?: (id: string) => void;
  /** Called by Cancel; without it the form has no Cancel. */
  readonly onCancel?: () => void;
  /** The form's starting values (a host's preset); the caller may change any of them before registering. */
  readonly initial?: ConnectionPreset;
}

/** A failure, with the sentence that says which action it was and whose act it is. */
interface Failure {
  readonly error: ConnectionsError;
  readonly context: ErrorContext;
}

const KNOWN_TRANSPORTS = ['mcp', 'a2a'] as const;
const KNOWN_OWNER_KINDS = ['org', 'principal'] as const;

/** The owner kinds the form offers: the ones the service advertises, both when it says nothing. */
function ownerKindsOf(controller: ConnectionsController): string[] {
  const advertised = controller.facts?.registration?.ownerKinds;
  return KNOWN_OWNER_KINDS.filter((k) => advertised === undefined || advertised.includes(k));
}

/** The transports the form offers: the ones the service advertises. */
function transportsOf(controller: ConnectionsController): string[] {
  const advertised = controller.facts?.transports ?? KNOWN_TRANSPORTS;
  return KNOWN_TRANSPORTS.filter((k) => advertised.includes(k));
}

/** Whether the form to register a server is offered. */
export function registrationOffered(controller: ConnectionsController): boolean {
  if (controller.status !== 'ready' || controller.facts?.served !== true) return false;
  // Not an administrator (the host said so, or a 403 did): hidden only where only administrators register.
  if (controller.administration.readOnly && controller.facts.registration?.who === 'administrators')
    return false;
  return ownerKindsOf(controller).length > 0 && transportsOf(controller).length > 0;
}

/** Whether the caller is offered the changes of `connection`: its owner's, or the organisation's administrators'. */
function changeOffered(controller: ConnectionsController, connection: ConnectionInfo): boolean {
  return !(ownedByOrganisation(connection) && controller.administration.readOnly);
}

/**
 * The registrations of tool servers the caller may see, with the form to register one where the service lets the
 * caller, and for an open registration its tools, the changes the caller may make and the caller's own credential.
 *
 * Everything it offers comes from the controller (the service's capabilities and answers); nothing names a kind of
 * deployment. No credential is ever shown: a token is typed into a write-only field and sent once.
 */
export function Connections({ components, ...props }: ConnectionsProps) {
  return (
    <WithComponents components={components}>
      <ConnectionsView {...props} />
    </WithComponents>
  );
}

function ConnectionsView({
  controller,
  className,
  labels,
  onSignIn,
  catalog,
}: Omit<ConnectionsProps, 'components'>) {
  const t = createConnectionsTranslate(labels);
  const { Button, EmptyState } = useNc();
  const headingId = useId();
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  /** The preset the form was opened with, when a tile opened it. */
  const [preset, setPreset] = useState<ConnectionPreset | undefined>(undefined);
  const [message, setMessage] = useState('');
  /** The failure of a reconnect started from the list, with the sentence that says whose act it was. */
  const [rowFailure, setRowFailure] = useState<Failure | undefined>(undefined);
  /** Opens a registration; a list reconnect's failure no longer describes what is shown. */
  const openRegistration = (id: string): void => {
    setRowFailure(undefined);
    setOpenId(id);
  };
  const rootClass = ['nc-root', 'nc-connections', className].filter(Boolean).join(' ');

  const header = (
    <header className="nc-conn-header">
      <h2 id={headingId}>{t('heading')}</h2>
    </header>
  );

  if (controller.status === 'idle' || controller.status === 'loading')
    return (
      <section className={rootClass} aria-labelledby={headingId} aria-busy="true">
        {header}
        <p>{t('loading')}</p>
      </section>
    );
  if (controller.status === 'unavailable')
    return (
      <section className={rootClass} aria-labelledby={headingId}>
        {header}
        <EmptyState title={t('unavailableTitle')} description={t('unavailableText')} />
      </section>
    );
  if (controller.status === 'error')
    return (
      <section className={rootClass} aria-labelledby={headingId}>
        {header}
        {controller.error === undefined ? (
          <p role="alert">{t('loadFailed')}</p>
        ) : (
          <ConnectionsErrorAlert error={controller.error} t={t} onSignIn={onSignIn} />
        )}
        <Button type="button" variant="secondary" onClick={() => void controller.reload()}>
          {t('retry')}
        </Button>
      </section>
    );

  const open =
    openId === undefined ? undefined : controller.connections.find((c) => c.id === openId);
  const offered = registrationOffered(controller);
  return (
    <section className={rootClass} aria-labelledby={headingId}>
      {header}
      <AdministrationNote controller={controller} t={t} />
      {controller.error === undefined ? null : (
        <ConnectionsErrorAlert error={controller.error} t={t} onSignIn={onSignIn}>
          <p>{t('staleList')}</p>
        </ConnectionsErrorAlert>
      )}
      <ReturnNotice controller={controller} t={t} onOpen={openRegistration} />
      {rowFailure === undefined ? null : (
        <ConnectionsErrorAlert
          error={rowFailure.error}
          t={t}
          context={rowFailure.context}
          onSignIn={onSignIn}
        >
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setRowFailure(undefined);
            }}
          >
            {t('returnDismiss')}
          </Button>
        </ConnectionsErrorAlert>
      )}
      {!offered ? null : adding ? (
        <AddConnectionForm
          key={preset?.id ?? ''}
          controller={controller}
          t={t}
          onSignIn={onSignIn}
          initial={preset}
          onCancel={() => {
            setAdding(false);
            setPreset(undefined);
          }}
          onCreated={(connection) => {
            setAdding(false);
            setPreset(undefined);
            setOpenId(connection.id);
            setMessage(
              connection.state === 'pending_authorization'
                ? t('registeredPending', { name: escapeInvisible(connection.name) })
                : t('registered', { name: escapeInvisible(connection.name) })
            );
          }}
          onOpen={(id) => {
            setAdding(false);
            setPreset(undefined);
            setOpenId(id);
          }}
        />
      ) : (
        <div className="nc-conn-actions">
          <Button
            type="button"
            onClick={() => {
              setPreset(undefined);
              setAdding(true);
            }}
          >
            {t('addOpen')}
          </Button>
        </div>
      )}
      {!offered || catalog === undefined || catalog.length === 0 ? null : (
        <Catalog
          controller={controller}
          catalog={catalog}
          t={t}
          onConnect={(entry) => {
            setPreset(entry);
            setAdding(true);
          }}
        />
      )}
      <ConnectionList
        controller={controller}
        t={t}
        openId={openId}
        onOpen={openRegistration}
        onReconnect={(connection) => {
          setRowFailure(undefined);
          const action = reconnectOf(controller, connection);
          // Only an authorization is one step; a credential to type or consent to give is asked in the open registration.
          if (action?.step !== 'authorize') {
            openRegistration(connection.id);
            return;
          }
          void controller.authorize(connection.id).then((r) => {
            if (!r.ok)
              setRowFailure({ error: r.error, context: action.scope === 'own' ? 'own' : 'admin' });
          });
        }}
      />
      {open === undefined ? null : (
        <div className="nc-conn-open">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setOpenId(undefined);
            }}
          >
            {t('close')}
          </Button>
          <RenderBoundary key={open.id}>
            <ConnectionDetailView
              controller={controller}
              connection={open}
              t={t}
              onSignIn={onSignIn}
              onMessage={setMessage}
            />
          </RenderBoundary>
        </div>
      )}
      <div role="status" className="nc-live">
        <p>{message}</p>
      </div>
    </section>
  );
}

function AdministrationNote({
  controller,
  t,
}: {
  readonly controller: ConnectionsController;
  readonly t: ConnectionsTranslate;
}) {
  const reason = controller.administration.reason;
  if (reason === undefined) return null;
  return (
    <p className="nc-conn-note" role="status">
      {reason === 'host' ? t('readOnlyHost') : t('readOnlyForbidden')}
      {controller.facts?.registration?.who === 'administrators'
        ? ` ${t('readOnlyRegister')}`
        : null}
    </p>
  );
}

/** What the last OAuth round trip came back with, once; an error code is shown in words from the closed list. */
function ReturnNotice({
  controller,
  t,
  onOpen,
}: {
  readonly controller: ConnectionsController;
  readonly t: ConnectionsTranslate;
  readonly onOpen: (id: string) => void;
}) {
  const { Alert, Button } = useNc();
  const back = controller.lastReturn;
  if (back === undefined) return null;
  // Only a registration the caller sees, by its own name: nothing of the address is shown.
  const known = controller.connections.find((c) => c.id === back.connectionId);
  if (known === undefined) return null;
  const name = escapeInvisible(known.name);
  const key = back.error === undefined ? undefined : knownKey('returnError_', back.error);
  const text =
    back.result === 'connected'
      ? t('returnConnected', { name })
      : key === undefined
        ? t('returnErrorGeneric', { name })
        : t('returnError', { name, reason: t(key) });
  const variant = back.result === 'connected' ? 'success' : 'danger';
  return (
    <Alert variant={variant}>
      <p>{text}</p>
      <div className="nc-conn-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onOpen(known.id);
          }}
        >
          {t('open', { name })}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            controller.dismissReturn();
          }}
        >
          {t('returnDismiss')}
        </Button>
      </div>
    </Alert>
  );
}

/**
 * The reconnect the caller may start on a registration: authorize its own OAuth link again (`own`, `authorize`), link
 * again or replace its own token (`own`, `link`: consent, and for a bearer server a token, are asked first),
 * authorize the organisation credential again (`org`, `authorize`) or replace it (`org`, `rotate`), the last two an
 * administrator's. `attention` says the credential is not in use now (waiting, degraded, or consent revoked); without
 * it the reconnect is a re-consent or a rotation of a credential that works. Undefined when there is none to offer.
 */
export interface Reconnect {
  readonly scope: 'own' | 'org';
  readonly step: 'authorize' | 'link' | 'rotate';
  readonly attention: boolean;
}

export function reconnectOf(
  controller: ConnectionsController,
  connection: ConnectionInfo
): Reconnect | undefined {
  const oauthOffered = controller.facts?.oauth === true;
  if (controller.facts?.userLinks === true && takesLink(connection)) {
    const link = connection.myLink;
    // Never linked (or unlinked): that is a first link, not a reconnect.
    if (link === undefined || link.status === 'none') return undefined;
    const working = link.status === 'linked' && link.consent === 'given';
    const attention = !working;
    if (link.consent !== 'given') return { scope: 'own', step: 'link', attention };
    if (connection.authKind === 'oauth') {
      if (!oauthOffered) return undefined;
      return link.status === 'linked' ||
        link.status === 'pending_authorization' ||
        link.status === 'degraded'
        ? { scope: 'own', step: 'authorize', attention }
        : undefined;
    }
    return connection.authKind === 'bearer' ? { scope: 'own', step: 'link', attention } : undefined;
  }
  // The organisation credential is an administrator's, whoever owns the registration.
  if (connection.credentialTier !== 'org_shared' || controller.administration.readOnly)
    return undefined;
  const state = connection.state;
  const attention = state === 'pending_authorization' || state === 'degraded';
  if (connection.authKind === 'oauth')
    return oauthOffered && (attention || state === 'connected')
      ? { scope: 'org', step: 'authorize', attention }
      : undefined;
  if (connection.authKind === 'bearer') return { scope: 'org', step: 'rotate', attention };
  return undefined;
}

/**
 * Whether two server URLs name the same server for the tile's mark: scheme and host case, a default port and a
 * trailing slash do not count (the forms a deployment may treat as the same; a query string does). A URL that does
 * not parse is compared as written.
 */
export function sameServer(a: string, b: string): boolean {
  const key = (url: string): string => {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/+$/, '');
      return `${u.origin}${path}${u.search}`;
    } catch {
      return url;
    }
  };
  return key(a) === key(b);
}

/** The host's presets, each a tile that opens the form filled in with it. */
function Catalog({
  controller,
  catalog,
  t,
  onConnect,
}: {
  readonly controller: ConnectionsController;
  readonly catalog: readonly ConnectionPreset[];
  readonly t: ConnectionsTranslate;
  readonly onConnect: (entry: ConnectionPreset) => void;
}) {
  const { Badge, Button } = useNc();
  const headingId = useId();
  return (
    <section className="nc-conn-catalog" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('catalogHeading')}</h3>
      <ul className="nc-conn-tiles">
        {catalog.map((entry) => {
          const name = escapeInvisible(entry.name);
          const registered = controller.connections.filter((c) =>
            sameServer(c.url, entry.url)
          ).length;
          return (
            <li key={entry.id} className="nc-conn-tile">
              <strong>{name}</strong>
              <code className="nc-conn-url">{escapeInvisible(entry.url)}</code>
              {entry.description === undefined ? null : (
                <p className="nc-muted">{escapeInvisible(entry.description)}</p>
              )}
              {registered === 0 ? null : <Badge variant="success">{t('catalogRegistered')}</Badge>}
              <Button
                type="button"
                variant="secondary"
                aria-label={t('catalogConnectNamed', { name })}
                onClick={() => {
                  onConnect(entry);
                }}
              >
                {t('catalogConnect')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The caller's own link in a word or two, for the list. */
function myLinkSummary(
  controller: ConnectionsController,
  connection: ConnectionInfo,
  t: ConnectionsTranslate
): string {
  if (controller.facts?.userLinks !== true || !takesLink(connection)) return '—';
  const link = connection.myLink;
  if (link === undefined || link.status === 'none') return t('myNone');
  if (link.consent !== 'given')
    return link.consent === 'revoked'
      ? t('myConsentRevoked')
      : t('myConsentUnknown', { consent: escapeInvisible(link.consent) });
  if (link.status === 'linked') return t('myLinked', { since: '' });
  if (link.status === 'pending_authorization') return t('myPending');
  if (link.status === 'degraded') return t('myDegraded');
  return t('myStateUnknown', { state: escapeInvisible(link.status) });
}

function ConnectionList({
  controller,
  t,
  openId,
  onOpen,
  onReconnect,
}: {
  readonly controller: ConnectionsController;
  readonly t: ConnectionsTranslate;
  readonly openId: string | undefined;
  readonly onOpen: (id: string) => void;
  readonly onReconnect: (connection: ConnectionInfo) => void;
}) {
  const { Badge, Button } = useNc();
  if (controller.connections.length === 0) return <p>{t('empty')}</p>;
  return (
    <div className="nc-conn-scroll">
      <table className="nc-conn-table">
        <caption>{t('listCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('colName')}</th>
            <th scope="col">{t('colServer')}</th>
            <th scope="col">{t('colState')}</th>
            <th scope="col">{t('colOwner')}</th>
            <th scope="col">{t('colMyCredential')}</th>
            <th scope="col">{t('colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {controller.connections.map((connection) => {
            const name = escapeInvisible(connection.name);
            return (
              <tr key={connection.id} data-open={connection.id === openId ? 'true' : undefined}>
                <th scope="row">
                  <Button
                    type="button"
                    variant="link"
                    aria-label={t('open', { name })}
                    onClick={() => {
                      onOpen(connection.id);
                    }}
                  >
                    {name}
                  </Button>
                </th>
                <td>
                  <code className="nc-conn-url">{escapeInvisible(connection.url)}</code>
                  <span className="nc-conn-meta">
                    {t('transport', { transport: escapeInvisible(connection.transport) })}
                  </span>
                </td>
                <td>
                  <Badge variant={stateVariant(connection.state)}>{stateText(connection, t)}</Badge>
                </td>
                <td>{ownerText(connection, t)}</td>
                <td>{myLinkSummary(controller, connection, t)}</td>
                <td>
                  {/* Offered in the list only where the credential is not in use; the open registration offers the rest. */}
                  {reconnectOf(controller, connection)?.attention === true ? (
                    <Button
                      type="button"
                      variant="secondary"
                      loading={controller.pending.has(connection.id)}
                      aria-label={t('reconnectNamed', { name })}
                      onClick={() => {
                        onReconnect(connection);
                      }}
                    >
                      {t('reconnect')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The form to register a server, as its own component. */
export function AddConnection({ components, className, ...props }: AddConnectionProps) {
  const t = createConnectionsTranslate(props.labels);
  return (
    <WithComponents components={components}>
      <div className={['nc-root', 'nc-connections-add', className].filter(Boolean).join(' ')}>
        {registrationOffered(props.controller) ? (
          <AddConnectionForm
            key={props.initial?.id ?? ''}
            {...props}
            t={t}
            onCancel={props.onCancel}
          />
        ) : null}
      </div>
    </WithComponents>
  );
}

/**
 * Checks the URL the way the form refuses one: an absolute https URL (or http to this machine) with no credential in
 * it.
 */
function urlProblem(url: string, t: ConnectionsTranslate): string | undefined {
  if (!isWebUrl(url)) return t('urlInvalid');
  const parsed = new URL(url);
  if (parsed.username !== '' || parsed.password !== '') return t('urlHasCredential');
  return undefined;
}

function AddConnectionForm({
  controller,
  t,
  onSignIn,
  onCreated,
  onOpen,
  onCancel,
  initial,
}: {
  readonly controller: ConnectionsController;
  readonly t: ConnectionsTranslate;
  readonly onSignIn?: (() => void) | undefined;
  readonly onCreated?: ((connection: ConnectionInfo) => void) | undefined;
  readonly onOpen?: ((id: string) => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly initial?: ConnectionPreset | undefined;
}) {
  const { Button, Input, Select } = useNc();
  const headingId = useId();
  const owners = ownerKindsOf(controller);
  const transports = transportsOf(controller);
  const userLinks = controller.facts?.userLinks === true;
  const oauthOffered = controller.facts?.oauth === true;
  const administrator = !controller.administration.readOnly;
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  // A preset's transport only where it is served; its kind of authentication is checked against what is offered below.
  const [transport, setTransport] = useState(
    initial?.transport !== undefined && transports.includes(initial.transport)
      ? initial.transport
      : (transports[0] ?? 'mcp')
  );
  const [ownerKind, setOwnerKind] = useState(owners.includes('org') ? 'org' : (owners[0] ?? 'org'));
  const [chosenAuth, setAuthKind] = useState(initial?.authKind ?? 'none');
  const [scopes, setScopes] = useState((initial?.oauth?.scopes ?? []).join(' '));
  const [issuer, setIssuer] = useState(initial?.oauth?.issuer ?? '');
  const [clientId, setClientId] = useState(initial?.oauth?.clientId ?? '');
  const [tier, setTier] = useState('');
  const [orgCredential, setOrgCredential] = useState('');
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<ConnectionsError | undefined>(undefined);
  const sending = controller.pending.has('new');
  /** The registration a 409 `connection_exists` named, when the caller may read it. */
  const existing = failure?.kind === 'conflict' ? failure.connectionId : undefined;

  // A bearer server under the organisation tier needs the organisation credential, which only an administrator
  // sets: a caller known not to be one is not offered that combination. OAuth only where the round trip runs.
  const bearerOffered = administrator || userLinks;
  const authKinds = [
    'none',
    ...(bearerOffered ? ['bearer'] : []),
    ...(oauthOffered ? ['oauth'] : []),
  ];
  // A choice that is no longer offered (the caller turned out not to be an administrator) reads as none.
  const authKind = authKinds.includes(chosenAuth) ? chosenAuth : 'none';
  // The tier is an administrator's, and only for a server that authenticates: it is sent only while it is shown.
  const tierShown = administrator && authKind !== 'none';
  const sentTier = tierShown ? tier : '';
  const effectiveTier = sentTier !== '' ? sentTier : userLinks ? 'per_user' : 'org_shared';
  const needsOrgCredential =
    administrator && effectiveTier === 'org_shared' && authKind === 'bearer';

  const submit = async (): Promise<void> => {
    const found: Record<string, string> = {};
    if (name.trim() === '') found.name = t('nameRequired');
    const bad = urlProblem(url.trim(), t);
    if (bad !== undefined) found.url = bad;
    if (needsOrgCredential && orgCredential === '')
      found.orgCredential = t('orgCredentialRequired');
    setProblems(found);
    setFailure(undefined);
    if (Object.keys(found).length > 0) return;
    const scopeList = scopes.split(/\s+/).filter((s) => s !== '');
    // The credential leaves the form as it is sent: it is never kept, and never in the page while the request runs.
    const credential = orgCredential;
    setOrgCredential('');
    const result = await controller.create({
      name: name.trim(),
      url: url.trim(),
      transport,
      ownerKind,
      authKind,
      ...(authKind === 'oauth'
        ? {
            oauth: {
              ...(scopeList.length === 0 ? {} : { scopes: scopeList }),
              ...(issuer.trim() === '' ? {} : { issuer: issuer.trim() }),
              ...(clientId.trim() === '' ? {} : { clientId: clientId.trim() }),
            },
          }
        : {}),
      ...(sentTier === '' ? {} : { credentialTier: sentTier }),
      ...(needsOrgCredential ? { orgCredential: credential } : {}),
    });
    if (result.ok) {
      setName('');
      setUrl('');
      onCreated?.(result.connection);
    } else setFailure(result.error);
  };

  return (
    <form
      className="nc-conn-form"
      aria-labelledby={headingId}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h3 id={headingId}>{t('addHeading')}</h3>
      {/* A preset's kind of authentication this service or caller is not offered: said, never silently dropped. */}
      {initial?.authKind === undefined ||
      authKinds.includes(initial.authKind) ||
      chosenAuth !== initial.authKind ? null : (
        <p className="nc-conn-note" role="status">
          {t('presetAuthNotOffered', { auth: authText(initial.authKind, t) })}
        </p>
      )}
      <Input
        label={t('fieldName')}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
        required
        {...(problems.name === undefined ? {} : { error: problems.name })}
      />
      <Input
        label={t('fieldUrl')}
        type="url"
        inputMode="url"
        autoComplete="off"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
        }}
        required
        aria-describedby={`${headingId}-url-hint`}
        {...(problems.url === undefined ? {} : { error: problems.url })}
      />
      <p id={`${headingId}-url-hint`} className="nc-muted">
        {t('fieldUrlHint')}
      </p>
      {transports.length > 1 ? (
        <label className="nc-conn-field">
          <span>{t('fieldTransport')}</span>
          <Select
            value={transport}
            onValueChange={setTransport}
            options={transports.map((value) => ({ value, label: value }))}
          />
        </label>
      ) : null}
      {owners.length > 1 ? (
        <label className="nc-conn-field">
          <span>{t('fieldOwner')}</span>
          <Select
            value={ownerKind}
            onValueChange={setOwnerKind}
            options={owners.map((value) => ({
              value,
              label: value === 'org' ? t('ownerOptionOrg') : t('ownerOptionPrincipal'),
            }))}
          />
        </label>
      ) : null}
      <label className="nc-conn-field">
        <span>{t('fieldAuth')}</span>
        <Select
          value={authKind}
          onValueChange={setAuthKind}
          options={authKinds.map((value) => ({ value, label: authText(value, t) }))}
        />
      </label>
      {authKind !== 'oauth' ? null : (
        <fieldset className="nc-conn-fieldset">
          <Input
            label={t('fieldScopes')}
            value={scopes}
            onChange={(e) => {
              setScopes(e.target.value);
            }}
          />
          <Input
            label={t('fieldIssuer')}
            type="url"
            value={issuer}
            onChange={(e) => {
              setIssuer(e.target.value);
            }}
          />
          <Input
            label={t('fieldClientId')}
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
            }}
          />
        </fieldset>
      )}
      {!tierShown ? null : (
        <label className="nc-conn-field">
          <span>{t('fieldTier')}</span>
          <Select
            value={tier}
            onValueChange={setTier}
            options={[
              { value: '', label: t('tierDefault') },
              ...(userLinks ? [{ value: 'per_user', label: t('tier_per_user') }] : []),
              { value: 'org_shared', label: t('tier_org_shared') },
            ]}
          />
        </label>
      )}
      {!needsOrgCredential ? null : (
        <Input
          label={t('fieldOrgCredential')}
          type="password"
          autoComplete="off"
          value={orgCredential}
          onChange={(e) => {
            setOrgCredential(e.target.value);
          }}
          aria-describedby={`${headingId}-org-hint`}
          {...(problems.orgCredential === undefined ? {} : { error: problems.orgCredential })}
        />
      )}
      {!needsOrgCredential ? null : (
        <p id={`${headingId}-org-hint`} className="nc-muted">
          {t('fieldOrgCredentialHint')}
        </p>
      )}
      {failure === undefined ? null : (
        <ConnectionsErrorAlert error={failure} t={t} context="admin" onSignIn={onSignIn}>
          {existing !== undefined && onOpen !== undefined ? (
            <Button
              type="button"
              variant="link"
              onClick={() => {
                onOpen(existing);
              }}
            >
              {t('existsOpen')}
            </Button>
          ) : null}
        </ConnectionsErrorAlert>
      )}
      <div className="nc-conn-actions">
        <Button type="submit" loading={sending}>
          {sending ? t('submitting') : t('submitAdd')}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('addCancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/** One registration: its facts, its tools, the changes the caller may make and the caller's own credential. */
export function ConnectionDetail({
  components,
  connectionId,
  className,
  controller,
  labels,
  onSignIn,
  onMessage,
}: ConnectionDetailProps) {
  const t = createConnectionsTranslate(labels);
  const connection = controller.connections.find((c) => c.id === connectionId);
  return (
    <WithComponents components={components}>
      <div className={['nc-root', 'nc-connections-detail', className].filter(Boolean).join(' ')}>
        {connection === undefined ? (
          <p role="status">{t('errorNotFound')}</p>
        ) : (
          <ConnectionDetailView
            controller={controller}
            connection={connection}
            t={t}
            onSignIn={onSignIn}
            onMessage={onMessage}
          />
        )}
      </div>
    </WithComponents>
  );
}

function ConnectionDetailView({
  controller,
  connection,
  t,
  onSignIn,
  onMessage,
}: {
  readonly controller: ConnectionsController;
  readonly connection: ConnectionInfo;
  readonly t: ConnectionsTranslate;
  readonly onSignIn?: (() => void) | undefined;
  readonly onMessage?: ((message: string) => void) | undefined;
}) {
  const { Badge } = useNc();
  const headingId = useId();
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const name = escapeInvisible(connection.name);
  const report = (message: string): void => {
    setFailure(undefined);
    onMessage?.(message);
  };
  const fail = (error: ConnectionsError, context: ErrorContext): void => {
    setFailure({ error, context });
  };
  return (
    <section className="nc-conn-detail" aria-labelledby={headingId}>
      <h3 id={headingId}>{t('detailHeading', { name })}</h3>
      <dl className="nc-conn-facts">
        <div>
          <dt>{t('colServer')}</dt>
          <dd>
            <code className="nc-conn-url">{escapeInvisible(connection.url)}</code>
          </dd>
        </div>
        <div>
          <dt>{t('fieldTransport')}</dt>
          <dd>{escapeInvisible(connection.transport)}</dd>
        </div>
        <div>
          <dt>{t('colState')}</dt>
          <dd>
            <Badge variant={stateVariant(connection.state)}>{stateText(connection, t)}</Badge>
            {connection.stateDetail === undefined
              ? null
              : ` ${t('stateDetail', { detail: escapeInvisible(connection.stateDetail) })}`}
            {connection.lastVerifiedAt === undefined ? null : (
              <span className="nc-conn-meta">
                {connection.lastVerifiedAt === null
                  ? t('neverVerified')
                  : t('lastVerified', { date: dateText(connection.lastVerifiedAt) })}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('fieldAuth')}</dt>
          <dd>{authText(connection.authKind, t)}</dd>
        </div>
        <div>
          <dt>{t('fieldTier')}</dt>
          <dd>{tierText(connection.credentialTier, t)}</dd>
        </div>
        <div>
          <dt>{t('colOwner')}</dt>
          <dd>{ownerText(connection, t)}</dd>
        </div>
        <div>
          <dt>{t('registeredAt')}</dt>
          <dd>{dateText(connection.createdAt)}</dd>
        </div>
      </dl>
      {failure === undefined ? null : (
        <ConnectionsErrorAlert
          error={failure.error}
          t={t}
          context={failure.context}
          onSignIn={onSignIn}
        />
      )}
      {changeOffered(controller, connection) ? (
        <ChangeActions
          controller={controller}
          connection={connection}
          t={t}
          onDone={report}
          onFail={fail}
        />
      ) : null}
      <MyCredential
        controller={controller}
        connection={connection}
        t={t}
        onDone={report}
        onFail={fail}
      />
      <Tools controller={controller} connection={connection} t={t} onSignIn={onSignIn} />
    </section>
  );
}

interface ActionProps {
  readonly controller: ConnectionsController;
  readonly connection: ConnectionInfo;
  readonly t: ConnectionsTranslate;
  readonly onDone: (message: string) => void;
  readonly onFail: (error: ConnectionsError, context: ErrorContext) => void;
}

/** Rename, refresh, delete, and the organisation credential: the owner's changes (the organisation's administrators'). */
function ChangeActions({ controller, connection, t, onDone, onFail }: ActionProps) {
  const { Button, ConfirmDialog, Input } = useNc();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(connection.name);
  const [rotating, setRotating] = useState(false);
  const [credential, setCredential] = useState('');
  const [confirming, setConfirming] = useState(false);
  const busy = controller.pending.has(connection.id);
  const name = escapeInvisible(connection.name);
  const orgShared = connection.credentialTier === 'org_shared';
  // The organisation credential is an administrator's, whoever owns the registration.
  const administrator = !controller.administration.readOnly;
  const authorizeOrg =
    administrator &&
    orgShared &&
    connection.authKind === 'oauth' &&
    controller.facts?.oauth === true &&
    // Rev 11: a `connected` one is authorized again (consent again, or a new credential); it stays in use meanwhile.
    (connection.state === 'pending_authorization' ||
      connection.state === 'degraded' ||
      connection.state === 'connected');

  const refresh = async (): Promise<void> => {
    const result = await controller.refresh(connection.id);
    if (!result.ok) {
      onFail(result.error, 'admin');
      return;
    }
    const { counts } = result;
    onDone(
      counts.emptyUpstreamSuppressed
        ? t('refreshSuppressed')
        : t('refreshed', {
            count: counts.toolCount,
            added: counts.added,
            removed: counts.removed,
            reactivated: counts.reactivated,
          })
    );
  };

  return (
    <section className="nc-conn-change">
      <div className="nc-conn-actions">
        <Button type="button" variant="secondary" loading={busy} onClick={() => void refresh()}>
          {busy ? t('refreshing') : t('refresh')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setNewName(connection.name);
            setRenaming(!renaming);
          }}
        >
          {t('rename')}
        </Button>
        {authorizeOrg ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void controller.authorize(connection.id).then((r) => {
                if (!r.ok) onFail(r.error, 'admin');
              })
            }
          >
            {connection.state === 'pending_authorization' ? t('authorizeOrg') : t('reauthorizeOrg')}
          </Button>
        ) : null}
        {administrator && orgShared && connection.authKind === 'bearer' ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setRotating(!rotating);
            }}
          >
            {t('rotate')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          onClick={() => {
            setConfirming(true);
          }}
        >
          {t('remove')}
        </Button>
      </div>
      {!renaming ? null : (
        <form
          className="nc-conn-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim() === '') return;
            void controller.rename(connection.id, newName.trim()).then((r) => {
              if (r.ok) {
                setRenaming(false);
                onDone(t('renamed', { name: escapeInvisible(r.connection.name) }));
              } else onFail(r.error, 'admin');
            });
          }}
        >
          <Input
            label={t('renameField')}
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
            }}
          />
          <Button type="submit" disabled={busy}>
            {t('renameSave')}
          </Button>
        </form>
      )}
      {!rotating ? null : (
        <form
          className="nc-conn-inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (credential === '') return;
            const token = credential;
            // The credential leaves the form as it is sent: it is never kept or shown again.
            setCredential('');
            void controller.rotateOrgCredential(connection.id, token).then((r) => {
              if (r.ok) {
                setRotating(false);
                onDone(t('rotated', { name }));
              } else onFail(r.error, 'admin');
            });
          }}
        >
          <Input
            label={t('rotateField')}
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => {
              setCredential(e.target.value);
            }}
          />
          <Button type="submit" disabled={busy}>
            {t('rotateSave')}
          </Button>
        </form>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('removeTitle', { name })}
        description={t('removeText')}
        confirmLabel={t('removeConfirm')}
        cancelLabel={t('removeCancel')}
        variant="destructive"
        onConfirm={async () => {
          const r = await controller.remove(connection.id);
          if (r.ok) onDone(t('removed', { name }));
          else onFail(r.error, 'admin');
        }}
      />
    </section>
  );
}

/** The caller's own credential link: link with consent, authorize, unlink, revoke consent. Never another user's. */
function MyCredential({ controller, connection, t, onDone, onFail }: ActionProps) {
  const { Button, Checkbox, ConfirmDialog, Input } = useNc();
  const headingId = useId();
  const consentId = useId();
  const [step, setStep] = useState<'idle' | 'consent'>('idle');
  const [agreed, setAgreed] = useState(false);
  const [token, setToken] = useState('');
  const [confirm, setConfirm] = useState<'unlink' | 'revoke' | undefined>(undefined);
  const busy = controller.pending.has(connection.id);
  const name = escapeInvisible(connection.name);

  if (controller.facts?.userLinks !== true) return null;
  if (!takesLink(connection)) {
    return connection.credentialTier === 'org_shared' ? (
      <section className="nc-conn-mine" aria-labelledby={headingId}>
        <h4 id={headingId}>{t('myHeading')}</h4>
        <p>{t('myNotTaken')}</p>
      </section>
    ) : null;
  }

  const link = connection.myLink ?? { status: 'none', consent: 'none' };
  const hasLink = link.status !== 'none';
  const consented = link.consent === 'given';
  const bearer = connection.authKind === 'bearer';
  const oauth = connection.authKind === 'oauth';
  // A first bearer link needs the token; a later one keeps the stored token unless a new one is typed.
  const needsToken = bearer && !hasLink;

  let state: string;
  if (!hasLink) state = t('myNone');
  else if (!consented)
    state =
      link.consent === 'revoked'
        ? t('myConsentRevoked')
        : t('myConsentUnknown', { consent: escapeInvisible(link.consent) });
  else if (link.status === 'linked')
    state = t('myLinked', {
      since:
        link.linkedAt === undefined ? '' : t('myLinkedSince', { date: dateText(link.linkedAt) }),
    });
  else if (link.status === 'pending_authorization') state = t('myPending');
  else if (link.status === 'degraded') state = t('myDegraded');
  else state = t('myStateUnknown', { state: escapeInvisible(link.status) });

  const authorize = async (): Promise<void> => {
    const r = await controller.authorize(connection.id);
    if (!r.ok) onFail(r.error, 'own');
  };

  const sendLink = async (): Promise<void> => {
    const sent = token;
    // The token leaves the form as it is sent: it is never kept or shown again.
    setToken('');
    const r = await controller.link(connection.id, {
      consent: true,
      ...(bearer && sent !== '' ? { token: sent } : {}),
    });
    setStep('idle');
    setAgreed(false);
    if (!r.ok) {
      onFail(r.error, 'own');
      return;
    }
    const after = r.connection.myLink;
    // An OAuth link is authorized next, in the same act: the consent was just given for it.
    if (oauth && after?.status !== 'linked' && controller.facts?.oauth === true) {
      await authorize();
      return;
    }
    onDone(t('linked', { name }));
  };

  // OAuth links need the round trip; without it there is nothing the caller can complete here.
  const canLink = bearer || (oauth && controller.facts.oauth);
  const offerLink = canLink && (!hasLink || link.status === 'degraded' || (bearer && consented));
  const offerConsentAgain = hasLink && !consented;
  // Rev 11: a `linked` link is authorized again (consent again, or a new credential); it stays in use meanwhile.
  const offerAuthorize =
    oauth &&
    controller.facts.oauth &&
    hasLink &&
    consented &&
    (link.status === 'pending_authorization' ||
      link.status === 'degraded' ||
      link.status === 'linked');

  return (
    <section className="nc-conn-mine" aria-labelledby={headingId}>
      <h4 id={headingId}>{t('myHeading')}</h4>
      <p data-testid="nc-conn-my-state">{state}</p>
      <p className="nc-muted">{t('myOthers')}</p>
      {step === 'consent' ? (
        <form
          className="nc-conn-consent"
          aria-labelledby={consentId}
          onSubmit={(e) => {
            e.preventDefault();
            if (!agreed || (needsToken && token === '')) return;
            void sendLink();
          }}
        >
          <h4 id={consentId}>{t('consentHeading')}</h4>
          <p>{t('consentText', { name })}</p>
          {bearer ? (
            <>
              <Input
                label={hasLink ? t('linkTokenReplace') : t('linkToken')}
                type="password"
                autoComplete="off"
                value={token}
                required={needsToken}
                onChange={(e) => {
                  setToken(e.target.value);
                }}
              />
              <p className="nc-muted">{t('linkTokenHint')}</p>
            </>
          ) : null}
          <label className="nc-conn-check">
            <Checkbox checked={agreed} onCheckedChange={setAgreed} />
            <span>{t('consentCheck')}</span>
          </label>
          <div className="nc-conn-actions">
            <Button type="submit" disabled={!agreed || (needsToken && token === '') || busy}>
              {oauth ? t('consentContinueOauth') : t('consentContinue')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep('idle');
                setAgreed(false);
                setToken('');
              }}
            >
              {t('consentCancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="nc-conn-actions">
          {offerLink ? (
            <Button
              type="button"
              onClick={() => {
                setStep('consent');
              }}
            >
              {hasLink ? (bearer ? t('linkTokenReplace') : t('linkAgain')) : t('link')}
            </Button>
          ) : null}
          {offerConsentAgain ? (
            <Button
              type="button"
              onClick={() => {
                setStep('consent');
              }}
            >
              {t('consentGiveAgain')}
            </Button>
          ) : null}
          {offerAuthorize ? (
            <Button
              type="button"
              variant={link.status === 'linked' ? 'secondary' : 'primary'}
              loading={busy}
              onClick={() => void authorize()}
            >
              {link.status === 'pending_authorization' ? t('authorizeMine') : t('reauthorizeMine')}
            </Button>
          ) : null}
          {hasLink && consented ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirm('revoke');
              }}
            >
              {t('revokeConsent')}
            </Button>
          ) : null}
          {hasLink ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setConfirm('unlink');
              }}
            >
              {t('unlink')}
            </Button>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={confirm !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirm(undefined);
        }}
        title={confirm === 'revoke' ? t('revokeTitle', { name }) : t('unlinkTitle', { name })}
        description={confirm === 'revoke' ? t('revokeText') : t('unlinkText')}
        confirmLabel={confirm === 'revoke' ? t('revokeConfirm') : t('unlinkConfirm')}
        cancelLabel={confirm === 'revoke' ? t('revokeCancel') : t('unlinkCancel')}
        onConfirm={async () => {
          const revoking = confirm === 'revoke';
          const r = revoking
            ? await controller.revokeConsent(connection.id)
            : await controller.unlink(connection.id);
          if (r.ok) onDone(revoking ? t('revoked', { name }) : t('unlinked', { name }));
          else onFail(r.error, 'own');
        }}
      />
    </section>
  );
}

/** The registered tools, and what the server offers now once asked; withdrawn tools stay listed with their standing. */
function Tools({
  controller,
  connection,
  t,
  onSignIn,
}: {
  readonly controller: ConnectionsController;
  readonly connection: ConnectionInfo;
  readonly t: ConnectionsTranslate;
  readonly onSignIn?: (() => void) | undefined;
}) {
  const { Badge, Button } = useNc();
  const headingId = useId();
  const view = useConnection(controller, connection.id);
  const name = escapeInvisible(connection.name);
  let body: ReactNode;
  if (view.status === 'idle' || view.status === 'loading') body = <p>{t('toolsLoading')}</p>;
  else if (view.status === 'error')
    body =
      view.error === undefined ? (
        <p role="alert">{t('toolsFailed')}</p>
      ) : (
        <ConnectionsErrorAlert error={view.error} t={t} onSignIn={onSignIn}>
          <p>{t('toolsFailed')}</p>
        </ConnectionsErrorAlert>
      );
  else if (view.rows.length === 0) body = <p>{t('toolsEmpty')}</p>;
  else
    body = (
      <div className="nc-conn-scroll">
        <table className="nc-conn-table">
          <caption>{t('toolsCaption', { name })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('colTool')}</th>
              <th scope="col">{t('colDescription')}</th>
              <th scope="col">{t('colLevel')}</th>
              <th scope="col">{t('colStanding')}</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => {
              const tool = row.registered ?? row.offered;
              return (
                <tr key={row.toolRef} data-standing={row.standing}>
                  <th scope="row">
                    <code>{escapeInvisible(row.toolRef)}</code>
                  </th>
                  <td>{escapeInvisible(tool?.description ?? '')}</td>
                  <td>{escapeInvisible(tool?.sideEffectLevel ?? '')}</td>
                  <td>
                    <Badge variant={row.standing === 'registered' ? 'neutral' : 'outline'}>
                      {row.standing === 'unknown_status'
                        ? t('standing_unknown_status', {
                            status: escapeInvisible(row.registered?.status ?? ''),
                          })
                        : t(`standing_${row.standing}`)}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  return (
    <section className="nc-conn-tools" aria-labelledby={headingId}>
      <h4 id={headingId}>{t('toolsHeading')}</h4>
      {body}
      <div className="nc-conn-actions">
        <Button
          type="button"
          variant="secondary"
          loading={view.discovery.status === 'loading'}
          onClick={() => void view.discover()}
        >
          {view.discovery.status === 'loading' ? t('discovering') : t('discover')}
        </Button>
      </div>
      <p className="nc-muted">{t('discoverNote')}</p>
      {view.discovery.status === 'error' && view.discovery.error !== undefined ? (
        <ConnectionsErrorAlert error={view.discovery.error} t={t} onSignIn={onSignIn}>
          <p>{t('discoverFailed')}</p>
        </ConnectionsErrorAlert>
      ) : null}
    </section>
  );
}
