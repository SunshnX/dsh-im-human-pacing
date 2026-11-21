import assert from 'node:assert/strict'
import test from 'node:test'

import { SAY_TOOL, SELF_TEST_TOOL, apply, createHumanPacingPlugin } from '../index.js'

/** A fake Cordis context exposing only what this plugin registers on. */
function createContext({ dshIm }) {
  const registered = { tools: new Map(), contexts: new Map(), listeners: [] }
  const ctx = {
    dshIm,
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect(factory) {
      return factory() ?? (() => {})
    },
    on(event, listener) {
      registered.listeners.push({ event, listener })
      return () => {}
    },
    tools: {
      register(definition, options) {
        registered.tools.set(definition.name, { definition, options })
        return () => registered.tools.delete(definition.name)
      },
    },
    systemPrompt: {
      context(contribution) {
        registered.contexts.set(contribution.name, contribution)
        return () => registered.contexts.delete(contribution.name)
      },
    },
  }
  return { ctx, registered }
}

/** A `dshIm` stand-in that records sends. */
function createDshIm({ conversation = { channel: 'weixin', botId: 'bot-1', conversationKey: 'p2p:user-1@im.wechat' } } = {}) {
  const sent = []
  return {
    sent,
    describeConversationSync: (sessionId) => (sessionId === 'session-1' ? conversation : null),
    async describeConversation(sessionId) {
      return sessionId === 'session-1' ? conversation : null
    },
    async send(botId, target, text, options) {
      sent.push({ botId, target, text, options })
      return { sent: true }
    },
    async listBots() {
      return [{ botId: 'bot-1', channel: 'weixin' }]
    },
    async listTargets() {
      return [{ targetId: 'tgt-1', kind: 'user', route: { toUserId: 'user-1@im.wechat' } }]
    },
  }
}

/** Drive the plugin with an injected clock, sleep, and randomness. */
function setup({ config = {}, conversation, dshIm } = {}) {
  const clock = { now: 1_000_000, waits: [] }
  const im = dshIm ?? createDshIm(conversation ? { conversation } : {})
  const plugin = createHumanPacingPlugin({
    now: () => clock.now,
    random: () => 0,
    async sleep(ms) {
      clock.waits.push(ms)
      clock.now += ms
    },
  })
  const { ctx, registered } = createContext({ dshIm: im })
  plugin.apply(ctx, config)
  return { im, clock, registered, ctx }
}

const agent = { session: { id: 'session-1' }, id: 'session-1' }
const exec = { agent, signal: new AbortController().signal }

test('registers the reply tool and a prompt context', () => {
  const { registered } = setup()
  assert.ok(registered.tools.has(SAY_TOOL))
  assert.equal(registered.tools.has(SELF_TEST_TOOL), false, 'self-test is opt-in')
  assert.ok(registered.contexts.has('dsh-im-human-pacing'))
})

test('the tool is only offered inside an enabled IM conversation', async () => {
  const { registered } = setup()
  const { options } = registered.tools.get(SAY_TOOL)
  assert.equal(await options.when({ agent }), true)
  assert.equal(await options.when({ agent: { session: { id: 'session-2' } } }), false)
})

test('sends every bubble but the last, each after a positive pause', async () => {
  const { im, clock, registered } = setup()
  const { definition } = registered.tools.get(SAY_TOOL)
  const result = await definition.execute(
    { segments: ['第一句', '第二句稍微长一点', '最后一句'] },
    exec,
  )
  assert.equal(result.sentCount, 2)
  assert.equal(result.remaining, '最后一句')
  assert.deepEqual(im.sent.map((entry) => entry.text), ['第一句', '第二句稍微长一点'])
  assert.deepEqual(im.sent[0].target, { kind: 'user', route: { toUserId: 'user-1@im.wechat' } })
  assert.equal(im.sent[0].botId, 'bot-1')
  assert.equal(im.sent[0].options.format, 'plain')
  assert.equal(clock.waits.length, 3, 'one wait per bubble, including the last')
  // Every bubble this tool sends itself waits first.
  assert.ok(clock.waits[0] > 0, 'first bubble waits')
  assert.ok(clock.waits[1] > 0, 'second bubble waits')
  // The final bubble is emitted by the model, whose own generation time covers
  // a short pause, so its extra wait never exceeds the middle one.
  assert.ok(clock.waits[2] <= clock.waits[1])
  assert.ok(result.waitedMs > 0)
})

test('a longer bubble waits longer than a shorter one', async () => {
  const { clock, registered } = setup()
  const { definition } = registered.tools.get(SAY_TOOL)
  await definition.execute({ segments: ['短', '这是一句明显更长的中文内容，需要更久的打字时间'] }, exec)
  assert.ok(clock.waits[1] > clock.waits[0], `${clock.waits[1]} should exceed ${clock.waits[0]}`)
})

