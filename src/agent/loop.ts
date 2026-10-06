/**
 * The bounded agent loop (PLAN §6.19).
 *
 *   model -> (tool call -> validate -> resolve -> policy -> act)* -> reply
 *
 * The model chooses what to do; code decides whether and how it happens. Every
 * tool call goes through exactly the path a parsed draft always went through —
 * strict Zod, the weekday check, `resolve`, `decide`, confirm — so the agent can
 * reach nothing the parser could not.
 *
 * Only a Tier 0 read hands a result back to the model. Every other outcome ends
 * the turn with the reply code rendered: a question, a confirmation, an Undo
 * offer, a refusal, or the confirmation of what was done. That is what keeps
 * "one message, at most one action" true without counting (plan invariant 6),
 * and why the model never gets to word what an action did.
 *
 * Bounded by code: calls, tokens, and the one model a turn starts on.
 *
 * A phone read (§6.21) is the one outcome that neither returns nor ends: the
 * turn is handed back as `suspend`, stored, and picked up by `resumeAgentTurn`
 * when the phone answers — same model, same caps, calls already spent counted.
 */
import type { Reply, TurnContext } from '../core/orchestrator.js';
import { runIntent } from '../core/orchestrator.js';
import { validateIntentDraft } from '../nlu/intent-schema.js';
import { stripNulls } from '../nlu/json-schema.js';
import { checkNamedWeekdays } from '../nlu/weekday-check.js';
import { stripIsolates } from '../render/bidi.js';
import type { Lang } from '../render/format-time.js';
import { scrubForModel } from '../security/scrub.js';
import type { Logger } from '../security/redact.js';
import { REGISTRY } from '../tools/registry.js';
import type { ToolName } from '../tools/registry.js';
import type { PhoneReadInput, PhoneReadResult } from '../tools/phone-reads.js';
import { phoneReadRefused, phoneReadText } from '../render/phone-reads.js';
import type { MessageScope, Reservation, TokenBudget } from './budget.js';
import { CHARS_PER_TOKEN, newMessageScope, wasNeverSent } from './budget.js';
import { DEFAULT_MAX_COMPLETION_TOKENS, modelEntry } from './models.js';
import { selectTools } from './tool-groups.js';
import type { HistoryEntry } from './history.js';
import { languageLine, nowLine, READ_ONLY_NOTE, SYSTEM_PROMPT } from './prompt.js';
import type { AgentMessage, AgentProvider, AgentResponse, ToolCall, WireTool } from './provider.js';
import { wireToolCall } from './provider.js';
import { agentToolNames, fromWireName, TAINTING_TOOLS, wireTools } from './tools.js';

export const MAX_MODEL_CALLS = 3;
/** One model's minute bucket is 8K; a turn has to fit in one (plan K4). The default; `models.ts` sets each. */
export const TURN_TOKEN_CAP = 7_000;
/** Reserved per call for the completion, reasoning included. */
const COMPLETION_RESERVE = 400;
export const MAX_REPLY_CHARS = 1_500;
export const MAX_RESULT_CHARS = 1_500;

/** The characters a call sends, as the estimator counts them: the calibration records this (§2). */
export function promptChars(messages: readonly AgentMessage[], toolChars: number): number {
  let chars = toolChars;
  for (const message of messages) {
    chars += (message.content ?? '').length;
    if (message.role === 'assistant' && message.tool_calls) {
      chars += JSON.stringify(message.tool_calls).length;
    }
  }
  return chars;
}

/**
 * Hebrew-heavy text ran about 2.6 characters a token in the spike. An estimate,
 * not a bound: `test/unit/agent/calibration.test.ts` checks it against measured
 * prompt tokens.
 */
export function estimateTokens(messages: readonly AgentMessage[], toolChars: number): number {
  return Math.ceil(promptChars(messages, toolChars) / CHARS_PER_TOKEN);
}

