import { useId, useState } from 'react';

import type {
  ConsideredEntry,
  PoliciesController,
  PolicySubject,
  SimulationResult,
} from '../permissions-types.js';
import { usePolicySimulate } from '../use-policy-simulate.js';
import { escapeInvisible } from './format-json.js';
import { createPermissionsTranslate } from './permissions-labels.js';
import type { PermissionsLabels, PermissionsTranslate } from './permissions-labels.js';
import {
  PermissionsErrorAlert,
  policyName,
  subjectTextWith,
  toolRefLabel,
} from './permissions-parts.js';
import type { SubjectLabel } from './permissions-parts.js';
import { useNc, WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

export interface PolicySimulationProps {
  /** What `usePolicies` returns. */
  readonly controller: PoliciesController;
  readonly policyId: string;
  readonly className?: string;
  readonly labels?: PermissionsLabels;
  readonly components?: ModuleComponents;
  readonly onSignIn?: () => void;
  /** As `PermissionsProps.subjectLabel`: a display name beside the subject of each considered entry. */
  readonly subjectLabel?: SubjectLabel;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A dry run of one policy for the caller: a tool, an optional agent id, a run id where runs are offered, and the
 * call's arguments. It shows the decision and what the service considered, as the service listed it: no entry is
 * marked as winning, overridden or not reached, since the contract states no precedence. A simulation answers only
 * for the caller's own identity, which the heading says.
 */
export function PolicySimulation({ components, ...props }: PolicySimulationProps) {
  return (
    <WithComponents components={components}>
      <SimulationView {...props} />
    </WithComponents>
  );
}

function SimulationView({
  controller,
  policyId,
  className,
  labels,
  onSignIn,
  subjectLabel,
}: Omit<PolicySimulationProps, 'components'>) {
  const t = createPermissionsTranslate(labels);
  const subjectText = subjectTextWith(t, subjectLabel);
  const { Button, Input, Label, Select, Textarea } = useNc();
  const simulation = usePolicySimulate(controller, policyId);
  const ids = { heading: useId(), tool: useId(), agent: useId(), run: useId(), args: useId() };
  // The tools of the version simulated: a draft the store knows first (its targets may differ from the published
  // version's), else the listed policy.
  const policy =
    controller.drafts.find((d) => d.policyId === policyId)?.policy ??
    controller.policies.find((p) => p.id === policyId);
  const toolRefs =
    policy?.targets === undefined || policy.targets === 'all'
      ? controller.tools.map((tool) => tool.toolRef)
      : [...policy.targets];
  const [tool, setTool] = useState<string>(toolRefs[0] ?? '');
  const [agent, setAgent] = useState('');
  const [run, setRun] = useState('');
  const [args, setArgs] = useState('{}');
  const [argsInvalid, setArgsInvalid] = useState(false);
  const chosenTool = toolRefs.includes(tool) ? tool : (toolRefs[0] ?? '');

  const submit = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args === '' ? '{}' : args);
    } catch {
      parsed = undefined;
    }
    if (!isPlainObject(parsed)) {
      setArgsInvalid(true);
      return;
    }
    setArgsInvalid(false);
    void simulation.run({
      toolRef: chosenTool,
      arguments: parsed,
      ...(agent === '' ? {} : { agentId: agent }),
      ...(run === '' || !simulation.runsOffered ? {} : { runId: run }),
    });
  };

  return (
    <section
      className={['nc-root', 'nc-permissions-simulation', className].filter(Boolean).join(' ')}
      aria-labelledby={ids.heading}
    >
      <h3 id={ids.heading}>{t('simHeading')}</h3>
      <p className="nc-muted">{t('simExplain')}</p>
      <form
        className="nc-perm-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Label htmlFor={ids.tool}>{t('simTool')}</Label>
        <Select
          id={ids.tool}
          value={chosenTool}
          onValueChange={setTool}
          options={toolRefs.map((ref) => ({
            value: ref,
            // A tool that is not callable is still simulated; its decision is a deny.
            label: toolRefLabel(ref, controller.tools, t),
          }))}
        />
        <Label htmlFor={ids.agent}>{t('simAgent')}</Label>
        <Input
          id={ids.agent}
          value={agent}
          onChange={(event) => {
            setAgent(event.currentTarget.value);
          }}
        />
        {simulation.runsOffered ? (
          <>
            <Label htmlFor={ids.run}>{t('simRun')}</Label>
            <Input
              id={ids.run}
              value={run}
              onChange={(event) => {
                setRun(event.currentTarget.value);
              }}
            />
          </>
        ) : null}
        <Label htmlFor={ids.args}>{t('simArguments')}</Label>
        <Textarea
          id={ids.args}
          value={args}
          aria-invalid={argsInvalid}
          onChange={(event) => {
            setArgs(event.currentTarget.value);
          }}
        />
        {argsInvalid ? <p role="alert">{t('simArgumentsInvalid')}</p> : null}
        {toolRefs.length === 0 ? <p className="nc-muted">{t('simNoTools')}</p> : null}
        <Button
          type="submit"
          variant="secondary"
          disabled={simulation.status === 'running' || chosenTool === ''}
        >
          {simulation.status === 'running' ? t('simRunning') : t('simSubmit')}
        </Button>
      </form>
      {simulation.status === 'error' && simulation.error !== undefined ? (
        <PermissionsErrorAlert error={simulation.error} t={t} onSignIn={onSignIn} />
      ) : null}
      {simulation.result !== undefined && simulation.status !== 'error' ? (
        <SimulationOutput
          result={simulation.result}
          version={simulation.draftVersion}
          controller={controller}
          t={t}
          subjectText={subjectText}
        />
      ) : null}
    </section>
  );
}

