import { CallbackClient } from '@app/approvals/CallbackClient';
import { ConfigProblem } from '@app/approvals/ConfigProblem';
import { readConfig } from '@app/approvals/config';

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
          The mock has no sign-in. <a href="/approvals">Back to approvals</a>.
        </p>
      )}
    </>
  );
}