export type AgentTurnInput = {
  text: string;
  lang: Lang;
  nowMs: number;
  turn: TurnContext;
  history: readonly HistoryEntry[];
  /** The paired app runs action cards, so phone actions may be offered (§6.20). */
  cards?: boolean;
  /**
   * The app also saves a file a card carries (2026-10-05). Not kept in a
   * suspended turn: a resumed turn is not offered the export.
   */
  fileCards?: boolean;
  /** The paired app answers phone reads, and this is a typed message (§6.21). */
  phoneReads?: boolean;
  /** Which Google grants are connected, so only their tools are offered (2026-10-01). */
  grants?: { gmail?: boolean; tasks?: boolean; drive?: boolean };
  /**
   * The fallback model's turn (2026-10-05): reads only, and the model is told
   * so. Code enforces it — a tool not offered is refused as unknown.
   */
  readOnly?: boolean;
};

/**
 * A turn waiting for the phone (§6.21): everything needed to go on from the
 * tool call that asked, and nothing that would let it start over. Stored
 * encrypted for minutes (`turns.ts`); never logged.
 */
export type SuspendedState = {
  model: string;
  /** The app's conversation the turn belongs to, for its history (2026-10-01). */
  conversation?: string;
  /** The grants whose tools the turn was offered, so it resumes with the same ones. */
  grants?: { gmail?: boolean; tasks?: boolean; drive?: boolean };
  /** Everything after the system prompt, ending with the call that asked. */
  messages: AgentMessage[];
  spent: number;
  calls: number;
  tainted: boolean;
  readText?: string;
  /** The user's typed words, for the weekday check and the history. */
  text: string;
  lang: Lang;
  cards: boolean;
  toolCallId: string;
  tool: ToolName;
  query: PhoneReadInput;
  /**
   * The tools the turn was offered, narrowed by code (2026-10-06). Intersected
   * with a fresh `agentToolNames` on resume; absent in older states: the full set.
   */
  offered?: ToolName[];
};

export type AgentResult =
  | { kind: 'reply'; reply: Reply; tainted: boolean; byModel: boolean }
  | {
      kind: 'failed';
      errorCode: string;
      /** A tool was run through the orchestrator — falling back would run the message twice. */
      toolRan: boolean;
      /** The code-rendered text of a read that did complete, to answer with instead. */
      readText?: string;
      tainted: boolean;
    }
  /** A phone read was allowed: the turn waits for the phone's answer. */
  | { kind: 'suspend'; state: SuspendedState };

export type AgentDeps = {
  providers: readonly AgentProvider[];
  budget: TokenBudget;
  log: Logger;
  /**
   * The models that refused this message (§2b), shared with the parser and the
   * read-only try. Absent: a scope of this turn's own.
   */
  scope?: MessageScope;
  /**
   * The benchmark's OLD config only (`test/evals/run-turn-evals.ts`): the full
   * catalog on every call, as before 2026-10-06. Never set in production.
   */
  legacyCatalog?: boolean;
};

/** One turn in progress. The same whether it started now or resumed after a phone read. */
type Loop = {
  provider: AgentProvider;
  /** Call 0's reservation, taken when the model was chosen. */
  reserved?: Reservation | undefined;
  messages: AgentMessage[];
  spent: number;
  calls: number;
  tainted: boolean;
  toolRan: boolean;
  readText: string | undefined;
  /** Set once a phone read has answered: one per turn. */
  phoneReadDone: boolean;
  offered: ToolName[];
  tools: WireTool[];
  toolChars: number;
  text: string;
  lang: Lang;
  turn: TurnContext;
  cards: boolean;
  grants?: { gmail?: boolean; tasks?: boolean; drive?: boolean };
};

