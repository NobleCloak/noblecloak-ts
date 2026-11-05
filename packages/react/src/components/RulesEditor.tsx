import { useId, useState } from 'react';

import {
  addRule,
  approverId,
  checkRules,
  factCatalogOf,
  factRefOf,
  isRoleApprover,
  listOf,
  moveAt,
  newCondition,
  newRule,
  opShape,
  opsFor,
  parseScalar,
  parseScalarLines,
  readApprovers,
  readExclude,
  readRules,
  removeAt,
  replaceAt,
  scalarText,
  setRequesterExcluded,
  singleOf,
  withApprover,
  withApproverWhen,
  withFact,
  withOp,
  withOutcome,
  withRuleApprovers,
  withoutValue,
} from '../permissions-rules.js';
import type {
  FactCatalog,
  PolicyApprover,
  PolicyRule,
  RuleCondition,
  RuleProblem,
  RuleWarning,
} from '../permissions-rules.js';
import type {
  PermissionsError,
  PoliciesController,
  PolicyEditorController,
} from '../permissions-types.js';
import { RULE_LIMITS, RULE_OUTCOMES } from '../permissions-vocabulary.js';
import type { RuleOutcome } from '../permissions-vocabulary.js';
import { escapeInvisible } from './format-json.js';
import type { PermissionsTranslate } from './permissions-labels.js';
import { approverSentence, ruleSentence } from './rules-sentence.js';
import { useNc } from './slots.js';

/** The refused member of the last write, by what it names: a rule (and the condition or approver in it), approvers, exclude. */
export interface RuleRefusal {
  /** The path as the contract writes it without the leading `config.`, for example `rules[0].when[1].fact`. */
  readonly path: string;
  readonly detail: string | undefined;
}

/** The `config.`-relative path a refused member names, or `undefined` when it names no rule, approver or exclusion. */
export function refusalOf(error: PermissionsError | undefined): RuleRefusal | undefined {
  if (error?.kind !== 'unprocessable' && error?.kind !== 'invalid_request') return undefined;
  const match = /^config\.((?:rules|approvers|exclude)\b.*)$/.exec(error.member ?? '');
  return match?.[1] === undefined ? undefined : { path: match[1], detail: error.detail };
}

interface SharedProps {
  readonly t: PermissionsTranslate;
  readonly readOnly: boolean;
  readonly catalog: FactCatalog;
  /** The refusals of the contract in the working copy, shown once a save was refused for them. */
  readonly problems: readonly RuleProblem[];
  readonly warnings: readonly RuleWarning[];
  readonly refusal: RuleRefusal | undefined;
}

const problemAt = (problems: readonly RuleProblem[], path: string): RuleProblem | undefined =>
  problems.find((problem) => problem.path === path);

const refusedAt = (refusal: RuleRefusal | undefined, path: string): boolean =>
  refusal !== undefined &&
  (refusal.path === path ||
    refusal.path.startsWith(`${path}.`) ||
    refusal.path.startsWith(`${path}[`));

/** A refusal that names `path` or something inside it other than the `nested` members, which their own rows show. */
const refusedExcept = (
  refusal: RuleRefusal | undefined,
  path: string,
  ...nested: readonly string[]
): boolean =>
  refusedAt(refusal, path) &&
  !nested.some((member) => refusal?.path.startsWith(`${path}${member}`) === true);

function Refused({ shared }: { readonly shared: SharedProps }) {
  return (
    <p className="nc-perm-refused" role="alert">
      {shared.t('ruleRefused', { detail: escapeInvisible(shared.refusal?.detail ?? '') })}
    </p>
  );
}

function Problem({ shared, path }: { readonly shared: SharedProps; readonly path: string }) {
  const found = problemAt(shared.problems, path);
  if (found === undefined) return null;
  return (
    <p className="nc-perm-refused" role="alert">
      {shared.t(`ruleProblem_${found.code}`)}
    </p>
  );
}

