/**
 * The mock and a held approval for the approvals tests: the mock runs as its own process (the browser keeps
 * connections to it open, so a test must be able to kill it), and this module plays the agent against it
 * through `@noblecloak/client`. It registers the refund tool, asks for a decision on a refund (which opens an
 * approval), holds that approval until the person in the browser decides, then does what an agent does with
 * the answer: checks the resumption names the refund, consumes an approved approval and counts one refund, or does nothing for a rejected one.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { argDigest, createClient } from '@noblecloak/client';

export interface BrowserDemo {
  readonly approvalId: string;
  /** Resolves with 0 once the decision has been acted on and the outcome is the one it calls for, else 1. */
  readonly exited: Promise<number | null>;
  /** What the mock and the agent said, one JSON event per line; `worker_resumed` is the agent acting on the decision. */
  lines(): string[];
  /** The approval's state as the agent read it after acting on the decision; undefined until then. */
  approvalState(): string | undefined;
  /** Stops the mock and resolves once it has exited, so its port is free for the next test. */
  stop(): Promise<void>;
}

const TOOL_REF = 'ext:billing:issue_refund';
/** The call the agent asks to make. The page shows these arguments to the approver. */
const REFUND = { order_id: 'A-7', amount_cents: 2500 };

export interface BrowserDemoOptions {
  /**
   * The call the agent expects the resumption to name: the tool and the arguments it believes it asked for.
   * Each defaults to the call it does ask for; a test sets a different one to see the agent refuse to act on a
   * resumption that names another call.
   */
  readonly expectedRefund?: typeof REFUND;
  readonly expectedToolRef?: string;
}

