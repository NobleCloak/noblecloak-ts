import { ConnectionsExample } from '@app/connections/ConnectionsExample';
import { ConfigProblem } from '@app/connections/ConfigProblem';
import { readConfig } from '@app/connections/config';

export default function ConnectionsPage() {
  const result = readConfig();
  return (
    <>
      <h1>Connections</h1>
      {result.ok ? (
        <ConnectionsExample config={result.config} />
      ) : (
        <ConfigProblem problems={result.problems} />
      )}
    </>
  );
}
