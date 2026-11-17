import { useId } from 'react';
import type { ReactNode } from 'react';

import { shortToolRef } from '../approvals-proposal.js';
import type { Proposal, ProposalSubject } from '../approvals-proposal.js';
import { escapeInvisible } from './format-json.js';
import type { ApprovalsLabelKey, Translate } from './labels.js';
import { useNc } from './slots.js';
import { levelWord, lookup } from './words.js';

const MODE_LABEL: Readonly<Record<string, ApprovalsLabelKey>> = {
  always_allow: 'proposalModeAlwaysAllow',
  ask: 'proposalModeAsk',
  escalate: 'proposalModeEscalate',
  deny: 'proposalModeDeny',
  not_granted: 'proposalModeNotGranted',
};

const KIND_LABEL: Readonly<Record<string, ApprovalsLabelKey>> = {
  baseline: 'proposalKindBaseline',
  tightening: 'proposalKindTightening',
  role: 'proposalKindRole',
};

/** A subject as words. Every value the service sent is escaped, so the text is safe to show in a `<bdi>`. */
function subjectText(subject: ProposalSubject, t: Translate): string {
  switch (subject.kind) {
    case 'everyone':
      return t('proposalSubjectEveryone');
    case 'role':
      return t('proposalSubjectRole', { key: escapeInvisible(subject.key) });
    case 'agent':
      return t('proposalSubjectAgent', { id: escapeInvisible(subject.id) });
    case 'organization':
      return t('proposalSubjectOrganization');
    case 'other':
      return t('proposalSubjectOther', {
        type: escapeInvisible(subject.type),
        id: escapeInvisible(subject.id),
      });
  }
}

/** A tool as "tool on server" for an `mcp:` reference, the reference itself otherwise; `undefined` is every tool. */
function toolText(toolRef: string | undefined, t: Translate): string {
  if (toolRef === undefined) return t('proposalAllTools');
  const { tool, server } = shortToolRef(toolRef);
  return server === undefined
    ? escapeInvisible(tool)
    : t('proposalToolOnServer', { tool: escapeInvisible(tool), server: escapeInvisible(server) });
}

/** The full reference, for the tooltip of a line that shows the short one. */
const fullRef = (toolRef: string | undefined): string | undefined =>
  toolRef === undefined ? undefined : escapeInvisible(toolRef);

function Section({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <h5>{heading}</h5>
      {children}
    </section>
  );
}

/**
 * What approving a policy set does, in plain terms: the policies by subject, the changes the preview lists, the
 * rows with no effect, the grants, the tools to register and the agent to bind. Every part comes from the
 * proposal that was read: one that was not served is not shown, and "Approving loosens no policy." is said only
 * when the reader was served a preview that lists none. The panel is the theme's `Card`, so a replacement of that
 * role reaches it.
 */
export function ProposalSection({
  proposal,
  t,
}: {
  readonly proposal: Proposal;
  readonly t: Translate;
}) {
  const { Card } = useNc();
  const headingId = useId();
  const { groups, tools, agent, preview } = proposal;
  const grants = proposal.toolGrants ?? preview?.grants ?? [];
  const agentText =
    agent === undefined ? undefined : t('proposalSubjectAgent', { id: escapeInvisible(agent.id) });

  return (
    <Card role="region" className="nc-proposal" aria-labelledby={headingId}>
      <h4 id={headingId}>{t('proposalHeading')}</h4>
      {groups === undefined || groups.length === 0 ? null : (
        <Section heading={t('proposalPoliciesHeading')}>
          {groups.map((group, index) => (
            <div key={`${String(index)}-${group.subject.kind}`}>
              <p>
                <strong>
                  <bdi>{subjectText(group.subject, t)}</bdi>
                </strong>
              </p>
              <ul>
                {group.rows.map((row, rowIndex) => (
                  <li key={`${String(rowIndex)}-${row.toolRef ?? ''}`} title={fullRef(row.toolRef)}>
                    <bdi>
                      {t('proposalRow', {
                        tool: toolText(row.toolRef, t),
                        mode: lookup(MODE_LABEL, row.mode, t),
                        kind: lookup(KIND_LABEL, row.kind, t),
                      })}
                    </bdi>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      )}
      {preview === undefined ? null : (
        <Section heading={t('proposalChangesHeading')}>
          {preview.loosening.length === 0 ? (
            <p>{t('proposalLoosensNothing')}</p>
          ) : (
            <ul>
              {preview.loosening.map((change, index) => (
                <li key={`${String(index)}-${change.toolRef}`} title={fullRef(change.toolRef)}>
                  <bdi>
                    {t('proposalChange', {
                      subject: subjectText(change.subject, t),
                      tool: toolText(change.toolRef, t),
                      from: lookup(MODE_LABEL, change.from, t),
                      to: lookup(MODE_LABEL, change.to, t),
                    })}
                  </bdi>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {preview === undefined || preview.ineffective.length === 0 ? null : (
        <Section heading={t('proposalIneffectiveHeading')}>
          <ul>
            {preview.ineffective.map((entry, index) => (
              <li key={`${String(index)}-${entry.toolRef}`} title={fullRef(entry.toolRef)}>
                <bdi>
                  {t('proposalIneffective', {
                    subject: subjectText(entry.subject, t),
                    tool: toolText(entry.toolRef, t),
                  })}
                </bdi>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {grants.length === 0 ? null : (
        <Section heading={t('proposalGrantsHeading')}>
          {agentText === undefined ? null : (
            <p>
              <bdi>{t('proposalGrantsFor', { agent: agentText })}</bdi>
            </p>
          )}
          <ul>
            {grants.map((toolRef, index) => (
              <li key={`${String(index)}-${toolRef}`} title={fullRef(toolRef)}>
                <bdi>{toolText(toolRef, t)}</bdi>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {tools.length === 0 ? null : (
        <Section heading={t('proposalToolsHeading')}>
          <ul>
            {tools.map((tool, index) => (
              <li key={`${String(index)}-${tool.toolRef}`} title={fullRef(tool.toolRef)}>
                <bdi>
                  {tool.sideEffectLevel === undefined
                    ? t('proposalToolNoLevel', { tool: toolText(tool.toolRef, t) })
                    : t('proposalTool', {
                        tool: toolText(tool.toolRef, t),
                        level: levelWord(tool.sideEffectLevel, t),
                      })}
                </bdi>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {agent === undefined || agentText === undefined ? null : (
        <Section heading={t('proposalAgentHeading')}>
          <p>
            <bdi>
              {agent.principalId === undefined
                ? t('proposalAgentKept', { agent: agentText })
                : t('proposalAgentBound', {
                    agent: agentText,
                    principal: escapeInvisible(agent.principalId),
                  })}
            </bdi>
          </p>
        </Section>
      )}
    </Card>
  );
}
