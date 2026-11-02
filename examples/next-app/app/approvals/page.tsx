import { ApprovalsExample } from '@app/approvals/ApprovalsExample';
import { ConfigProblem } from '@app/approvals/ConfigProblem';
import { readConfig } from '@app/approvals/config';

export default function ApprovalsPage() {
  const result = readConfig();
  return (
    <>
      <h1>Approvals</h1>
      {result.ok ? (
        <ApprovalsExample config={result.config} />
      ) : (
        <ConfigProblem problems={result.problems} />
      )}
    </>
  );
}
