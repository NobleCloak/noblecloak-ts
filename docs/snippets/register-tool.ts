import { creator } from './connect.js';
import { unwrap } from './problem.js';

/** Puts an external tool in the catalog. The mock decides a new tool as step_up; the contract leaves the default policy to the deployment. */
export async function registerTool(toolRef: string): Promise<void> {
  unwrap(
    await creator.POST('/v1/tools', {
      body: {
        tool_ref: toolRef,
        transport: 'external',
        description: 'Refund an order.',
        side_effect_level: 'external',
        input_schema: { type: 'object' },
        owner_kind: 'org',
        // The people who decide an approval of this tool see the arguments of the call.
        show_arguments_to_approvers: true,
      },
    })
  );
}
