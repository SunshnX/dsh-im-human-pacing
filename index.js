/**
 * dsh-im-human-pacing — send an IM reply as several human-paced bubbles.
 *
 * The model decides the segmentation: it calls `dsh_im_say` once per turn with
 * the bubbles it wants, and the tool sends every bubble but the last through
 * `dshIm.send()`, waiting a measured "typing + reading" pause before each one.
 * The last bubble is left to the model's own final message, so the channel's
 * ordinary reply path delivers it and nothing is sent twice.
 *
 * Pacing depends only on time already spent (`lastSendAt`) and the measured
 * length of the text queued, so the waits stay reproducible in tests.
 *
 * @module dsh-im-human-pacing
 */

import { randomUUID } from 'node:crypto'
import {
  computeSendDelayMs,
  draftTargetFor,
  isEnabledChannel,
  normalizeSettings,
  pruneSendTimes,
} from './lib/pacing.js'
import { fallbackSegments } from './lib/fallback.mjs'

export const name = 'dsh-im-human-pacing'

/**
 * `dshIm` is the IM plugin's session→conversation lookup and delivery service.
 * `agents` supplies the durable turn number that resets the per-turn budget.
 * Declaring both keeps this row inactive, rather than half-working, in a profile
 * that has neither.
 */
export const inject = ['dshIm', 'agents', 'tools', 'systemPrompt']

/**
 * Config is read through the standard-schema interface Cordis already calls, so
 * the bundle needs no runtime dependency on a schema library.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-im-human-pacing',
    validate(value) {
      return { value: normalizeSettings(value) }
    },
  },
}

/** Name of the sending tool, shared by its definition and the prompt context. */
export const SAY_TOOL = 'dsh_im_say'

/** Name of the optional diagnostic tool. */
export const SELF_TEST_TOOL = 'dsh_im_pacing_selftest'

/** Prompt-context slot; sorted after dsh-im's own source guidance (125). */
const PROMPT_CONTEXT_NAME = 'dsh-im-human-pacing'
const PROMPT_CONTEXT_ORDER = 130

/** Longest a single tool call may wait; the timeout policy refuses beyond it. */
const TOOL_TIMEOUT_MS = 240_000

/** Generation time the model already spends on the final bubble. */
const FINAL_BUBBLE_ALLOWANCE_MS = 1_200

/** Bound on tracked conversations, so abandoned chats cannot grow the map. */
const MAX_CONVERSATIONS = 512

const SELF_TEST_BUBBLES = [
  '自检消息一：这条会先到。',
  '自检消息二：这是打了一会儿字才发出来的第二条。',
  '自检消息三：这是最后一条，按正常回复发出。',
]

