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

import {
  computeSendDelayMs,
  draftTargetFor,
  isEnabledChannel,
  normalizeSettings,
  pruneSendTimes,
} from './lib/pacing.js'

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
  settings, dshIm, resolveConversation, currentTurnOf, ledger, locks, now, random, sleepImpl,
}) {
  /** Send every bubble but the last, waiting a human pause before each one. */
  const deliverPaced = async ({ conversation, segments, signal }) => {
    const chat = ledger.chat(conversation.conversationKey)
    const sent = []
    const waits = []
    for (let index = 0; index < segments.length; index += 1) {
      const text = segments[index]
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
      if (index === segments.length - 1) {
        // The model emits this bubble itself, so only the part of the pause its
        // own generation time does not already cover belongs here.
        const tail = Math.max(0, waitMs - FINAL_BUBBLE_ALLOWANCE_MS)
        await sleepImpl(tail, signal)
        waits.push(tail)
        return { sent, remaining: text, waits }
      }
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
        'Send the user a chat reply split into several separate bubbles with human-like '
        + 'typing pauses. In an enabled IM conversation, call this once per turn instead of '
        + 'writing one long answer. This tool sends every bubble except the last one, pausing '
        + 'before each; the LAST bubble is not sent here — write it as your final message, '
        + 'word for word, with nothing added before or after it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          segments: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The reply split into short chat bubbles, in order. Two or more entries; each '
              + 'entry is one bubble. Keep each bubble short and conversational, the way a '
              + 'person texts. The last entry is what your final message must repeat.',
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
            ? `${value.sentCount} 条气泡已按节奏发出（累计等待 ${value.waitedMs} ms）。`
              + `现在只输出下面这一段作为最终回复，一字不改：\n\n${value.remaining}`
            : `${value.sentCount} 条气泡已按节奏发出（累计等待 ${value.waitedMs} ms）。`,
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
            'This reply goes to a chat app, so it must read like a person texting.',
            `Before answering, call ${SAY_TOOL} once with the reply split into 2-${settings.maxSegmentsPerTurn}`
              + ` short bubbles of at most ${settings.maxCharsPerSegment} characters each.`,
            'That tool sends every bubble but the last, pausing like a person typing. Your final',
            'message must then be the last bubble, word for word, with nothing added.',
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

      ctx.on('agent/disposed', ({ agent }) => {
        const sessionId = sessionIdOf(agent)
        void Promise.resolve(conversationAsync(sessionId)).then((conversation) => {
          if (conversation) ledger.forget(conversation.conversationKey)
        }).catch(() => undefined)
      }, { global: true })
    },
  })
}

export const apply = (ctx, config) => createHumanPacingPlugin().apply(ctx, config)