export async function runAgentTurn(input: AgentTurnInput, deps: AgentDeps): Promise<AgentResult> {
  const { budget } = deps;
  const readOnly = input.readOnly === true;
  const cards = !readOnly && input.cards === true;
  const offered: ToolName[] = agentToolNames({
    cards,
    fileCards: input.fileCards === true,
    phoneReads: !readOnly && input.phoneReads === true,
    ...(input.grants ? { grants: input.grants } : {}),
    ...(readOnly ? { readOnly } : {}),
  });
  // Code narrows the catalog to the one group the words name, or keeps it
  // whole (§4). It never adds a tool `agentToolNames` would not offer.
  const selection = deps.legacyCatalog ? { tools: offered, group: null } : selectTools(input.text, offered);
  const tools = wireTools(selection.tools);
  const toolChars = JSON.stringify(tools).length;
  const tainted = input.history.some((entry) => entry.tainted) || input.turn.tainted === true;
  deps.log.info('agent_tools', { group: selection.group ?? 'full', offered: selection.tools.length });

  const messages: AgentMessage[] = [
    { role: 'system', content: readOnly ? `${SYSTEM_PROMPT}\n${READ_ONLY_NOTE}` : SYSTEM_PROMPT },
  ];
  for (const entry of input.history) {
    messages.push({ role: 'user', content: entry.user });
    messages.push({ role: 'assistant', content: entry.reply });
  }
  messages.push({ role: 'user', content: `${nowLine(input.nowMs)}\n${languageLine(input.lang)}\n\n${input.text}` });

  // One model for the whole turn: the first that can take two calls of this
  // size, else one. Switching mid-turn would spend a second model's budget on a
  // conversation the first already paid for. Only call 0 is reserved here.
  const scope = deps.scope ?? newMessageScope();
  const prompt = estimateTokens(messages, toolChars);
  const candidates = deps.providers.filter((candidate) => !scope.refused.has(candidate.model));
  const reserveFor = (candidate: AgentProvider) =>
    prompt + (candidate.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS);
  const provider =
    candidates.find((candidate) => budget.fits(candidate.model, reserveFor(candidate) + prompt + COMPLETION_RESERVE)) ??
    candidates.find((candidate) => budget.fits(candidate.model, reserveFor(candidate)));
  const reserved = provider ? budget.reserve(provider.model, reserveFor(provider)) : null;
  if (!provider || !reserved) {
    // Every candidate lacked room: none is asked again for this message (§2b).
    for (const candidate of candidates) scope.refused.add(candidate.model);
    return { kind: 'failed', errorCode: 'budget_exhausted', toolRan: false, tainted };
  }

  return drive(
    {
      provider,
      reserved,
      messages,
      spent: 0,
      calls: 0,
      tainted,
      toolRan: false,
      readText: undefined,
      phoneReadDone: false,
      offered: selection.tools,
      tools,
      toolChars,
      text: input.text,
      lang: input.lang,
      turn: input.turn,
      cards,
      ...(input.grants ? { grants: input.grants } : {}),
    },
    { ...deps, scope },
  );
}

/**
 * Go on with a suspended turn, now that the phone has answered (§6.21).
 *
 * The same model, the same caps — calls and tokens already spent count — and
 * the same tools, so the conversation the model sees is the one it was having.
 * The answer is rendered by code, scrubbed, and taints the rest of the turn.
 * A phone that could not read ends the turn with code's own words.
 */
export async function resumeAgentTurn(
  state: SuspendedState,
  result: PhoneReadResult,
  turn: TurnContext,
  deps: AgentDeps,
): Promise<AgentResult> {
  if (result.status !== 'ok') {
    return {
      kind: 'reply',
      reply: { text: phoneReadRefused(state.query.kind, result.status, state.lang) },
      tainted: state.tainted,
      byModel: false,
    };
  }

  const readText = phoneReadText(state.query, result.items, state.lang);
  const provider = deps.providers.find((candidate) => candidate.model === state.model);
  if (!provider) {
    return { kind: 'failed', errorCode: 'model_unavailable', toolRan: true, readText, tainted: true };
  }

  const fresh = agentToolNames({ cards: state.cards, phoneReads: true, ...(state.grants ? { grants: state.grants } : {}) });
  // The narrowed set the turn started with, but never a tool no longer offered
  // (a grant revoked while the phone was reading).
  const offered = state.offered ? fresh.filter((tool) => state.offered!.includes(tool)) : fresh;
  const tools = wireTools(offered);
  return drive(
    {
      provider,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...state.messages,
        { role: 'tool', tool_call_id: state.toolCallId, content: resultForModel(readText) },
      ],
      spent: state.spent,
      calls: state.calls,
      tainted: true,
      toolRan: true,
      readText,
      phoneReadDone: true,
      offered,
      tools,
      toolChars: JSON.stringify(tools).length,
      text: state.text,
      lang: state.lang,
      turn,
      cards: state.cards,
      ...(state.grants ? { grants: state.grants } : {}),
    },
    deps,
  );
}