function SimulationOutput({
  result,
  version,
  controller,
  t,
  subjectText,
}: {
  readonly result: SimulationResult;
  readonly version: number | undefined;
  readonly controller: PoliciesController;
  readonly t: PermissionsTranslate;
  readonly subjectText: (subject: PolicySubject) => string;
}) {
  // The Rule column appears where the service lists `rules` among the members it enforces, or says in this answer that
  // a rule decided or a fact was missing: on a deployment with neither the table is the one it always was.
  const showRule =
    controller.facts?.policyForms?.toolInvocation?.configMembers.includes('rules') === true ||
    (result.considered?.policies.some(
      (entry) => entry.rule !== undefined || entry.missingFacts !== undefined
    ) ??
      false);
  const deciding =
    result.policy === undefined
      ? undefined
      : (controller.policies.find((p) => p.id === result.policy?.id) ?? {
          id: result.policy.id,
        });
  return (
    <div className="nc-perm-result" aria-live="polite">
      {version === undefined ? null : <p>{t('simVersion', { version })}</p>}
      <p>
        <strong>{t('simDecision', { decision: escapeInvisible(result.decision) })}</strong>
      </p>
      {result.reason === undefined ? null : (
        <p>{t('simReason', { reason: escapeInvisible(result.reason) })}</p>
      )}
      {result.rejectedApprovalId === undefined ? null : (
        <p>{t('simRejected', { id: escapeInvisible(result.rejectedApprovalId) })}</p>
      )}
      {result.enforced ? null : <p>{t('simDryRun')}</p>}
      {result.wouldBe !== undefined && result.wouldBe !== result.decision ? (
        <p>{t('simWouldBe', { decision: escapeInvisible(result.wouldBe) })}</p>
      ) : null}
      {result.policy === undefined || deciding === undefined ? (
        <p>{t('simDefault')}</p>
      ) : (
        <p>{t('simPolicy', { name: policyName(deciding, t), version: result.policy.version })}</p>
      )}
      {result.appliesToCaller === false ? <p>{t('simNotApplies')}</p> : null}
      {result.missingFacts === undefined || result.missingFacts.length === 0 ? null : (
        <p>
          {t('simMissingTop', {
            facts: result.missingFacts.map((fact) => escapeInvisible(fact)).join(', '),
          })}
        </p>
      )}
      <h4>{t('simConsideredHeading')}</h4>
      {result.considered === undefined ? (
        <p className="nc-muted">{t('simConsideredNone')}</p>
      ) : (
        <>
          <table className="nc-perm-table">
            <thead>
              <tr>
                <th scope="col">{t('simColKind')}</th>
                <th scope="col">{t('simColPolicy')}</th>
                <th scope="col">{t('simColVersion')}</th>
                <th scope="col">{t('simColSubject')}</th>
                <th scope="col">{t('simColResult')}</th>
                {showRule ? <th scope="col">{t('simColRule')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {result.considered.policies.map((entry, index) => (
                <ConsideredRow
                  key={index}
                  entry={entry}
                  t={t}
                  subjectText={subjectText}
                  showRule={showRule}
                />
              ))}
            </tbody>
          </table>
          <p>
            {result.considered.composed.reason === undefined
              ? t('simComposed', { decision: escapeInvisible(result.considered.composed.decision) })
              : t('simComposedReason', {
                  decision: escapeInvisible(result.considered.composed.decision),
                  reason: escapeInvisible(result.considered.composed.reason),
                })}
          </p>
        </>
      )}
    </div>
  );
}

/** What decided a considered policy: the rule, the facts a rule needed, or (for a policy with a rule column) its mode. */
function ruleCell(entry: ConsideredEntry, t: PermissionsTranslate): string {
  if (entry.rule !== undefined) {
    const known = Object.hasOwn({ always_allow: true, ask: true, deny: true }, entry.rule.then);
    return t('simRuleDecided', {
      n: entry.rule.index + 1,
      outcome: known
        ? t(`ruleOutcome_${entry.rule.then as 'always_allow' | 'ask' | 'deny'}`)
        : escapeInvisible(entry.rule.then),
    });
  }
  if (entry.missingFacts !== undefined && entry.missingFacts.length > 0)
    return t('simMissingFacts', {
      facts: entry.missingFacts.map((fact) => escapeInvisible(fact)).join(', '),
    });
  return entry.id !== null && entry.kind === 'tool_invocation' ? t('simRuleNone') : '';
}

function ConsideredRow({
  entry,
  t,
  subjectText,
  showRule,
}: {
  readonly entry: ConsideredEntry;
  readonly t: PermissionsTranslate;
  readonly subjectText: (subject: PolicySubject) => string;
  readonly showRule: boolean;
}) {
  return (
    <tr>
      <td>{escapeInvisible(entry.kind)}</td>
      <td>
        {entry.id === null
          ? t('simDefaultEntry', { source: escapeInvisible(entry.source ?? '') })
          : policyName({ name: entry.name, id: entry.id }, t)}
      </td>
      <td>{entry.version === null ? '' : `v${String(entry.version)}`}</td>
      <td>{entry.subject === undefined ? '' : subjectText(entry.subject)}</td>
      <td>{escapeInvisible(entry.result)}</td>
      {showRule ? <td>{ruleCell(entry, t)}</td> : null}
    </tr>
  );
}
