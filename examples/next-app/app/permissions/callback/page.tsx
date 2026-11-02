import { CallbackClient } from '@app/permissions/CallbackClient';
import { ConfigProblem } from '@app/permissions/ConfigProblem';
import { readConfig } from '@app/permissions/config';

export default function CallbackPage() {
  const result = readConfig();
  return (
    <>
      <h1>Signing in</h1>
      {!result.ok ? (
        <ConfigProblem problems={result.problems} />
      ) : result.config.mode === 'oidc' ? (
        <CallbackClient config={result.config} />
      ) : (
        <p>
          The mock has no sign-in. <a href="/permissions">Back to permissions</a>.
        </p>
      )}
    </>
  );
}
