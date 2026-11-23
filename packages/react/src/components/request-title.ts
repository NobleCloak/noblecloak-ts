import { PROPOSE_POLICY_SET_TOOL } from '../approvals-proposal.js';
import type { ApprovalSummary } from '../approvals-types.js';
import { clipText } from './format.js';
import { escapeInvisible } from './format-json.js';
import type { Translate } from './labels.js';

/** What a title reads: the tool, the verified requester, and the agent hint the caller sent. */
export type TitledApproval = Pick<ApprovalSummary, 'tool_ref'> &
  Partial<Pick<ApprovalSummary, 'agent' | 'requester'>>;

/** Unicode isolates (U+2068, U+2069): they keep a name from the service from reordering the sentence around it. */
const ISOLATE_START = String.fromCodePoint(0x2068);
const ISOLATE_END = String.fromCodePoint(0x2069);

/** The longest a name, a tool and a source are shown in a title, so none can push the others out of view. */
const NAME_MAX = 40;
const TOOL_MAX = 80;
const SOURCE_MAX = 60;

/** A tool reference split into the tool and where it comes from. The service sends no display name for a tool. */
export interface ToolParts {
  readonly tool: string;
  /** The namespace of `ext:billing:issue_refund` (`ext:billing`), or the server of `mcp:{server}/{surface}/{tool}`. */
  readonly source?: string;
}

/**
 * `mcp:{server}/{surface}/{tool}` is the tool and its server (the tool may itself hold `:`). Any other reference is
 * split at its last `:`, the part before it being the source. The tool is shown as the service wrote it, so
 * `issue_refund` and `issue-refund` stay different. A reference with no `:` is the tool alone.
 */
export function toolParts(toolRef: string): ToolParts {
  const mcp = /^mcp:([^/]+)\/([^/]+)\/(.+)$/.exec(toolRef);
  if (mcp?.[1] !== undefined && mcp[3] !== undefined) return { tool: mcp[3], source: mcp[1] };
  const colon = toolRef.lastIndexOf(':');
  if (colon > 0 && colon < toolRef.length - 1) {
    return { tool: toolRef.slice(colon + 1), source: toolRef.slice(0, colon) };
  }
  return { tool: toolRef };
}

/**
 * A name the service sent, made safe to put in a sentence: only a string counts (a malformed reply may hold anything),
 * runs of whitespace (a no-break space too) become one space and the ends are trimmed, so padding cannot hide the
 * name, then it is cut short. Raw text; `undefined` when nothing is left.
 */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : clipText(text, NAME_MAX);
}

/** A name for the middle of a sentence: invisible characters shown as escapes, and isolated. */
const shown = (name: string): string => `${ISOLATE_START}${escapeInvisible(name)}${ISOLATE_END}`;

/**
 * The tool for a sentence: its name, then its source in brackets. An empty or malformed reference reads as an
 * unnamed tool, so the sentence is never cut off.
 */
function toolText(toolRef: unknown, t: Translate): string {
  const parts = toolParts(typeof toolRef === 'string' ? toolRef : '');
  if (parts.tool === '') return t('rowToolUnknown');
  const tool = escapeInvisible(clipText(parts.tool, TOOL_MAX));
  return parts.source === undefined
    ? tool
    : t('toolWithSource', { tool, source: escapeInvisible(clipText(parts.source, SOURCE_MAX)) });
}

/**
 * Who is asking is the requester the service verified. The agent is the caller's own hint (`actor.agent_id`, "display
 * only": an approver must not treat it as identity), so it is never the asker: see `requestVia`.
 */
const requesterName = (approval: TitledApproval): string | undefined =>
  nameOf(approval.requester?.display_name);
const agentName = (approval: TitledApproval): string | undefined => nameOf(approval.agent?.name);

/**
 * The agent a request names, as "via {agent}", when it is a name the requester does not already carry. Secondary
 * text, never the asker. `undefined` for a policy-set proposal (its title already says which agent) and when there
 * is nothing to add.
 */
export function requestVia(approval: TitledApproval, t: Translate): string | undefined {
  if (approval.tool_ref === PROPOSE_POLICY_SET_TOOL) return undefined;
  const agent = agentName(approval);
  return agent === undefined || agent === requesterName(approval)
    ? undefined
    : t('rowVia', { agent: shown(agent) });
}

/**
 * What a request is, in a sentence, for a row, the heading of its detail and the confirm dialog. A call is the
 * requester wanting to use the tool, with where the tool comes from; a policy-set proposal is a policy setup from the
 * requester, for the agent when the request names one that is not the requester. With no requester name the sentence
 * has none (the id is in the detail), and the agent is never put in its place. Every value from the service is
 * escaped, names are isolated and cut short, so the text is safe in a `<bdi>`.
 */
export function requestTitle(approval: TitledApproval, t: Translate): string {
  const who = requesterName(approval);
  const agent = agentName(approval);
  if (approval.tool_ref === PROPOSE_POLICY_SET_TOOL) {
    if (who !== undefined && agent !== undefined && agent !== who) {
      return t('rowTitleProposalFor', { agent: shown(agent), who: shown(who) });
    }
    if (who !== undefined) return t('rowTitleProposal', { who: shown(who) });
    if (agent !== undefined) return t('rowTitleProposalAgent', { agent: shown(agent) });
    return t('rowTitleProposalAnon');
  }
  const tool = toolText(approval.tool_ref, t);
  return who === undefined
    ? t('rowTitleToolAnon', { tool })
    : t('rowTitleTool', { who: shown(who), tool });
}