export async function startBrowserDemo(
  decision: 'approve' | 'deny',
  appOrigin: string,
  options: BrowserDemoOptions = {}
): Promise<BrowserDemo> {
  const port = process.env.NC_MOCK_PORT ?? '8787';
  const require = createRequire(import.meta.url);
  const script = join(
    dirname(require.resolve('@noblecloak/spec/package.json')),
    'dist/cli/nc-mock.js'
  );
  const mock: ChildProcess = spawn(
    process.execPath,
    [script, '--port', port, '--allow-origin', appOrigin],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const lines: string[] = [];
  let printed = '';
  mock.stdout?.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
  });
  mock.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line !== '') lines.push(`! ${line}`);
  });
  const mockExited = new Promise<number | null>((resolve) => {
    mock.once('exit', (code) => {
      resolve(code);
    });
  });
  const stop = async (): Promise<void> => {
    if (mock.exitCode !== null || mock.signalCode !== null) return;
    mock.kill('SIGTERM');
    const timer = setTimeout(() => mock.kill('SIGKILL'), 5_000);
    await mockExited;
    clearTimeout(timer);
  };
  const say = (event: string, details: Record<string, unknown> = {}): void => {
    lines.push(JSON.stringify({ event, ...details }));
  };

  try {
    // The mock prints `{base_url, deployment, tokens}` once it listens.
    const deadline = Date.now() + 30_000;
    let address: { base_url: string; tokens: { creator: string } } | undefined;
    while (address === undefined) {
      // The address is pretty-printed JSON that can arrive in several chunks: a partial read does not parse yet.
      try {
        address = JSON.parse(printed) as { base_url: string; tokens: { creator: string } };
        break;
      } catch {
        // keep waiting
      }
      if (mock.exitCode !== null)
        throw new Error(
          `the mock exited (code ${String(mock.exitCode)}) before printing its address (is port ${port} in use?)\n${lines.join('\n')}`
        );
      if (Date.now() > deadline) throw new Error('the mock did not print its address');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { base_url: baseUrl, tokens } = address;
    const api = createClient({ baseUrl, getToken: () => tokens.creator });

    const registered = await api.POST('/v1/tools', {
      body: {
        tool_ref: TOOL_REF,
        transport: 'external',
        description: 'Refund an order.',
        side_effect_level: 'external',
        input_schema: { type: 'object' },
        owner_kind: 'org',
        // The approver sees what they approve.
        show_arguments_to_approvers: true,
      },
    });
    if (!registered.response.ok)
      throw new Error(`registering the tool answered ${String(registered.response.status)}`);

    const decided = await api.POST('/v1/decisions', {
      body: { action: { tool_ref: TOOL_REF, arguments: REFUND } },
    });
    const approvalId = decided.data?.data.approval?.id;
    if (approvalId === undefined)
      throw new Error(`the decision opened no approval (HTTP ${String(decided.response.status)})`);
    say('agent_paused', { approval_id: approvalId });

    let refunds = 0;
    let finalState: string | undefined;
    // The agent holds here, as a paused run does, until a person decides. A mock that exits ends the wait.
    const run = (async (): Promise<number> => {
      let state = 'pending';
      while (state === 'pending') {
        if (mock.exitCode !== null)
          throw new Error('the mock exited while the approval was pending');
        const waited = await api.GET('/v1/approvals/{id}/wait', {
          params: { path: { id: approvalId }, query: { timeout: 5 } },
        });
        if (waited.data === undefined)
          throw new Error(`waiting for the approval answered ${String(waited.response.status)}`);
        state = waited.data.data.state;
      }
      if (state === 'approved') {
        const resumption = await api.GET('/v1/approvals/{id}/resumption', {
          params: { path: { id: approvalId } },
        });
        const token = resumption.data?.data.resume_token;
        if (token === undefined) throw new Error('the approved approval has no resume token');
        // The resumption must name the call the agent asked for: same tool, same digest of the arguments.
        if (
          resumption.data?.data.tool_ref !== (options.expectedToolRef ?? TOOL_REF) ||
          resumption.data.data.action_digest !== (await argDigest(options.expectedRefund ?? REFUND))
        )
          throw new Error('the resumption does not name the refund the agent asked for');
        const consumed = await api.POST('/v1/approvals/{id}/consume', {
          params: { path: { id: approvalId } },
          body: { resume_token: token, action: { tool_ref: TOOL_REF, arguments: REFUND } },
        });
        if (!consumed.response.ok)
          throw new Error(`consuming the approval answered ${String(consumed.response.status)}`);
        refunds += 1;
      }
      say('worker_resumed', { approval_id: approvalId, status: state });
      const read = await api.GET('/v1/approvals/{id}', { params: { path: { id: approvalId } } });
      finalState = read.data?.data.state;
      const expected = decision === 'approve' ? 'consumed' : 'rejected';
      return finalState === expected && refunds === (decision === 'approve' ? 1 : 0) ? 0 : 1;
    })();
    const exited = run.catch((error: unknown) => {
      say('demo_failed', { message: error instanceof Error ? error.message : String(error) });
      return 1;
    });

    return {
      approvalId,
      exited,
      lines: () => lines,
      approvalState: () => finalState,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

// `bun run start:demo` (NC_DECISION=deny to expect a Deny): the same mock and held approval, for a person to
// decide in the browser by hand. Exits 0 only when the outcome matches the decision.
if (import.meta.main) {
  const decision = process.env.NC_DECISION === 'deny' ? 'deny' : 'approve';
  const appOrigin = process.env.NC_APP_ORIGIN ?? 'http://localhost:3000';
  const demo = await startBrowserDemo(decision, appOrigin);
  console.log(
    JSON.stringify({
      event: 'browser_ready',
      api: `http://127.0.0.1:${process.env.NC_MOCK_PORT ?? '8787'}`,
      open: `${appOrigin}/approvals`,
      approval_id: demo.approvalId,
    })
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void demo.stop().then(() => process.exit(1));
    });
  const code = await demo.exited;
  console.log(demo.lines().join('\n'));
  await demo.stop();
  process.exit(code ?? 1);
}