function Warnings({ shared, within }: { readonly shared: SharedProps; readonly within: string }) {
  const here = shared.warnings.filter(
    (warning) =>
      warning.path === within ||
      warning.path.startsWith(`${within}[`) ||
      warning.path.startsWith(`${within}.`)
  );
  if (here.length === 0) return null;
  return (
    <ul className="nc-perm-list">
      {here.map((warning) => (
        <li key={`${warning.path}:${warning.code}`} className="nc-muted">
          {shared.t('rulesUnreachableLead')} {shared.t(`ruleWarning_${warning.code}`)}
        </li>
      ))}
    </ul>
  );
}

/** One value of a condition: a text, a number, true or false, or a list one to a line; nothing for `exists`. */
function ValueInput({
  condition,
  type,
  label,
  readOnly,
  t,
  onChange,
}: {
  readonly condition: RuleCondition;
  readonly type: string | undefined;
  readonly label: string;
  readonly readOnly: boolean;
  readonly t: PermissionsTranslate;
  readonly onChange: (next: RuleCondition) => void;
}) {
  const { Input, Select, Textarea } = useNc();
  const shape = opShape(condition.op);
  const [text, setText] = useState<string | undefined>(undefined);
  if (shape === 'none') return null;
  const { value } = condition;
  if (shape === 'list') {
    const items = listOf(value);
    // The text is kept as typed (a trailing line break is how a person starts the next value); it is shown as long as
    // it still reads as the value the rule holds, and the rule's own values once it does not (a move, a reload).
    const parsed = text === undefined ? undefined : parseScalarLines(text, type, condition.op);
    const shown =
      text !== undefined && JSON.stringify(parsed) === JSON.stringify(items)
        ? text
        : items.map((item) => scalarText(item)).join('\n');
    return (
      <Textarea
        aria-label={label}
        aria-describedby={undefined}
        placeholder={t('conditionListHint')}
        readOnly={readOnly}
        value={shown}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          onChange({ ...condition, value: parseScalarLines(next, type, condition.op) });
        }}
      />
    );
  }
  if (type === 'boolean') {
    return (
      <Select
        aria-label={label}
        disabled={readOnly}
        value={typeof value === 'boolean' ? String(value) : ''}
        onValueChange={(chosen) => {
          if (chosen === 'true' || chosen === 'false')
            onChange({ ...condition, value: chosen === 'true' });
        }}
        options={[
          { value: 'true', label: t('conditionTrue') },
          { value: 'false', label: t('conditionFalse') },
        ]}
        {...(typeof value === 'boolean' ? {} : { placeholder: '' })}
      />
    );
  }
  const single = singleOf(value);
  const held = scalarText(single);
  const mine = text !== undefined && parseScalar(text, type, condition.op) === single ? text : held;
  return (
    <Input
      aria-label={label}
      readOnly={readOnly}
      value={mine}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        const parsed = parseScalar(next, type, condition.op);
        onChange(parsed === undefined ? withoutValue(condition) : { ...condition, value: parsed });
      }}
    />
  );
}