test('a later call in the same turn keeps pacing from the previous send', async () => {
  const { clock, registered } = setup()
  const { definition } = registered.tools.get(SAY_TOOL)
  await definition.execute({ segments: ['一', '二'] }, exec)
  const firstRound = clock.waits.slice()
  clock.waits.length = 0
  await definition.execute({ segments: ['三', '四'] }, exec)
  assert.ok(clock.waits[0] > 0)
  assert.ok(firstRound[0] > 0, 'the first bubble of the first call still waits')
})

test('rejects invalid bubble lists with actionable errors', async () => {
  const { im, registered } = setup()
  const { definition } = registered.tools.get(SAY_TOOL)
  await assert.rejects(() => definition.execute({ segments: [] }, exec), /至少需要 2 段/)
  await assert.rejects(() => definition.execute({ segments: ['只有一条'] }, exec), /至少需要 2 段/)
  await assert.rejects(() => definition.execute({ segments: ['a', '   '] }, exec), /不能为空/)
  await assert.rejects(() => definition.execute({}, exec), /字符串数组/)
  await assert.rejects(
    () => definition.execute({ segments: ['a', 'x'.repeat(600)] }, exec),
    /不能超过 500 个字符/,
  )
  assert.equal(im.sent.length, 0, 'nothing is sent for a rejected call')
})

test('refuses to pace outside an IM conversation', async () => {
  const { registered } = setup()
  const { definition } = registered.tools.get(SAY_TOOL)
  await assert.rejects(
    () => definition.execute(
      { segments: ['a', 'b'] },
      { agent: { session: { id: 'nope' } }, signal: exec.signal },
    ),
    /不属于 IM 渠道/,
  )
})

test('honors maxSegmentsPerTurn across one turn and resets on the next', async () => {
  const { registered, im } = setup({ config: { maxSegmentsPerTurn: 3 } })
  const claimed = registered.listeners.find((entry) => entry.event === 'agent/inbox/claimed')
  claimed.listener({ agent, turn: 1 })
  const { definition } = registered.tools.get(SAY_TOOL)
  await definition.execute({ segments: ['a', 'b', 'c'] }, exec)
  assert.equal(im.sent.length, 2)
  await assert.rejects(
    () => definition.execute({ segments: ['d', 'e'] }, exec),
    /本轮气泡数超过上限/,
  )
  claimed.listener({ agent, turn: 2 })
  const result = await definition.execute({ segments: ['f', 'g'] }, exec)
  assert.equal(result.sentCount, 1)
})

test('an aborted signal stops the pacing wait', async () => {
  const controller = new AbortController()
  const im = createDshIm()
  const plugin = createHumanPacingPlugin({
    now: () => 0,
    random: () => 0,
    sleep(_ms, signal) {
      controller.abort()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        if (signal?.aborted) reject(new Error('aborted'))
      })
    },
  })
  const { ctx, registered } = createContext({ dshIm: im })
  plugin.apply(ctx, {})
  const { definition } = registered.tools.get(SAY_TOOL)
  await assert.rejects(() => definition.execute({ segments: ['a', 'b'] }, { agent, signal: controller.signal }))
  assert.equal(im.sent.length, 0)
})

test('a disabled channel is not served', async () => {
  const conversation = { channel: 'feishu', botId: 'bot-2', conversationKey: 'p2p:user-1' }
  const { registered } = setup({ conversation })
  const { options } = registered.tools.get(SAY_TOOL)
  assert.equal(await options.when({ agent }), false)
})

test('the prompt context appears only inside IM conversations', () => {
  const { registered } = setup()
  const context = registered.contexts.get('dsh-im-human-pacing')
  assert.match(context.text({ agent }), /dsh_im_say/)
  assert.equal(context.text({ agent: { session: { id: 'other' } } }), '')
  assert.equal(context.text({}), '')
})

test('self-test tool appears only when configured and sends three bubbles', async () => {
  const { registered, im } = setup({ config: { selfTest: true } })
  assert.ok(registered.tools.has(SELF_TEST_TOOL))
  const { definition } = registered.tools.get(SELF_TEST_TOOL)
  const result = await definition.execute({}, exec)
  assert.equal(im.sent.length, 2, 'two bubbles are sent, the third is the final reply')
  assert.equal(result.botId, 'bot-1')
  assert.equal(result.target, 'tgt-1')
  assert.equal(result.waits.length, 3)
})

test('a forged dshIm target is validated by the channel, not invented here', async () => {
  const im = createDshIm()
  let seen = null
  im.send = async (botId, target, text) => {
    seen = { botId, target, text }
    return { sent: true }
  }
  const { registered } = setup({ dshIm: im })
  const { definition } = registered.tools.get(SAY_TOOL)
  await definition.execute({ segments: ['一', '二'] }, exec)
  assert.deepEqual(seen.target, { kind: 'user', route: { toUserId: 'user-1@im.wechat' } })
})

test('apply() is the exported entry point', () => {
  const { ctx, registered } = createContext({ dshIm: createDshIm() })
  apply(ctx, {})
  assert.ok(registered.tools.has(SAY_TOOL))
})