async function drive(loop: Loop, deps: AgentDeps): Promise<AgentResult> {
  const { log, budget } = deps;
  const model = loop.provider.model;

  const failed = (errorCode: string): AgentResult => ({
    kind: 'failed',
    errorCode,
    toolRan: loop.toolRan,
    ...(loop.readText === undefined ? {} : { readText: loop.readText }),
    tainted: loop.tainted,
  });

  const scope = deps.scope ?? newMessageScope();
  const turnCap = modelEntry(model)?.turnCap ?? TURN_TOKEN_CAP;
  const maxCompletion = loop.provider.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;

  while (loop.calls < MAX_MODEL_CALLS) {
    const call = loop.calls;
    // Text-only once a read has answered, and on the last call: the model can
    // only word the answer, and the catalog is not paid for again (§3).
    const textOnly =
      !deps.legacyCatalog && (loop.readText !== undefined || loop.phoneReadDone || call === MAX_MODEL_CALLS - 1);
    const tools = textOnly ? [] : loop.tools;
    const prompt = estimateTokens(loop.messages, textOnly ? 0 : loop.toolChars);
    if (loop.spent + prompt + COMPLETION_RESERVE > turnCap) {
      if (loop.reserved) budget.release(loop.reserved);
      return failed('turn_token_cap');
    }
    const reservation = loop.reserved ?? budget.reserve(model, prompt + maxCompletion);
    loop.reserved = undefined;
    if (!reservation) {
      scope.refused.add(model);
      return failed('budget_exhausted');
    }
    loop.calls++;

    let response: AgentResponse;
    try {
      response = await loop.provider.complete(loop.messages, tools);
    } catch (error) {
      budget.chargeUnanswered(reservation);
      throw error;
    }
    if (!response.ok) {
      if (response.error.code === 'rate_limited') {
        // One step: the reservation goes, the model is blocked, and this
        // message will not ask it again (§2b).
        budget.refused(reservation, response.error.retryAfterSeconds);
        scope.refused.add(model);
      } else if (wasNeverSent(response.error)) {
        budget.release(reservation);
      } else {
        budget.chargeUnanswered(reservation);
      }
      log.warn('agent_call_failed', { model, call, errorCode: response.error.code, status: response.error.status });
      return failed(response.error.code);
    }

    const measured = response.usage.promptTokens + response.usage.completionTokens;
    budget.settle(reservation, measured);
    // A reply without usage is charged its reservation, here as in the budget.
    loop.spent += measured > 0 ? measured : reservation.tokens;
    log.info('agent_call', {
      model,
      call,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      toolCalls: response.toolCalls.length,
    });

    const toolCall = response.toolCalls[0];
    if (!toolCall) {
      const text = cleanModelText(response.text ?? '');
      if (text.length === 0) return failed('empty_reply');
      return { kind: 'reply', reply: { text }, tainted: loop.tainted, byModel: true };
    }

    // One tool call per model call. A second one in the same response is not
    // run: the next call can ask for it once it has seen this one's result.
    const outcome = await runToolCall(toolCall, loop, log);
    if (outcome.kind === 'retry') {
      loop.messages.push({ role: 'assistant', content: null, tool_calls: [wireToolCall(toolCall)] });
      loop.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: outcome.result });
      continue;
    }

    const reply = outcome.reply;
    if (reply.deviceQuery) {
      // Nothing ran: the phone answers this, and the turn waits for it (§6.21).
      return {
        kind: 'suspend',
        state: {
          model,
          messages: [
            ...loop.messages.slice(1),
            { role: 'assistant', content: null, tool_calls: [wireToolCall(toolCall)] },
          ],
          spent: loop.spent,
          calls: loop.calls,
          tainted: loop.tainted,
          ...(loop.readText === undefined ? {} : { readText: loop.readText }),
          text: loop.text,
          lang: loop.lang,
          cards: loop.cards,
          ...(loop.grants ? { grants: loop.grants } : {}),
          toolCallId: toolCall.id,
          tool: outcome.tool,
          query: reply.deviceQuery,
          offered: loop.offered,
        },
      };
    }

    loop.toolRan = true;
    if (!reply.read) {
      // A backup's question is stored tainted, so the answered write still confirms (§6).
      const question = reply.question
        ? { ...reply.question, tainted: loop.tainted || loop.provider.role !== 'primary' }
        : undefined;
      return {
        kind: 'reply',
        reply: { ...reply, ...(question ? { question } : {}) },
        tainted: loop.tainted,
        byModel: false,
      };
    }

    if (TAINTING_TOOLS.has(outcome.tool) || reply.tainting) loop.tainted = true;
    loop.readText = reply.text;
    loop.messages.push({ role: 'assistant', content: null, tool_calls: [wireToolCall(toolCall)] });
    loop.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultForModel(reply.text) });
  }

  return failed('max_calls');
}