/** The conditions of a `when`: fact, test, value, and Remove, with Add while under the limit of eight. */
function ConditionRows({
  conditions,
  scope,
  path,
  onChange,
  shared,
  keepOne,
}: {
  readonly conditions: readonly RuleCondition[];
  /** The words that say whose conditions these are: "rule 2", "approver 1". */
  readonly scope: string;
  /** The path of the `when`, for the findings: `rules[0].when`. */
  readonly path: string;
  readonly onChange: (next: readonly RuleCondition[]) => void;
  readonly shared: SharedProps;
  /** A rule's `when` keeps its last condition (the contract wants one); an approver's `when` may be emptied. */
  readonly keepOne: boolean;
}) {
  const { Button, Select } = useNc();
  const { t, readOnly, catalog } = shared;
  const factOptions = (condition: RuleCondition) => [
    ...[...catalog.facts.keys()].map((name) => ({ value: name, label: escapeInvisible(name) })),
    ...(condition.fact === '' || catalog.facts.has(condition.fact)
      ? []
      : [
          {
            value: condition.fact,
            label: t('conditionFactUndeclared', { fact: escapeInvisible(condition.fact) }),
          },
        ]),
  ];
  return (
    <div>
      <ul className="nc-perm-list">
        {conditions.map((condition, index) => {
          const n = index + 1;
          const at = `${path}[${String(index)}]`;
          const type = catalog.facts.get(condition.fact)?.type;
          const update = (next: RuleCondition): void => {
            onChange(replaceAt(conditions, index, next));
          };
          return (
            <li key={index}>
              <div className="nc-perm-row">
                <Select
                  aria-label={t('conditionFactOf', { n, scope })}
                  disabled={readOnly}
                  value={condition.fact}
                  placeholder={t('conditionFactPlaceholder')}
                  options={factOptions(condition)}
                  onValueChange={(name) => {
                    update(withFact(condition, factRefOf(catalog, name)));
                  }}
                />
                <Select
                  aria-label={t('conditionOpOf', { n, scope })}
                  disabled={readOnly}
                  value={condition.op}
                  options={opsFor(type, condition.op).map((op) => ({
                    value: op,
                    label: t(`opWord_${op}`),
                  }))}
                  onValueChange={(op) => {
                    const chosen = opsFor(type, condition.op).find((candidate) => candidate === op);
                    if (chosen !== undefined) update(withOp(condition, chosen));
                  }}
                />
                <ValueInput
                  condition={condition}
                  type={type}
                  label={t('conditionValueOf', { n, scope })}
                  readOnly={readOnly}
                  t={t}
                  onChange={update}
                />
                {readOnly || (keepOne && conditions.length === 1) ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      onChange(removeAt(conditions, index));
                    }}
                  >
                    {t('conditionRemove', { n, scope })}
                  </Button>
                )}
              </div>
              <Problem shared={shared} path={`${at}.fact`} />
              <Problem shared={shared} path={`${at}.op`} />
              <Problem shared={shared} path={`${at}.value`} />
              {refusedAt(shared.refusal, at) ? (
                <p className="nc-perm-refused" role="alert">
                  {t('ruleRefused', { detail: escapeInvisible(shared.refusal?.detail ?? '') })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Problem shared={shared} path={path} />
      {readOnly || conditions.length >= RULE_LIMITS.conditions ? null : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const first = [...catalog.facts.keys()][0];
            onChange([
              ...conditions,
              newCondition(first === undefined ? undefined : factRefOf(catalog, first)),
            ]);
          }}
        >
          {t('conditionAdd', { scope })}
        </Button>
      )}
      <Warnings shared={shared} within={path} />
    </div>
  );
}

/** A list of approver entries: kind, id, an optional `when`, and Remove; Add at the end. */
function ApproverList({
  entries,
  path,
  scopeOf,
  addLabel,
  where,
  onChange,
  shared,
}: {
  readonly entries: readonly PolicyApprover[];
  readonly path: string;
  /** The words for one entry's conditions: "approver 1", "approver 1 of rule 2". */
  readonly scopeOf: (index: number) => string;
  readonly addLabel: string;
  /** Whose entries these are: "the policy", "rule 2". */
  readonly where: string;
  readonly onChange: (next: readonly PolicyApprover[]) => void;
  readonly shared: SharedProps;
}) {
  const { Button, Checkbox, Input, Label, Select } = useNc();
  const { t, readOnly } = shared;
  return (
    <div>
      <ul className="nc-perm-list">
        {entries.map((entry, index) => {
          const n = index + 1;
          const at = `${path}[${String(index)}]`;
          const kind = isRoleApprover(entry) ? 'role' : 'user';
          return (
            <li key={index}>
              <div className="nc-perm-row">
                <Select
                  aria-label={t('approverKindOf', { n, where })}
                  disabled={readOnly}
                  value={kind}
                  options={[
                    { value: 'role', label: t('approverKind_role') },
                    { value: 'user', label: t('approverKind_user') },
                  ]}
                  onValueChange={(chosen) => {
                    if (chosen === 'role' || chosen === 'user')
                      onChange(
                        replaceAt(entries, index, withApprover(entry, chosen, approverId(entry)))
                      );
                  }}
                />
                <Input
                  aria-label={t('approverIdOf', { n, where })}
                  readOnly={readOnly}
                  value={approverId(entry)}
                  onChange={(event) => {
                    onChange(
                      replaceAt(
                        entries,
                        index,
                        withApprover(entry, kind, event.currentTarget.value)
                      )
                    );
                  }}
                />
                {readOnly ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      onChange(removeAt(entries, index));
                    }}
                  >
                    {t('approverRemove', { n, where })}
                  </Button>
                )}
              </div>
              <Problem shared={shared} path={`${at}.${kind}`} />
              {refusedExcept(shared.refusal, at, '.when[') ? <Refused shared={shared} /> : null}
              <Label>
                <Checkbox
                  checked={entry.when !== undefined}
                  disabled={readOnly}
                  onChange={(event) => {
                    onChange(
                      replaceAt(
                        entries,
                        index,
                        withApproverWhen(
                          entry,
                          event.currentTarget.checked ? [newCondition()] : undefined
                        )
                      )
                    );
                  }}
                />{' '}
                {t('approverOnlyWhen', { n, where })}
              </Label>
              {entry.when === undefined ? null : (
                <ConditionRows
                  conditions={entry.when}
                  scope={scopeOf(index)}
                  path={`${at}.when`}
                  keepOne
                  shared={shared}
                  onChange={(next) => {
                    onChange(replaceAt(entries, index, { ...entry, when: next }));
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      <Problem shared={shared} path={path} />
      {readOnly || entries.length >= RULE_LIMITS.approvers ? null : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            onChange([...entries, { role: '' }]);
          }}
        >
          {addLabel}
        </Button>
      )}
    </div>
  );
}

export interface RuleSections {
  readonly rules: boolean;
  readonly approvers: boolean;
  readonly exclude: boolean;
}

/** Which of the rev 16 members the service lists in `policy_forms.tool_invocation.config_members`. */
export function ruleSectionsOf(controller: PoliciesController): RuleSections {
  const members = controller.facts?.policyForms?.toolInvocation?.configMembers ?? [];
  return {
    rules: members.includes('rules'),
    approvers: members.includes('approvers'),
    exclude: members.includes('exclude'),
  };
}

/**
 * The rules, the approvers and the exclusion of a `tool_invocation` policy. Each section is shown only where the
 * service lists its member. Every control edits the working copy through the editor's own actions; nothing is sent
 * until Save. A member the editor could not read is shown as such and left exactly as it is.
 */
export function RulesSections({
  controller,
  editor,
  sections,
  t,
  readOnly,
  showProblems,
  refusal,
}: {
  readonly controller: PoliciesController;
  readonly editor: PolicyEditorController;
  readonly sections: RuleSections;
  readonly t: PermissionsTranslate;
  readonly readOnly: boolean;
  /** True once a save was refused for what `checkRules` finds: the findings are then marked on their rows. */
  readonly showProblems: boolean;
  readonly refusal: RuleRefusal | undefined;
}) {
  const { Button, Checkbox, Label } = useNc();
  const ids = { rules: useId(), approvers: useId(), exclude: useId() };
  // The rule whose approvers a change of outcome just removed (by its place in the list), so the person is told. A
  // move or a removal changes which rule sits at a place, so it clears the note.
  const [droppedAt, setDroppedAt] = useState<number | undefined>(undefined);
  const config = editor.working?.config ?? {};
  const catalog = factCatalogOf(controller.tools, editor.working?.targets);
  const checks = checkRules(config, catalog);
  const shared: SharedProps = {
    t,
    readOnly,
    catalog,
    problems: showProblems ? checks.problems : [],
    warnings: checks.warnings,
    refusal,
  };
  const rules = readRules(config);
  const approvers = readApprovers(config);
  const exclude = readExclude(config);
  const ruleList = rules.state === 'ok' ? rules.value : [];
  const firstFact = [...catalog.facts.keys()][0];
  const addDisabled =
    readOnly || rules.state === 'unreadable' || ruleList.length >= RULE_LIMITS.rules;

  return (
    <>
      {!sections.rules ? null : (
        <fieldset aria-labelledby={ids.rules}>
          <legend id={ids.rules}>{t('fieldRules')}</legend>
          <p className="nc-muted">{t('rulesExplain')}</p>
          {rules.state === 'unreadable' ? <p role="alert">{t('rulesUnreadable')}</p> : null}
          {!catalog.known ? (
            <p className="nc-muted">{t('rulesNoTools')}</p>
          ) : catalog.facts.size === 0 && ruleList.length === 0 ? (
            <p className="nc-muted">{t('rulesNoFacts')}</p>
          ) : null}
          <ol className="nc-perm-list">
            {ruleList.map((rule, index) => (
              <RuleItem
                key={index}
                rule={rule}
                index={index}
                count={ruleList.length}
                shared={shared}
                dropped={droppedAt === index}
                onDropped={(dropped) => {
                  setDroppedAt(dropped ? index : undefined);
                }}
                onChange={(next) => {
                  editor.setRules(replaceAt(ruleList, index, next));
                }}
                onMove={(by) => {
                  setDroppedAt(undefined);
                  editor.setRules(moveAt(ruleList, index, by));
                }}
                onRemove={() => {
                  setDroppedAt(undefined);
                  editor.setRules(removeAt(ruleList, index));
                }}
              />
            ))}
          </ol>
          <Problem shared={shared} path="rules" />
          {refusedExcept(refusal, 'rules', '[') ? <Refused shared={shared} /> : null}
          {readOnly ? null : (
            <Button
              type="button"
              variant="secondary"
              disabled={addDisabled || (catalog.facts.size === 0 && ruleList.length === 0)}
              onClick={() => {
                editor.setRules(
                  addRule(
                    ruleList,
                    newRule(firstFact === undefined ? undefined : factRefOf(catalog, firstFact))
                  )
                );
              }}
            >
              {t('ruleAdd')}
            </Button>
          )}
        </fieldset>
      )}

      {!sections.approvers ? null : (
        <fieldset aria-labelledby={ids.approvers}>
          <legend id={ids.approvers}>{t('fieldApprovers')}</legend>
          <p className="nc-muted">{t('approversExplain')}</p>
          {approvers.state === 'unreadable' ? <p role="alert">{t('rulesUnreadable')}</p> : null}
          {approvers.state === 'unreadable' ? null : (
            <ApproverList
              entries={approvers.state === 'ok' ? approvers.value : []}
              path="approvers"
              scopeOf={(index) => t('scopeApprover', { n: index + 1 })}
              addLabel={t('approverAdd')}
              where={t('scopePolicy')}
              shared={shared}
              onChange={(next) => {
                editor.setApprovers(next);
              }}
            />
          )}
          {refusedExcept(refusal, 'approvers', '[') ? <Refused shared={shared} /> : null}
          <Warnings shared={shared} within="approvers" />
        </fieldset>
      )}

      {!sections.exclude ? null : (
        <fieldset aria-labelledby={ids.exclude}>
          <legend id={ids.exclude}>{t('fieldExclude')}</legend>
          {exclude.state === 'unreadable' ? (
            <p role="alert">{t('rulesUnreadable')}</p>
          ) : (
            <Label>
              <Checkbox
                checked={exclude.state === 'ok' && exclude.value.includes('requester')}
                disabled={readOnly}
                onChange={(event) => {
                  editor.setExclude(
                    setRequesterExcluded(
                      exclude.state === 'ok' ? exclude.value : [],
                      event.currentTarget.checked
                    )
                  );
                }}
              />{' '}
              {t('excludeRequester')}
            </Label>
          )}
          <p className="nc-muted">{t('excludeNote')}</p>
          {refusedAt(refusal, 'exclude') ? <Refused shared={shared} /> : null}
          <Warnings shared={shared} within="exclude" />
        </fieldset>
      )}
    </>
  );
}

function RuleItem({
  rule,
  index,
  count,
  shared,
  dropped,
  onDropped,
  onChange,
  onMove,
  onRemove,
}: {
  readonly rule: PolicyRule;
  readonly index: number;
  readonly count: number;
  readonly shared: SharedProps;
  /** True when a change of outcome removed this rule's approvers; kept by the list, since a place can change rule. */
  readonly dropped: boolean;
  readonly onDropped: (dropped: boolean) => void;
  readonly onChange: (next: PolicyRule) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const { Button, Select } = useNc();
  const { t, readOnly } = shared;
  const n = index + 1;
  const at = `rules[${String(index)}]`;
  const scope = t('scopeRule', { n });
  return (
    <li>
      <p>
        <strong>{t('ruleHeading', { n })}</strong>{' '}
        <bdi>{escapeInvisible(ruleSentence(rule, t))}</bdi>
      </p>
      <div>
        <p className="nc-muted">{t('ruleWhen')}</p>
        <ConditionRows
          conditions={rule.when}
          scope={scope}
          path={`${at}.when`}
          keepOne
          shared={shared}
          onChange={(when) => {
            onChange({ ...rule, when });
          }}
        />
      </div>
      <div className="nc-perm-row">
        <Select
          aria-label={t('ruleOutcomeOf', { n })}
          disabled={readOnly}
          value={rule.then}
          options={RULE_OUTCOMES.map((outcome) => ({
            value: outcome,
            label: t(`ruleOutcomeOption_${outcome}`),
          }))}
          onValueChange={(chosen) => {
            const outcome: RuleOutcome | undefined = RULE_OUTCOMES.find((o) => o === chosen);
            if (outcome === undefined) return;
            onDropped(outcome !== 'ask' && (rule.approvers?.length ?? 0) > 0);
            onChange(withOutcome(rule, outcome));
          }}
        />
      </div>
      {dropped && rule.then !== 'ask' ? (
        <p role="status" className="nc-muted">
          {t('ruleApproversDropped')}
        </p>
      ) : null}
      {rule.then !== 'ask' ? null : (
        <div>
          <p className="nc-muted">{t('ruleApproversHeading')}</p>
          <p className="nc-muted">{t('ruleApproversNote')}</p>
          <ApproverList
            entries={rule.approvers ?? []}
            path={`${at}.approvers`}
            scopeOf={(entry) => t('scopeRuleApprover', { approver: entry + 1, rule: n })}
            addLabel={t('approverAddTo', { scope })}
            where={scope}
            shared={shared}
            onChange={(approvers) => {
              onChange(withRuleApprovers(rule, approvers));
            }}
          />
        </div>
      )}
      {refusedExcept(shared.refusal, at, '.when[', '.approvers[') ? (
        <Refused shared={shared} />
      ) : null}
      {readOnly ? null : (
        <div className="nc-perm-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={index === 0}
            onClick={() => {
              onMove(-1);
            }}
          >
            {t('ruleMoveUp', { n })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={index === count - 1}
            onClick={() => {
              onMove(1);
            }}
          >
            {t('ruleMoveDown', { n })}
          </Button>
          <Button type="button" variant="ghost" onClick={onRemove}>
            {t('ruleRemove', { n })}
          </Button>
        </div>
      )}
    </li>
  );
}

export { approverSentence };
