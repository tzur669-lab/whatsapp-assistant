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
 *
 * In a smart conversation (2026-10-08) a call to a tool whose data source the
 * user has not allowed suspends too, before anything is resolved or read: the
 * user answers a card, and `resumeAfterConsent` runs the stored call through
 * this same path, or tells the model the user declined. At most two pauses a
 * turn: the card, then the phone read it allowed.
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
import { REGISTRY, TOOL_NAMES } from '../tools/registry.js';
import type { ConsentSource, ToolName } from '../tools/registry.js';
import type { PhoneReadInput, PhoneReadResult } from '../tools/phone-reads.js';
import { phoneReadRefused, phoneReadText } from '../render/phone-reads.js';
import type { MessageScope, Reservation, TokenBudget } from './budget.js';
import { CHARS_PER_TOKEN, newMessageScope, wasNeverSent } from './budget.js';
import { DEFAULT_MAX_COMPLETION_TOKENS, modelEntry } from './models.js';
import { selectionLabel, selectTools } from './tool-groups.js';
import type { Selection } from './tool-groups.js';
import type { HistoryEntry } from './history.js';
import { languageLine, nowLine, READ_ONLY_NOTE, SMART_NOTE, SYSTEM_PROMPT } from './prompt.js';
import type { AgentMessage, AgentProvider, AgentResponse, ToolCall, WireTool } from './provider.js';
import { wireToolCall } from './provider.js';
import { agentToolNames, fromWireName, smartOfferedTools, TAINTING_TOOLS, wireTools } from './tools.js';
import { consentSourceOf } from './consents.js';
import { MAX_SUSPENDS } from './turns.js';

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
export function estimateTokens(
  messages: readonly AgentMessage[],
  toolChars: number,
  charsPerToken: number = CHARS_PER_TOKEN,
): number {
  return Math.ceil(promptChars(messages, toolChars) / charsPerToken);
}

/** A smart model (`SMART_MODELS`): only a smart conversation's turn may run on it. */
function isSmart(provider: AgentProvider): boolean {
  return provider.role === 'smart';
}

/** A provider that is busy, not broken: worth asking again in a while. */
function isOverloaded(error: { code: string; status?: number }): boolean {
  return error.code === 'provider_error' && (error.status === 503 || error.status === 500);
}