type ToolOutcome =
  | { kind: 'ran'; tool: ToolName; reply: Reply }
  /** Nothing ran; this goes back to the model as the tool's result. */
  | { kind: 'retry'; result: string };

async function runToolCall(call: ToolCall, loop: Loop, log: Logger): Promise<ToolOutcome> {
  const tool = fromWireName(call.name, loop.offered);
  if (!tool) {
    log.warn('agent_unknown_tool', {});
    return { kind: 'retry', result: '{"error":"unknown_tool"}' };
  }
  // One phone read per turn: a second would suspend a turn already resumed.
  if (loop.phoneReadDone && REGISTRY[tool].phoneRead) {
    return { kind: 'retry', result: '{"error":"one_phone_read_per_turn"}' };
  }

  let args: unknown;
  try {
    args = stripNulls(JSON.parse(call.arguments));
  } catch {
    return { kind: 'retry', result: '{"error":"arguments_not_json"}' };
  }

  // The arguments are model output, and pass the same strict schema a parsed
  // draft does (plan invariant 3). Issue paths are slot names, never values.
  const validated = validateIntentDraft({
    intent: tool,
    slots: args,
    language: loop.lang,
    missing: [],
    ambiguities: [],
  });
  if (!validated.ok) {
    log.info('agent_args_invalid', { tool, issues: validated.issues });
    return {
      kind: 'retry',
      result: JSON.stringify({ error: 'invalid_arguments', at: validated.issues.slice(0, 3) }),
    };
  }

  const checked = checkNamedWeekdays(validated.draft, loop.text);
  if (checked.mismatched.length > 0) {
    log.info('weekday_mismatch', { intent: tool, slotKeys: checked.mismatched.join(',') });
  }

  // A backup model's writes always confirm (§6). A provider with no role is a backup.
  const backupModel = loop.provider.role !== 'primary';
  const reply = await runIntent(
    checked.draft,
    { ...loop.turn, tainted: loop.tainted, ...(backupModel ? { backupModel: true } : {}) },
    { dayInDoubt: checked.mismatched },
  );
  return { kind: 'ran', tool, reply };
}

/** A read's code-rendered text, made fit for the model: no isolates, no addresses, capped. */
function resultForModel(text: string): string {
  return scrubForModel(stripIsolates(text)).slice(0, MAX_RESULT_CHARS);
}

/**
 * Model text is display-only (plan invariant 3). The app shows plain text, so
 * markdown is taken out, and the length is capped. Links are defanged where
 * every outbound message is, at the send boundary.
 */
export function cleanModelText(text: string): string {
  return text
    .replace(/\*\*|__/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
    .slice(0, MAX_REPLY_CHARS);
}