function abortError() {
  const error = new Error('The pacing wait was cancelled')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, signal?.reason ?? abortError())
    const timer = setTimeout(() => finish(resolve), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function nonEmpty(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toolError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function sessionIdOf(agent) {
  return agent?.session?.id ?? agent?.id
}

/**
 * The durable turn number this agent is currently inside, or `null`.
 *
 * `agents.turnBoundaryOf` reads the committed session log, so it is correct even
 * when no listener has run for the turn yet. A session with no committed turn
 * (or a Host without the service) reports `null`, which the ledger treats as a
 * stable key rather than as a reason to reset.
 */
/**
 * The IM conversation this session belongs to, or null.
 *
 * The authoritative lookup is `describeConversation`: it answers for every
 * channel and awaits the channel's own state store. `describeConversationSync`
 * is only a fast path, and it answers `null` for any channel whose adapter was
 * built without a synchronous state reader — WeChat is one of those — so it must
 * never be the only source a listener consults.
 */
function createConversationResolver({ dshIm, settings }) {
  const enabled = (described) => isRecord(described) && isEnabledChannel(described.channel, settings)

  /** Synchronous best effort; `null` also means "not known without awaiting". */
  const conversationSync = (sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    try {
      const described = dshIm.describeConversationSync?.(sessionId) ?? null
      return enabled(described) ? described : null
    } catch {
      return null
    }
  }

  /** Authoritative lookup, awaiting the channel state when needed. */
  const conversationAsync = async (sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) return null
    const known = conversationSync(sessionId)
    if (known) return known
    try {
      const described = await dshIm.describeConversation?.(sessionId)
      return enabled(described) ? described : null
    } catch {
      return null
    }
  }

  return { conversationSync, conversationAsync }
}

/**
 * The durable turn number this agent is currently inside, or `null`.
 *
 * `agents.turnBoundaryOf` reads the committed session log, so it is correct even
 * when no listener has run for the turn yet. A session with no committed turn
 * (or a Host without the service) reports `null`, which the ledger treats as a
 * stable key rather than as a reason to reset.
 */
function turnOf(agents, agent) {
  try {
    const turn = agents?.turnBoundaryOf?.(agent?.session)?.lastTurn
    return Number.isSafeInteger(turn) ? turn : null
  } catch {
    return null
  }
}

/** Concatenate the text parts of one committed assistant message. */
function textOfAssistantMessage(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

/**
 * The final assistant text of the turn that is about to close.
 *
 * The session log is the source of truth, so this reads the newest committed
 * assistant message rather than trusting a live stream buffer.
 *
 * @returns {string} the text, or `''` when the turn produced none
 */
function lastAssistantText(agent) {
  try {
    const session = agent?.session
    if (typeof session?.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'turn/end') continue
      if (event?.type === 'assistant/message') {
        const text = textOfAssistantMessage(event)
        if (text) return text
      }
      // Never reach back into an earlier turn's reply.
      if (event?.type === 'turn/start') return ''
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * The message that asks the model to split the reply it just wrote.
 *
 * It is a steering input, not a user request, so it says so and asks for one
 * concrete action. It deliberately carries no user-visible content: the user
 * already got their answer from the model itself.
 */
function reminderMessage() {
  const text = [
    '[reply-pacing] 这条提醒不是用户说的话。',
    '你刚刚写完的回复还没有拆成分条气泡发送给用户。',
    '请立刻调用 ' + SAY_TOOL + '，把刚才那段回复按顺序拆成 2 条以上的短气泡提交；',
    '工具会发出除最后一条外的所有气泡，然后由你接着把最后一条说完——',
    '它要和前面那几条连成同一口气，不要重新开头、不要重新回答用户。',
    '不要新增内容、不要解释这条提醒、不要提及工具。',
  ].join('\n')
  // A steered message is spliced into the session log as an `agent/inbox/spliced`
  // event, and the format-v4 reader refuses any inserted message whose source
  // lacks a producer-owned `kind` (and the shape validator requires an `id`).
  // A reminder without these fields corrupted the whole session on next load,
  // so both fields are mandatory here, matching how real user messages look.
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Per-conversation send bookkeeping.
 *
 * Two counters live here and they are deliberately independent:
 *
 * - `lastSendAt` / `sendTimes` describe this chat's recent sends and only ever
 *   shrink by ageing out of the rolling minute.
 * - `segmentsThisTurn` counts bubbles inside ONE turn, keyed by the durable
 *   turn number.
 *
 * The turn key must come from the session log, never from "the last time we saw
 * a message": a tool call can arrive before any listener has observed the new
 * turn, and a per-turn counter that never resets rejects every later call with
 * "over the limit" while nothing has been sent yet.
 */
class PacingLedger {
  #byConversation = new Map()

  /** @returns the mutable record for one conversation key, creating it. */
  chat(conversationKey) {
    let record = this.#byConversation.get(conversationKey)
    if (!record) {
      record = { lastSendAt: undefined, sendTimes: [], segmentsThisTurn: 0, turn: null }
      this.#byConversation.set(conversationKey, record)
      while (this.#byConversation.size > MAX_CONVERSATIONS) {
        this.#byConversation.delete(this.#byConversation.keys().next().value)
      }
    }
    return record
  }

  /**
   * Bind the record to one durable turn, resetting the per-turn budget when the
   * turn number moves. Called both from the inbox listener and from every tool
   * execution, so the counter is correct even if no listener ran first.
   *
   * A `turn === null` (the session has no committed turn yet) keeps whatever
   * budget the record already had for that same null turn.
   */
  observeTurn(conversationKey, turn) {
    if (!conversationKey) return
    const record = this.chat(conversationKey)
    if (record.turn === turn) return
    record.turn = turn
    record.segmentsThisTurn = 0
  }

  /** Drop everything for one conversation (its session was disposed). */
  forget(conversationKey) {
    if (conversationKey) this.#byConversation.delete(conversationKey)
  }
}

/**
 * Remembers, per conversation, what the plugin already did in the current turn:
 * whether the model called the tool, and whether the fallback already nudged or
 * split it. Keyed by the durable turn number so it resets with the turn.
 */
class TurnMemory {
  #byConversation = new Map()

  #record(conversationKey) {
    let record = this.#byConversation.get(conversationKey)
    if (!record) {
      record = { turn: null, usedTool: false, nudged: false, fellBack: false }
      this.#byConversation.set(conversationKey, record)
      while (this.#byConversation.size > MAX_CONVERSATIONS) {
        this.#byConversation.delete(this.#byConversation.keys().next().value)
      }
    }
    return record
  }

  /** @returns the flags for this conversation and turn, resetting on a new turn. */
  of(conversationKey, turn) {
    const record = this.#record(conversationKey)
    if (record.turn !== turn) {
      record.turn = turn
      record.usedTool = false
      record.nudged = false
      record.fellBack = false
    }
    return record
  }

  forget(conversationKey) {
    if (conversationKey) this.#byConversation.delete(conversationKey)
  }
}

/**
 * Serialize sends per conversation. Two tool calls in one step must not
 * interleave their bubbles: the reader would see them out of order.
 */
class ConversationLocks {
  #tails = new Map()

  run(conversationKey, operation) {
    const previous = this.#tails.get(conversationKey) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const settled = current.finally(() => {
      if (this.#tails.get(conversationKey) === settled) this.#tails.delete(conversationKey)
    })
    this.#tails.set(conversationKey, settled)
    return settled
  }
}

/**
 * Validate and normalize the model-supplied bubbles.
 *
 * @returns {{segments: string[]}} at least two non-empty bubbles.
 * @throws a tool-facing error naming the violated rule.
 */
function readSegments(raw, settings) {
  if (!Array.isArray(raw)) throw toolError('segments 必须是字符串数组。', 'invalid-bubbles')
  const segments = raw.map(nonEmpty)
  if (segments.some((segment) => segment === '')) {
    throw toolError('每一段都不能为空。', 'invalid-bubbles')
  }
  if (segments.length < 2) {
    throw toolError('至少需要 2 段；只有一段时请直接正常回答，不要调用本工具。', 'invalid-bubbles')
  }
  if (segments.length > settings.maxSegmentsPerTurn) {
    throw toolError(`一次最多 ${settings.maxSegmentsPerTurn} 段。`, 'invalid-bubbles')
  }
  const oversized = segments.find((segment) => segment.length > settings.maxCharsPerSegment)
  if (oversized) {
    throw toolError(
      `每段不能超过 ${settings.maxCharsPerSegment} 个字符，请拆得更短一些：${oversized.slice(0, 40)}…`,
      'invalid-bubbles',
    )
  }
  return { segments }
}

/** The reply-bubble tool definition. */
function createSayTool({
  settings, dshIm, resolveConversation, currentTurnOf, ledger, locks, now, random, sleepImpl, onToolUsed,
}) {
  /**
   * Send every bubble but the last, waiting a human pause before each one.
   *
   * Shared by the tool and by the fallback, so a reply the model forgot to split
   * still leaves the chat with the same rhythm. With `sendAll`, every bubble is
   * sent: the fallback needs that because the channel will deliver the model's
   * final text separately, and only the tail we suppress there is skipped.
   */
  const deliverPaced = async ({ conversation, segments, signal, sendAll = false }) => {
    const chat = ledger.chat(conversation.conversationKey)
    const sent = []
    const waits = []
    const lastIndex = sendAll ? segments.length : segments.length - 1
    for (let index = 0; index < segments.length; index += 1) {
      const text = segments[index]
      if (index >= lastIndex) {
        if (!sendAll) {
          // The model emits the last bubble itself, so only the part of the
          // pause its own generation time does not already cover belongs here.
          const at = now()
          chat.sendTimes = pruneSendTimes(chat.sendTimes, at)
          const waitMs = computeSendDelayMs({
            text, now: at, lastSendAt: chat.lastSendAt,
            recentCount: chat.sendTimes.length, random, settings,
          })
          const tail = Math.max(0, waitMs - FINAL_BUBBLE_ALLOWANCE_MS)
          await sleepImpl(tail, signal)
          waits.push(tail)
          return { sent, remaining: text, waits }
        }
      }
      const at = now()
      chat.sendTimes = pruneSendTimes(chat.sendTimes, at)
      const waitMs = computeSendDelayMs({
        text,
        now: at,
        lastSendAt: chat.lastSendAt,
        recentCount: chat.sendTimes.length,
        random,
        settings,
      })
      await sleepImpl(waitMs, signal)
      signal?.throwIfAborted()
      await dshIm.send(conversation.botId, conversation.draft, text, { signal, format: 'plain' })
      const sentAt = now()
      chat.lastSendAt = sentAt
      chat.sendTimes.push(sentAt)
      chat.segmentsThisTurn += 1
      waits.push(waitMs)
      sent.push(text)
    }
    return { sent, remaining: '', waits }
  }

  return {
    deliverPaced,
    definition: {
      name: SAY_TOOL,
      description:
        'Send a chat reply as several consecutive text messages with human-like typing pauses. '
        + 'In an enabled IM conversation, call this once per turn instead of writing one long '
        + 'answer. Treat the bubbles as ONE continuous reply delivered in pieces, not as '
        + 'separate answers. This tool sends every bubble except the last one, pausing before '
        + 'each. You then emit the last bubble yourself: it is the closing message of the same '
        + 'sequence, so it must continue directly from the bubble before it — same train of '
        + 'thought, no fresh greeting and no second answer to the user.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          segments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The reply split into short chat bubbles, in order — like consecutive text '
              + 'messages, not paragraphs of one document. Two or more entries; each entry is '
              + 'one bubble. Every entry except the last is sent immediately. The last entry is '
              + 'handed back to you to emit yourself, so it must read as the natural continuation '
              + 'of the bubble before it (no restarting the topic, no re-answering the user).',
          },
        },
        required: ['segments'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sentCount: { type: 'number' },
            remaining: { type: 'string' },
            waitedMs: { type: 'number' },
          },
          required: ['sentCount', 'remaining', 'waitedMs'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.remaining
            ? `${value.sentCount} 条已经发出去了。你还有最后一句没说完——`
              + `把它紧接着前面那几条说出来就行，别重新开头、别重新回答用户，`
              + `就当是同一口气里最后补的一句话。原样输出下面这段：\n\n${value.remaining}`
            : `${value.sentCount} 条已按节奏发出（累计等待 ${value.waitedMs} ms）。`,
        }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: Array.isArray(args?.segments) ? `分 ${args.segments.length} 条发送` : '分条发送',
        kind: 'other',
      }),
      async execute(args, exec) {
        const { segments } = readSegments(args?.segments, settings)
        const conversation = await resolveConversation(exec.agent)
        return locks.run(conversation.conversationKey, async () => {
          // Read the turn from the session log itself rather than trusting that
          // a listener already observed the new turn; this is what keeps the
          // per-turn budget correct on every call.
          ledger.observeTurn(conversation.conversationKey, currentTurnOf(exec.agent))
          const chat = ledger.chat(conversation.conversationKey)
          if (chat.segmentsThisTurn + segments.length > settings.maxSegmentsPerTurn) {
            throw toolError(
              `本轮气泡数超过上限 ${settings.maxSegmentsPerTurn}，请合并后再发。`,
              'turn-budget-exceeded',
            )
          }
          const result = await deliverPaced({ conversation, segments, signal: exec.signal })
          onToolUsed?.(conversation.conversationKey, currentTurnOf(exec.agent))
          return {
            sentCount: result.sent.length,
            remaining: result.remaining,
            waitedMs: result.waits.reduce((total, wait) => total + wait, 0),
          }
        })
      },
    },
  }
}

