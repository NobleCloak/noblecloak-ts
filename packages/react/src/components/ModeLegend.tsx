import { useId } from 'react';

import { POLICY_MODES, PROVISIONAL_MODES } from '../permissions-vocabulary.js';
import { createPermissionsTranslate, modeKey } from './permissions-labels.js';
import type { PermissionsLabels } from './permissions-labels.js';
import { modeName, wireText } from './permissions-parts.js';
import { WithComponents } from './slots.js';
import type { ModuleComponents } from './slots.js';

/** The modes a service may refuse with 422 `unsupported_policy_form` because it does not enforce them. */
export const MAY_BE_REFUSED: readonly string[] = ['escalate', 'not_granted'];

export interface ModeLegendProps {
  readonly className?: string;
  /** Replaces any of the legend's strings. */
  readonly labels?: PermissionsLabels;
  /** Replaces any primitive by role, over any `NcProvider` around it. */
  readonly components?: ModuleComponents;
}

/**
 * The five modes of a tool policy, each with the decision it maps to on the wire as the contract publishes it
 * (`MODE_ON_THE_WIRE`, held equal to the contract by a test) and one sentence. It shows the mapping; it says nothing
 * about how policies compose.
 */
export function ModeLegend({ className, labels, components }: ModeLegendProps) {
  return (
    <WithComponents components={components}>
      <ModeLegendBody
        className={['nc-root', 'nc-permissions-legend', className].filter(Boolean).join(' ')}
        {...(labels === undefined ? {} : { labels })}
      />
    </WithComponents>
  );
}

/** The legend without its own root, for a module that already renders one. */
export function ModeLegendBody({
  className,
  labels,
}: {
  readonly className?: string;
  readonly labels?: PermissionsLabels;
}) {
  const t = createPermissionsTranslate(labels);
  const headingId = useId();
  return (
    <section className={className ?? 'nc-permissions-legend'} aria-labelledby={headingId}>
      <h3 id={headingId}>{t('legendHeading')}</h3>
      <table className="nc-perm-table">
        <thead>
          <tr>
            <th scope="col">{t('legendMode')}</th>
            <th scope="col">{t('legendWire')}</th>
            <th scope="col">{t('legendMeaning')}</th>
          </tr>
        </thead>
        <tbody>
          {POLICY_MODES.map((mode) => {
            const sentence = modeKey('modeSentence_', mode);
            return (
              <tr key={mode} data-mode={mode}>
                <th scope="row">{modeName(mode, t)}</th>
                <td>
                  <code>{wireText(mode, t)}</code>
                </td>
                <td>
                  {sentence === undefined ? null : <p>{t(sentence)}</p>}
                  {PROVISIONAL_MODES.includes(mode) ? (
                    <p className="nc-muted">{t('modeProvisional')}</p>
                  ) : null}
                  {MAY_BE_REFUSED.includes(mode) ? (
                    <p className="nc-muted">{t('modeMayBeRefused')}</p>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
