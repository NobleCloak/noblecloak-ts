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

/** Combining marks in a row that are shown as they are; a longer run could draw over the line, so the rest are escaped. */
const MARKS_SHOWN = 2;
const MARK_RUN = /\p{M}{3,}/gu;
const hexEscape = (char: string): string => {
  const hex = (char.codePointAt(0) ?? 0).toString(16).toUpperCase();
  return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
};

/** A name for the middle of a sentence: invisible characters shown as escapes, at most two combining marks in a row, and isolated. */
const shown = (name: string): string =>
  `${ISOLATE_START}${escapeInvisible(name).replace(MARK_RUN, (run) =>
    Array.from(run)
      .map((mark, index) => (index < MARKS_SHOWN ? mark : hexEscape(mark)))
      .join('')
  )}${ISOLATE_END}`;

/** What a part of a tool reference may be made of to be shown bare; anything else (a space, a bracket, a look-alike) is quoted. */
const PLAIN_PART = /^[A-Za-z0-9_.:/@+-]+$/;
/** A tool segment that holds one of these could read as "at {source}" or as a source, so it is quoted. */
const SOURCE_LIKE = /[:@]/;

/**
 * Inside quotes only letters (not modifier letters, which draw as quotes), numbers, the space and printable ASCII
 * are shown as they are; every other character is shown as an escape, so no look-alike of a quote, a bracket or a
 * colon can be read as one. The ASCII `"` and the backslash are escaped by a backslash.
 */
function quotedBody(text: string): string {
  return Array.from(text)
    .map((char) => {
      if (char === '"' || char === '\\') return `\\${char}`;
      if (/^[ -~]$/.test(char)) return char;
      if (/^[\p{L}\p{N}]$/u.test(char) && !/^\p{Lm}$/u.test(char)) return char;
      return hexEscape(char);
    })
    .join('');
}

/**
 * One part of a tool reference for a sentence: clipped, invisible characters shown as escapes, and isolated, so
 * what it holds cannot reorder the sentence. A part is shown bare only when it is made of letters, digits and
 * `_ . : / @ + -` (a tool segment, `{ tool: true }`, also without `:` and `@`); any other part is put in quotes,
 * with what is not a letter, a number, a space or ASCII punctuation shown as an escape. The isolates are invisible,
 * so without quotes a tool part `safe_read (ext:trusted)`, or one with a blank or a look-alike bracket, would read
 * as the tool `safe_read` of the source `ext:trusted`. Shared with the proposal's tool lines.
 */
export function refPartText(
  part: string,
  max: number,
  options: { readonly tool?: boolean } = {}
): string {
  const text = clipText(part, max);
  const bare = PLAIN_PART.test(part) && !(options.tool === true && SOURCE_LIKE.test(part));
  if (bare) return shown(text);
  // The ellipsis of a cut is ours: it is kept as it is, inside the quotes.
  const cut = part.length > max;
  return shown(`“${quotedBody(cut ? text.slice(0, -1) : text)}${cut ? '…' : ''}”`);
}

/**
 * The tool for a sentence: its name, then its source in brackets, each isolated on its own. An empty or malformed
 * reference reads as an unnamed tool, so the sentence is never cut off. The exact reference is in the detail and in
 * the confirm dialog.
 */
function toolText(toolRef: unknown, t: Translate): string {
  const parts = toolParts(typeof toolRef === 'string' ? toolRef : '');
  if (parts.tool === '') return t('rowToolUnknown');
  const tool = refPartText(parts.tool, TOOL_MAX, { tool: true });
  return parts.source === undefined
    ? tool
    : t('toolWithSource', { tool, source: refPartText(parts.source, SOURCE_MAX) });
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
 * text, never the asker. `undefined` when there is nothing to add. A policy-set proposal's title does not name an
 * agent, so the hint is shown here and nowhere as the proposal's target (that is the proposed policy's own
 * subjects, read from the call).
 */
export function requestVia(approval: TitledApproval, t: Translate): string | undefined {
  const agent = agentName(approval);
  return agent === undefined || agent === requesterName(approval)
    ? undefined
    : t('rowVia', { agent: shown(agent) });
}

/**
 * What a request is, in a sentence, for a row, the heading of its detail and the confirm dialog. A call is the
 * requester wanting to use the tool, with where the tool comes from; a policy-set proposal is a policy setup from the
 * requester. The title never says which agent a proposal is for: the agent is the caller's unverified hint, and what
 * the proposal targets is in its parsed policy (the detail shows it). With no requester name the sentence has none
 * (the id is in the detail), and the agent is never put in its place. Every value from the service is escaped,
 * names and the parts of a tool reference are isolated and cut short, so the text is safe in a `<bdi>`.
 */
export function requestTitle(approval: TitledApproval, t: Translate): string {
  const who = requesterName(approval);
  if (approval.tool_ref === PROPOSE_POLICY_SET_TOOL) {
    return who === undefined
      ? t('rowTitleProposalAnon')
      : t('rowTitleProposal', { who: shown(who) });
  }
  const tool = toolText(approval.tool_ref, t);
  return who === undefined
    ? t('rowTitleToolAnon', { tool })
    : t('rowTitleTool', { who: shown(who), tool });
}