/** Diagnostic tool that sends a paced demo to the newest private target. */
function createSelfTestTool({ settings, dshIm, locks, deliverPaced }) {
  return {
    name: SELF_TEST_TOOL,
    description:
      'Diagnostic: send three short bubbles to the most recent private target of an enabled '
      + 'channel through the same paced path the reply tool uses, so the reader can confirm '
      + 'the bubbles arrive separately and with human gaps. Only for verifying the pacing '
      + 'plugin; never use it in normal conversation.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          botId: { type: 'string' },
          target: { type: 'string' },
          waits: { type: 'array', items: { type: 'number' } },
        },
        required: ['botId', 'target', 'waits'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已向 ${value.botId} 的 ${value.target} 发送 3 条演示气泡，`
          + `等待序列 ${value.waits.join(' / ')} ms。`,
      }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const bots = await dshIm.listBots()
      const bot = Array.isArray(bots)
        ? bots.find((entry) => isEnabledChannel(entry?.channel, settings))
        : undefined
      if (!bot) throw new Error('没有已连接的、可用的 IM 机器人。')
      const targets = await dshIm.listTargets(bot.botId)
      const target = Array.isArray(targets) ? targets.find((entry) => entry?.kind === 'user') : undefined
      if (!target) throw new Error('该机器人还没有可发送的私聊目标。')
      const conversation = {
        channel: bot.channel,
        botId: bot.botId,
        conversationKey: `pacing-selftest:${bot.botId}:${target.targetId}`,
        draft: { kind: target.kind, route: target.route },
      }
      const result = await locks.run(
        conversation.conversationKey,
        () => deliverPaced({ conversation, segments: SELF_TEST_BUBBLES, signal: exec.signal }),
      )
      return { botId: bot.botId, target: target.targetId, waits: result.waits }
    },
  }
}

/**
 * Build the Host plugin.
 *
 * @param {object} [internals] injection points for tests.
 */
export function createHumanPacingPlugin(internals = {}) {
  const sleepImpl = internals.sleep ?? sleep
  const now = internals.now ?? (() => Date.now())
  const random = internals.random ?? Math.random

  return Object.freeze({
    name,
    inject,
    Config,
    apply(ctx, rawConfig = {}) {
      const settings = normalizeSettings(rawConfig)
      const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : (ctx.logger ?? console)
      const ledger = new PacingLedger()
      const locks = new ConversationLocks()
      const dshIm = ctx.dshIm
      const agents = ctx.agents
      const { conversationSync, conversationAsync } = createConversationResolver({ dshIm, settings })

      const resolveConversation = async (agent) => {
        const described = await conversationAsync(sessionIdOf(agent))
        if (!isRecord(described)) {
          throw toolError(
            '当前会话不属于 IM 渠道，不需要分条发送；正常回答即可。',
            'not-an-im-conversation',
          )
        }
        if (!isEnabledChannel(described.channel, settings)) {
          throw toolError(`渠道 ${described.channel} 未启用拟人发送。`, 'channel-disabled')
        }
        const draft = draftTargetFor(described.channel, described.conversationKey)
        if (!draft) {
          throw toolError('无法从当前对话推导出发送目标，请正常回答。', 'unroutable-conversation')
        }
        return { ...described, draft }
      }

      /** Whether this agent's step should see the tool at all. */
      const toolAvailable = async (agent) => (await conversationAsync(sessionIdOf(agent))) !== null

      const turnMemory = new TurnMemory()

      const { definition: sayTool, deliverPaced } = createSayTool({
        settings,
        dshIm,
        resolveConversation,
        currentTurnOf: (agent) => turnOf(agents, agent),
        ledger,
        locks,
        now,
        random,
        sleepImpl,
        onToolUsed: (conversationKey, turn) => {
          turnMemory.of(conversationKey, turn).usedTool = true
        },
      })
      ctx.effect(
        () => ctx.tools.register(sayTool, { when: ({ agent }) => toolAvailable(agent) }),
        `tools.register(${SAY_TOOL})`,
      )

      if (settings.selfTest) {
        const selfTestTool = createSelfTestTool({ settings, dshIm, locks, deliverPaced })
        ctx.effect(() => ctx.tools.register(selfTestTool), `tools.register(${SELF_TEST_TOOL})`)
        logger.info?.('[im-pacing] self-test tool registered')
      }

      ctx.effect(() => ctx.systemPrompt.context({
        name: PROMPT_CONTEXT_NAME,
        order: PROMPT_CONTEXT_ORDER,
        text: (assembly) => {
          if (!conversationSync(sessionIdOf(assembly?.agent))) return ''
          return [
            'This reply goes to a chat app, so it must read like a person texting —',
            'several short consecutive messages, not one document broken into pieces.',
            `Before answering, call ${SAY_TOOL} once with the reply split into 2-${settings.maxSegmentsPerTurn}`
              + ` short bubbles of at most ${settings.maxCharsPerSegment} characters each.`,
            'The tool sends every bubble except the last one, pausing like a person typing.',
            'Then speak the last bubble yourself, as the SAME reply still in progress:',
            'it is the closing message of that sequence, so it must flow straight out of the',
            'previous bubble. Do not greet again, do not restate the question, do not answer',
            'the user a second time — just finish the thought the earlier bubbles started.',
            'Each bubble should be one thought: no markdown headings, tables, or long code blocks.',
            'When a single short bubble is the whole answer, do not call the tool; just reply.',
          ].join(' ')
        },
      }), `systemPrompt.context(${PROMPT_CONTEXT_NAME})`)

      // A new turn starts a fresh bubble budget. This listener is only an
      // accelerator: the tool re-reads the turn itself, so a missed event can
      // never leave a stale counter behind. It has to await the channel lookup,
      // because the synchronous one answers null for channels such as WeChat.
      ctx.on('agent/inbox/claimed', ({ agent, turn }) => {
        const sessionId = sessionIdOf(agent)
        const settle = async () => {
          const conversation = await conversationAsync(sessionId)
          if (conversation) ledger.observeTurn(conversation.conversationKey, turn)
        }
        void settle().catch(() => undefined)
      }, { global: true })

      // When the turn is about to close and the model never called the tool,
      // the chat would otherwise receive one long wall of text. Two layers
      // answer that, in order of preference:
      //
      // 1. `remindOnMiss` — steer one extra step asking the model to split it,
      //    because the model produces the best bubbles. Once per turn only.
      // 2. `autoSplitOnMiss` — if the reminder already happened (or is off),
      //    split the finished reply here and send the leading bubbles.
      //
      // The last bubble always stays with the model's own final message, exactly
      // like the tool path, so nothing is sent twice.
      ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        try {
          const conversation = await conversationAsync(sessionIdOf(agent))
          if (!conversation) return
          const memory = turnMemory.of(conversation.conversationKey, turn)
          if (memory.usedTool) return

          if (settings.remindOnMiss && !memory.nudged && typeof agent.steer === 'function') {
            memory.nudged = true
            agent.steer(reminderMessage())
            logger.info?.('[im-pacing] the model skipped the reply tool; asked it to split once')
            return
          }

          if (!settings.autoSplitOnMiss || memory.fellBack) return
          const finalText = lastAssistantText(agent)
          const segments = fallbackSegments(finalText, {
            targetChars: settings.fallbackTargetChars,
            maxChars: settings.maxCharsPerSegment,
            maxSegments: Math.min(settings.maxSegmentsPerTurn, 5),
          })
          if (segments.length < 2) return
          memory.fellBack = true
          // Send every bubble: the channel delivers the model's own final text
          // separately, so the tail must be sent here to avoid losing it.
          await locks.run(conversation.conversationKey, async () => {
            ledger.observeTurn(conversation.conversationKey, turn)
            await deliverPaced({ conversation, segments, signal, sendAll: true })
          })
          logger.info?.(`[im-pacing] the model skipped the reply tool; split ${segments.length} bubbles`)
        } catch (error) {
          // This listener runs at the turn boundary: a failure here must never
          // break the turn that the user is waiting on.
          logger.warn?.('[im-pacing] fallback delivery failed:', error?.message ?? error)
        }
      }, { global: true })

      ctx.on('agent/disposed', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        void Promise.resolve(conversationAsync(sessionId)).then((conversation) => {
          if (!conversation) return
          ledger.forget(conversation.conversationKey)
          turnMemory.forget(conversation.conversationKey)
        }).catch(() => undefined)
      }, { global: true })
    },
  })
}

export const apply = (ctx, config) => createHumanPacingPlugin().apply(ctx, config)