/** A smart model's system prompt: today's, then the smart note (versioned apart, `prompt.ts`). */
const SMART_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n${SMART_NOTE}`;

/** The model's own limits, or today's defaults for a model the table does not list. */
function limitsOf(model: string): { turnCap: number; maxModelCalls: number; charsPerToken: number } {
  const entry = modelEntry(model);
  return {
    turnCap: entry?.turnCap ?? TURN_TOKEN_CAP,
    maxModelCalls: entry?.maxModelCalls ?? MAX_MODEL_CALLS,
    charsPerToken: entry?.charsPerToken ?? CHARS_PER_TOKEN,
  };
}

/**
 * Room a turn keeps above its first call: a read result to come back and a
 * worded answer (block H, 2026-10-07).
 */
export const FIT_HEADROOM = 1_000;

/**
 * The newest history that fits `limit`, never less than the last exchange.
 * Pure. `estimate` prices a whole first call with the given history.
 */
export function fitHistory(
  history: readonly HistoryEntry[],
  estimate: (history: readonly HistoryEntry[]) => number,
  limit: number,
): { history: readonly HistoryEntry[]; dropped: number } {
  let start = 0;
  while (history.length - start > 1 && estimate(history.slice(start)) > limit) start++;
  return { history: history.slice(start), dropped: start };
}

export type AgentTurnInput = {
  text: string;
  lang: Lang;
  nowMs: number;
  turn: TurnContext;
  history: readonly HistoryEntry[];
  /** Facts about the user (§6.26), oldest first. The fitter drops them after the history. */
  facts?: readonly string[];
  /** The paired app runs action cards, so phone actions may be offered (§6.20). */
  cards?: boolean;
  /**
   * The app also saves a file a card carries (2026-10-05). Kept in a smart
   * turn waiting for consent, so an approved export still runs (slice 5); a
   * local turn's resume is not offered the export, as before.
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
  /**
   * The turn belongs to a smart conversation (2026-10-08): it is offered what
   * `smartOfferedTools` keeps, on every model, the facts are never sent, and a
   * smart model among the providers may take it. Absent: a smart model is never
   * asked, whatever the providers hold.
   */
  smart?: boolean;
  /**
   * A smart conversation's consents (slice 5). `granted`: the sources it
   * allowed; their tools are offered and run. `ask`: the tools of every other
   * consent source are offered too, and a call to one suspends the turn for the
   * user's answer instead of running. Only on the conversation's own typed
   * words — never a voice note, the read-only try or shared text. Absent:
   * public tools only.
   */
  consent?: { granted: readonly ConsentSource[]; ask: boolean };
};

/** The user's answer on a consent card (slice 5). */
export type ConsentDecision = 'once' | 'conversation' | 'declined';

/**
 * A turn waiting for the phone (§6.21) or for the user's consent (slice 5):
 * everything needed to go on from the tool call that asked, and nothing that
 * would let it start over. Stored encrypted for minutes (`turns.ts`); never
 * logged. A phone turn carries its query; a consent turn the source it asks.
 */
export type SuspendedState = SuspendedCommon &
  (
    | {
        /** Absent in every state stored before consent: the phone. */
        kind?: 'phone';
        query: PhoneReadInput;
        source?: undefined;
      }
    | {
        kind: 'consent';
        /** The source the card asks for: the stored call's tool's. */
        source: ConsentSource;
        query?: undefined;
      }
  );

type SuspendedCommon = {
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
  /**
   * The tools the turn was offered, narrowed by code (2026-10-06). Intersected
   * with a fresh `agentToolNames` on resume; absent in older states: the full set.
   */
  offered?: ToolName[];
  /**
   * The conversation's mode (2026-10-08). It picks the providers a resume may
   * use and the tools it may keep. Absent in older states: local.
   */
  mode?: 'smart' | 'local';
  /** The message was someone else's words (shared or forwarded). Set by the pipeline. */
  foreign?: boolean;
  /** Sources the user approved for this turn only (slice 5): the history may keep what they showed. */
  once?: ConsentSource[];
  /** The pauses this turn has made, this one included (slice 5). Absent: one. */
  suspends?: number;
  /** A smart turn's app saves files (slice 5): an approved export is still offered. */
  fileCards?: boolean;
};

export type AgentResult =
  | {
      kind: 'reply';
      reply: Reply;
      tainted: boolean;
      byModel: boolean;
      /**
       * Every tool that ran in the turn, reads included (2026-10-08). The
       * history gate decides from their data sources what a smart conversation
       * may keep. Absent: none ran.
       */
      tools?: ToolName[];
      /** Sources the user approved for this turn only (slice 5). Absent: none. */
      once?: ConsentSource[];
    }
  | {
      kind: 'failed';
      errorCode: string;
      /** A tool was run through the orchestrator — falling back would run the message twice. */
      toolRan: boolean;
      /** The code-rendered text of a read that did complete, to answer with instead. */
      readText?: string;
      tainted: boolean;
      tools?: ToolName[];
      once?: ConsentSource[];
    }
  /** A phone read was allowed, or a source needs the user's consent: the turn waits. */
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
  /**
   * The pauses this turn has made so far (2026-10-08; it replaced a "phone
   * read done" flag). A model's call may pause the turn only while none has;
   * the call the user approved may make the second (`MAX_SUSPENDS`).
   */
  suspends: number;
  /** The user declined access (slice 5): the model may only word its answer. */
  declined: boolean;
  /** Consent sources the turn may use without asking: allowed in the conversation, or for this turn. */
  allowed: Set<ConsentSource>;
  /** Of those, the ones approved for this turn only. */
  once: ConsentSource[];
  /** A call to a source not allowed asks the user (true) or is refused (false). */
  ask: boolean;
  offered: ToolName[];
  tools: WireTool[];
  toolChars: number;
  text: string;
  lang: Lang;
  turn: TurnContext;
  cards: boolean;
  fileCards: boolean;
  grants?: { gmail?: boolean; tasks?: boolean; drive?: boolean };
  /** The conversation's mode, kept in a suspended state. */
  mode: 'smart' | 'local';
  /** The tools that ran so far, in order. */
  ran: ToolName[];
};

/** One way to start the turn: its catalog, its first call's messages and their estimate. */
type Plan = {
  selection: Selection;
  tools: WireTool[];
  toolChars: number;
  messages: AgentMessage[];
  /** The first call's estimated prompt tokens. */
  prompt: number;
};

export async function runAgentTurn(input: AgentTurnInput, deps: AgentDeps): Promise<AgentResult> {
  const { budget } = deps;
  const readOnly = input.readOnly === true;
  const cards = !readOnly && input.cards === true;
  const smartConversation = input.smart === true;
  const base: ToolName[] = agentToolNames({
    cards,
    fileCards: input.fileCards === true,
    phoneReads: !readOnly && input.phoneReads === true,
    ...(input.grants ? { grants: input.grants } : {}),
    ...(readOnly ? { readOnly } : {}),
  });
  // A smart conversation's turn is offered the same tools whichever model takes
  // it: consent belongs to the conversation (2026-10-08). The public ones, the
  // allowed sources', and — when it may ask — every other consent source's.
  const granted = smartConversation ? (input.consent?.granted ?? []) : [];
  const ask = smartConversation && !readOnly && input.consent?.ask === true;
  const offered = smartConversation ? smartOfferedTools(base, { granted, ask }) : base;
  // A smart model never takes a turn that is not a smart conversation's, even
  // if a caller handed one in: the pipeline's lists are the first lock, this
  // the second.
  const providers = smartConversation ? deps.providers : deps.providers.filter((candidate) => !isSmart(candidate));
  const tainted = input.history.some((entry) => entry.tainted) || input.turn.tainted === true;

  // Facts the user asked to be remembered about them (§6.26): their own words,
  // checked at save time for anything the model must not see. Never in a
  // smart conversation (2026-10-08).
  const allFacts = smartConversation ? [] : (input.facts ?? []);
  const aboutLine = (facts: readonly string[]) => (facts.length > 0 ? `\nAbout the user: ${facts.join('; ')}` : '');
  const build = (system: string, history: readonly HistoryEntry[], facts: readonly string[]): AgentMessage[] => [
    { role: 'system', content: system },
    // A replayed reply is scrubbed like a read's result (2026-10-08): a reply
    // code built — a card, a list of choices — may hold an address, a link or
    // a number. The user's own words, past and present, go as is (invariant 2).
    ...history.flatMap((entry): AgentMessage[] => [
      { role: 'user', content: entry.user },
      { role: 'assistant', content: scrubForModel(entry.reply) },
    ]),
    {
      role: 'user',
      content: `${nowLine(input.nowMs)}\n${languageLine(input.lang)}${aboutLine(facts)}\n\n${input.text}`,
    },
  ];

  // The budget fitter (block H, 2026-10-07): once, before the estimate and the
  // reservation, never between calls. Over the line, the oldest exchanges go
  // first; the last one stays, because "כן, את זה" points at it. The facts are
  // small and worth more than old history: they go only if the first call
  // would not fit the cap at all — not merely the headroom above it.
  const plan = (selection: Selection, system: string, turnCap: number, charsPerToken: number): Plan => {
    const tools = wireTools(selection.tools);
    const toolChars = JSON.stringify(tools).length;
    deps.log.info('agent_tools', { group: selectionLabel(selection), offered: selection.tools.length });
    const estimate = (messages: readonly AgentMessage[]) => estimateTokens(messages, toolChars, charsPerToken);
    const limit = turnCap - COMPLETION_RESERVE - FIT_HEADROOM;
    const fitted = fitHistory(input.history, (history) => estimate(build(system, history, allFacts)), limit);
    const facts = estimate(build(system, fitted.history, allFacts)) > turnCap - COMPLETION_RESERVE ? [] : allFacts;
    if (fitted.dropped > 0 || facts.length < allFacts.length) {
      deps.log.info('agent_fit', { dropped: fitted.dropped, factsDropped: facts.length < allFacts.length });
    }
    const messages = build(system, fitted.history, facts);
    return { selection, tools, toolChars, messages, prompt: estimate(messages) };
  };

  // Today's turn, for a local model: code narrows the catalog to the groups
  // the words name, or keeps it whole (§4) — it never adds a tool `offered`
  // lacks — and the cap is the lowest of the local models'.
  let localPlan: Plan | undefined;
  const local = (): Plan =>
    (localPlan ??= plan(
      deps.legacyCatalog ? { tools: offered, groups: [] } : selectTools(input.text, offered),
      readOnly ? `${SYSTEM_PROMPT}\n${READ_ONLY_NOTE}` : SYSTEM_PROMPT,
      Math.min(
        ...providers
          .filter((candidate) => !isSmart(candidate))
          .map((candidate) => modelEntry(candidate.model)?.turnCap ?? TURN_TOKEN_CAP),
      ),
      CHARS_PER_TOKEN,
    ));
  // A smart model's turn (2026-10-08): no selection — selection only ever
  // saved tokens, never guarded anything — the smart note, its own limits.
  const smartPlans = new Map<string, Plan>();
  const smart = (candidate: AgentProvider): Plan => {
    let found = smartPlans.get(candidate.model);
    if (!found) {
      const limits = limitsOf(candidate.model);
      const system = readOnly ? `${SMART_SYSTEM_PROMPT}\n${READ_ONLY_NOTE}` : SMART_SYSTEM_PROMPT;
      found = plan({ tools: offered, groups: [] }, system, limits.turnCap, limits.charsPerToken);
      smartPlans.set(candidate.model, found);
    }
    return found;
  };
  const planFor = (candidate: AgentProvider): Plan => (isSmart(candidate) ? smart(candidate) : local());

  // One model for the whole turn: the first that can take two calls of this
  // size, else one. Switching mid-turn would spend a second model's budget on a
  // conversation the first already paid for. Only call 0 is reserved here.
  // A smart model's turn is sized by its own plan, so the model is chosen
  // before the tools; a local-only turn is planned up front, as before.
  const scope = deps.scope ?? newMessageScope();
  const candidates = providers.filter((candidate) => !scope.refused.has(candidate.model));
  if (!candidates.some(isSmart)) local();
  const reserveFor = (candidate: AgentProvider) =>
    planFor(candidate).prompt + (candidate.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS);
  const provider =
    candidates.find((candidate) =>
      budget.fits(candidate.model, reserveFor(candidate) + planFor(candidate).prompt + COMPLETION_RESERVE),
    ) ?? candidates.find((candidate) => budget.fits(candidate.model, reserveFor(candidate)));
  const reserved = provider ? budget.reserve(provider.model, reserveFor(provider)) : null;
  if (!provider || !reserved) {
    // Every candidate lacked room: none is asked again for this message (§2b).
    for (const candidate of candidates) scope.refused.add(candidate.model);
    return { kind: 'failed', errorCode: 'budget_exhausted', toolRan: false, tainted };
  }
  const chosen = planFor(provider);

  return drive(
    {
      provider,
      reserved,
      messages: chosen.messages,
      spent: 0,
      calls: 0,
      tainted,
      toolRan: false,
      readText: undefined,
      suspends: 0,
      declined: false,
      allowed: new Set(granted),
      once: [],
      ask,
      offered: chosen.selection.tools,
      tools: chosen.tools,
      toolChars: chosen.toolChars,
      text: input.text,
      lang: input.lang,
      turn: input.turn,
      cards,
      fileCards: cards && input.fileCards === true,
      ...(input.grants ? { grants: input.grants } : {}),
      mode: smartConversation ? 'smart' : 'local',
      ran: [],
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
 *
 * `granted`: a smart conversation's allowed sources now (slice 5).
 */
export async function resumeAgentTurn(
  state: SuspendedState,
  result: PhoneReadResult,
  turn: TurnContext,
  deps: AgentDeps,
  granted: readonly ConsentSource[] = [],
): Promise<AgentResult> {
  // A consent turn is never the phone's to answer (`turns.ts` refuses it first).
  if (state.kind === 'consent') return { kind: 'failed', errorCode: 'state_kind', toolRan: false, tainted: true };
  const once = state.once ?? [];

  if (result.status !== 'ok') {
    return {
      kind: 'reply',
      reply: { text: phoneReadRefused(state.query.kind, result.status, state.lang) },
      tainted: state.tainted,
      byModel: false,
    };
  }

  const readText = phoneReadText(state.query, result.items, state.lang);
  // What ran before the phone was asked, the phone read included: from the
  // stored calls, for the history gate.
  const ran = ranIn(state.messages);
  const resumed = resumeOn(state, deps, [...granted, ...once]);
  if (!resumed) {
    return {
      kind: 'failed',
      errorCode: 'model_unavailable',
      toolRan: true,
      readText,
      tainted: true,
      ...(ran.length > 0 ? { tools: ran } : {}),
      ...(once.length > 0 ? { once: [...once] } : {}),
    };
  }

  return drive(
    {
      ...resumed,
      messages: [
        { role: 'system', content: isSmart(resumed.provider) ? SMART_SYSTEM_PROMPT : SYSTEM_PROMPT },
        ...state.messages,
        { role: 'tool', tool_call_id: state.toolCallId, content: resultForModel(readText) },
      ],
      spent: state.spent,
      calls: state.calls,
      tainted: true,
      toolRan: true,
      readText,
      // The phone read was a pause: a second one now would be the model's own.
      suspends: state.suspends ?? 1,
      declined: false,
      once: [...once],
      text: state.text,
      lang: state.lang,
      turn,
      cards: state.cards,
      fileCards: state.fileCards === true,
      ...(state.grants ? { grants: state.grants } : {}),
      ran,
    },
    deps,
  );
}

/**
 * Go on with a turn that waited for the user's consent (slice 5).
 *
 * Approved — for this turn or for the conversation — the stored call runs now
 * through the path every call takes (strict Zod, the weekday check, `resolve`,
 * policy, confirm), exactly as if the model had just asked; a phone read it
 * leads to pauses the turn a second time. Declined, nothing runs: the model is
 * told so, and may only word its answer. Same model, same caps, as after a
 * phone read.
 *
 * `granted`: the conversation's allowed sources now, read after the tap.
 */
export async function resumeAfterConsent(
  state: SuspendedState,
  decision: ConsentDecision,
  granted: readonly ConsentSource[],
  turn: TurnContext,
  deps: AgentDeps,
): Promise<AgentResult> {
  if (state.kind !== 'consent' || state.mode !== 'smart') return { kind: 'failed', errorCode: 'state_kind', toolRan: false, tainted: true };
  const source = state.source;
  const once = [...(state.once ?? [])];
  if (decision === 'once' && !once.includes(source)) once.push(source);
  const allowed = decision === 'declined' ? [...granted, ...once] : [...granted, ...once, source];
  // The call waiting for the answer is the last message; it has not run.
  const ran = ranIn(state.messages.slice(0, -1));
  const toolRan = state.readText !== undefined;

  const resumed = resumeOn(state, deps, allowed);
  if (!resumed) {
    return {
      kind: 'failed',
      errorCode: 'model_unavailable',
      toolRan,
      ...(state.readText === undefined ? {} : { readText: state.readText }),
      tainted: state.tainted,
      ...(ran.length > 0 ? { tools: ran } : {}),
      ...(once.length > 0 ? { once } : {}),
    };
  }

  const last = state.messages.at(-1);
  const stored = last?.role === 'assistant' ? last.tool_calls?.[0] : undefined;
  if (!stored || stored.id !== state.toolCallId || fromWireName(stored.function.name, [state.tool]) !== state.tool) {
    return { kind: 'failed', errorCode: 'state_kind', toolRan, tainted: state.tainted };
  }

  const loop: Loop = {
    ...resumed,
    messages: [{ role: 'system', content: isSmart(resumed.provider) ? SMART_SYSTEM_PROMPT : SYSTEM_PROMPT }, ...state.messages],
    spent: state.spent,
    calls: state.calls,
    tainted: state.tainted,
    toolRan,
    readText: state.readText,
    suspends: state.suspends ?? 1,
    declined: decision === 'declined',
    once,
    text: state.text,
    lang: state.lang,
    turn,
    cards: state.cards,
    fileCards: state.fileCards === true,
    ...(state.grants ? { grants: state.grants } : {}),
    ran,
  };

  if (decision === 'declined') {
    loop.messages.push({ role: 'tool', tool_call_id: state.toolCallId, content: declinedResult(source) });
    return drive(loop, deps);
  }
  const signature = stored.extra_content?.google.thought_signature;
  return drive(loop, deps, {
    id: stored.id,
    name: stored.function.name,
    arguments: stored.function.arguments,
    ...(signature === undefined ? {} : { signature }),
  });
}

/** What the model is told when the user declined: the source, and nothing else. */
function declinedResult(source: ConsentSource): string {
  return JSON.stringify({ error: 'user_declined_access', source });
}

/**
 * Who goes on with a stored turn, and with which tools: the same model, if the
 * stored mode still allows it — a smart model only for a smart conversation's
 * turn; a state stored before modes is local — and the tools the turn started
 * with, never one no longer offered (a grant revoked meanwhile) and in a smart
 * conversation never more than it may be offered now. A resumed turn asks no
 * one again: a source not allowed by now is refused.
 */
function resumeOn(
  state: SuspendedState,
  deps: AgentDeps,
  allowed: readonly ConsentSource[],
): Pick<Loop, 'provider' | 'offered' | 'tools' | 'toolChars' | 'mode' | 'allowed' | 'ask'> | null {
  const mode = state.mode ?? 'local';
  const candidates = mode === 'smart' ? deps.providers : deps.providers.filter((candidate) => !isSmart(candidate));
  const provider = candidates.find((candidate) => candidate.model === state.model);
  if (!provider) return null;

  const fresh = agentToolNames({
    cards: state.cards,
    fileCards: state.fileCards === true,
    phoneReads: true,
    ...(state.grants ? { grants: state.grants } : {}),
  });
  const narrowed = state.offered ? fresh.filter((tool) => state.offered!.includes(tool)) : fresh;
  const offered = mode === 'smart' ? smartOfferedTools(narrowed, { granted: allowed, ask: false }) : narrowed;
  const tools = wireTools(offered);
  return {
    provider,
    offered,
    tools,
    toolChars: JSON.stringify(tools).length,
    mode,
    allowed: new Set(mode === 'smart' ? allowed : []),
    ask: false,
  };
}

/** The registry tools a stored conversation called, in order. */
function ranIn(messages: readonly AgentMessage[]): ToolName[] {
  const ran: ToolName[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      const tool = fromWireName(call.function.name, TOOL_NAMES);
      if (tool) ran.push(tool);
    }
  }
  return ran;
}

/**
 * Run the turn: the model, its calls, until a reply, a pause or a failure.
 * `approved`: the call the user just allowed on a consent card (slice 5), run
 * first — exactly as if the model had just asked for it, without a model call
 * — and already the last message.
 */
async function drive(loop: Loop, deps: AgentDeps, approved?: ToolCall): Promise<AgentResult> {
  const { log, budget } = deps;
  const model = loop.provider.model;

  const ranTools = () => ({
    ...(loop.ran.length > 0 ? { tools: [...loop.ran] } : {}),
    ...(loop.once.length > 0 ? { once: [...loop.once] } : {}),
  });
  const failed = (errorCode: string): AgentResult => ({
    kind: 'failed',
    errorCode,
    toolRan: loop.toolRan,
    ...(loop.readText === undefined ? {} : { readText: loop.readText }),
    tainted: loop.tainted,
    ...ranTools(),
  });

  /** What a pause stores: the conversation up to and including the call that paused it. */
  const paused = (toolCall: ToolCall, tool: ToolName, callStored: boolean): SuspendedCommon => {
    const suspends = loop.suspends + 1;
    return {
      model,
      messages: callStored
        ? loop.messages.slice(1)
        : [...loop.messages.slice(1), { role: 'assistant', content: null, tool_calls: [wireToolCall(toolCall)] }],
      spent: loop.spent,
      calls: loop.calls,
      tainted: loop.tainted,
      ...(loop.readText === undefined ? {} : { readText: loop.readText }),
      text: loop.text,
      lang: loop.lang,
      cards: loop.cards,
      ...(loop.grants ? { grants: loop.grants } : {}),
      toolCallId: toolCall.id,
      tool,
      offered: loop.offered,
      ...(loop.mode === 'smart' ? { mode: loop.mode } : {}),
      ...(loop.once.length > 0 ? { once: [...loop.once] } : {}),
      ...(suspends > 1 ? { suspends } : {}),
      // Only a smart turn keeps it: a local turn's stored state is as before.
      ...(loop.mode === 'smart' && loop.fileCards ? { fileCards: true } : {}),
    };
  };

  /** Run one call. Null: back to the model. Otherwise the turn ends, or pauses, here. */
  const act = async (toolCall: ToolCall, isApproved: boolean): Promise<AgentResult | null> => {
    // The approved call is already the last message; a model's is added here.
    const addCall = () => {
      if (!isApproved) loop.messages.push({ role: 'assistant', content: null, tool_calls: [wireToolCall(toolCall)] });
    };
    const outcome = await runToolCall(toolCall, loop, log, isApproved);
    if (outcome.kind === 'retry') {
      addCall();
      loop.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: outcome.result });
      return null;
    }

    if (outcome.kind === 'consent') {
      // Nothing was resolved or read: the user answers first (slice 5).
      return {
        kind: 'suspend',
        state: { ...paused(toolCall, outcome.tool, isApproved), kind: 'consent', source: outcome.source },
      };
    }

    const reply = outcome.reply;
    if (reply.deviceQuery) {
      // Nothing ran: the phone answers this, and the turn waits for it (§6.21).
      return { kind: 'suspend', state: { ...paused(toolCall, outcome.tool, isApproved), query: reply.deviceQuery } };
    }

    loop.toolRan = true;
    loop.ran.push(outcome.tool);
    if (!reply.read) {
      // A reply that ends the turn still carries what it read: a terminal read
      // of mail, or a card built from an event, is someone else's words in the
      // history the model sees next time (2026-10-06).
      const tainted = loop.tainted || TAINTING_TOOLS.has(outcome.tool) || reply.tainting === true;
      // A backup's question is stored tainted, so the answered write still confirms (§6).
      const question = reply.question
        ? { ...reply.question, tainted: tainted || loop.provider.role !== 'primary' }
        : undefined;
      return {
        kind: 'reply',
        reply: { ...reply, ...(question ? { question } : {}) },
        tainted,
        byModel: false,
        ...ranTools(),
      };
    }

    if (TAINTING_TOOLS.has(outcome.tool) || reply.tainting) loop.tainted = true;
    loop.readText = reply.text;
    addCall();
    loop.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultForModel(reply.text) });
    return null;
  };

  if (approved) {
    const ended = await act(approved, true);
    if (ended) return ended;
  }

  const scope = deps.scope ?? newMessageScope();
  // The model's own caps (2026-10-08); a Groq model's are today's.
  const { turnCap, maxModelCalls, charsPerToken } = limitsOf(model);
  const maxCompletion = loop.provider.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;

  while (loop.calls < maxModelCalls) {
    const call = loop.calls;
    // Text-only once a read has answered (a phone's included), once the user
    // declined access, and on the last call: the model can only word the
    // answer, and the catalog is not paid for again (§3).
    const textOnly =
      !deps.legacyCatalog && (loop.readText !== undefined || loop.declined || call === maxModelCalls - 1);
    const tools = textOnly ? [] : loop.tools;
    const prompt = estimateTokens(loop.messages, textOnly ? 0 : loop.toolChars, charsPerToken);
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
        // `daily` comes only from a Gemini 429 (provider.ts); never set for Groq.
        budget.refused(reservation, response.error.retryAfterSeconds, response.error.daily === true ? 'day' : undefined);
        scope.refused.add(model);
      } else if (isSmart(loop.provider) && isOverloaded(response.error)) {
        // A smart model that is busy (503 "high demand", or a 500) rests on
        // the 429 ladder, so the next message picks a local model; this one
        // goes to the parser, as after a 429 (2026-10-08). Groq: as before.
        budget.refused(reservation, undefined, 'overloaded');
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
      return { kind: 'reply', reply: { text }, tainted: loop.tainted, byModel: true, ...ranTools() };
    }

    // One tool call per model call. A second one in the same response is not
    // run: the next call can ask for it once it has seen this one's result.
    const ended = await act(toolCall, false);
    if (ended) return ended;
  }

  return failed('max_calls');
}

type ToolOutcome =
  | { kind: 'ran'; tool: ToolName; reply: Reply }
  /** Nothing ran; this goes back to the model as the tool's result. */
  | { kind: 'retry'; result: string }
  /** Nothing ran: the source is not allowed, and the user is asked (slice 5). */
  | { kind: 'consent'; tool: ToolName; source: ConsentSource };

async function runToolCall(call: ToolCall, loop: Loop, log: Logger, approved: boolean): Promise<ToolOutcome> {
  const tool = fromWireName(call.name, loop.offered);
  if (!tool) {
    log.warn('agent_unknown_tool', {});
    return { kind: 'retry', result: '{"error":"unknown_tool"}' };
  }
  // A model's call may pause the turn only while it has not paused; the call
  // the user approved may make the second pause (2026-10-08). So one phone
  // read per turn: a second would suspend a turn already resumed.
  const maySuspend = loop.suspends === 0 || (approved && loop.suspends < MAX_SUSPENDS);
  if (REGISTRY[tool].phoneRead && !maySuspend) {
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

  // Consent (smart conversations, slice 5): a source the conversation has not
  // allowed is never resolved or read. A turn that may ask pauses for the
  // user's answer; one that may not — a resumed turn, a second ask — is
  // refused like a tool not offered.
  const source = loop.mode === 'smart' ? consentSourceOf(tool) : null;
  if (source !== null && !loop.allowed.has(source)) {
    if (!loop.ask || !maySuspend) {
      log.info('agent_consent_refused', { tool, source });
      return { kind: 'retry', result: '{"error":"access_not_allowed"}' };
    }
    log.info('agent_consent_needed', { tool, source });
    return { kind: 'consent', tool, source };
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
