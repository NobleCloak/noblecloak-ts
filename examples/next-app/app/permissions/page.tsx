import { PermissionsExample } from '@app/permissions/PermissionsExample';
import { ConfigProblem } from '@app/permissions/ConfigProblem';
import { readConfig } from '@app/permissions/config';

export default function PermissionsPage() {
  const result = readConfig();
  return (
    <>
      <h1>Permissions</h1>
      {result.ok ? (
        <PermissionsExample config={result.config} />
      ) : (
        <ConfigProblem problems={result.problems} />
      )}
    </>
  );
}
