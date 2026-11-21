import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SETTINGS,
  computeSendDelayMs,
  draftTargetFor,
  isEnabledChannel,
  normalizeSettings,
  pruneSendTimes,
  splitLongSegment,
  visualUnits,
} from '../lib/pacing.js'

test('normalizeSettings fills defaults and clamps out-of-range values', () => {
  const settings = normalizeSettings({})
  assert.deepEqual(settings.channels, ['weixin'])
  assert.equal(settings.msPerUnit, DEFAULT_SETTINGS.msPerUnit)

  const clamped = normalizeSettings({
    typingMinMs: 9_000,
    typingMaxMs: 100,
    readingMinMs: -5,
    maxSegmentsPerTurn: 0,
    maxMessagesPerMinute: 999,
    channels: [' WeChat ', 'weixin', 42, ''],
  })
  // max never drops below min
  assert.equal(clamped.typingMinMs, 9_000)
  assert.equal(clamped.typingMaxMs, 9_000)
  assert.equal(clamped.readingMinMs, 0)
  assert.equal(clamped.maxSegmentsPerTurn, 1)
  assert.equal(clamped.maxMessagesPerMinute, 120)
  // entries are trimmed, lower-cased, de-duplicated, and non-strings dropped
  assert.deepEqual(clamped.channels, ['wechat', 'weixin'])
  // an unusable channel list falls back to the default channel
  assert.deepEqual(normalizeSettings({ channels: [] }).channels, ['weixin'])
  assert.deepEqual(normalizeSettings({ channels: 'weixin' }).channels, ['weixin'])
})

test('visualUnits counts CJK heavier than Latin and ignores nothing important', () => {
  assert.equal(visualUnits(''), 0)
  assert.equal(visualUnits('你好'), 2)
  assert.ok(visualUnits('hello') < visualUnits('你好你好'))
  // whitespace is cheap but not free
  assert.ok(visualUnits('a b') > visualUnits('ab'))
  assert.equal(visualUnits(null), 0)
})

test('computeSendDelayMs stays inside the configured band', () => {
  const settings = normalizeSettings({
    msPerUnit: 200,
    typingMinMs: 500,
    typingMaxMs: 3_000,
    readingMinMs: 200,
    readingMaxMs: 800,
    minGapMs: 0,
    maxDelayMs: 10_000,
  })
  const now = 1_000_000
  const shortWait = computeSendDelayMs({ text: '好', now, settings, random: () => 0 })
  assert.equal(shortWait, 500 + 200)
  const longWait = computeSendDelayMs({ text: '你'.repeat(500), now, settings, random: () => 1 })
  assert.equal(longWait, 3_000 + 800)
})

test('computeSendDelayMs honors the minimum gap since the last send', () => {
  const settings = normalizeSettings({
    msPerUnit: 0, typingMinMs: 0, typingMaxMs: 0,
    readingMinMs: 0, readingMaxMs: 0, minGapMs: 2_000,
  })
  const wait = computeSendDelayMs({
    text: 'hi', now: 10_000, lastSendAt: 9_000, settings, random: () => 0,
  })
  assert.equal(wait, 1_000)
  // already past the gap: no wait
  assert.equal(computeSendDelayMs({
    text: 'hi', now: 12_000, lastSendAt: 9_000, settings, random: () => 0,
  }), 0)
})

test('computeSendDelayMs slows down once the rolling minute is full', () => {
  const settings = normalizeSettings({
    msPerUnit: 0, typingMinMs: 0, typingMaxMs: 0, readingMinMs: 0, readingMaxMs: 0,
    minGapMs: 0, maxMessagesPerMinute: 12, maxDelayMs: 60_000,
  })
  const wait = computeSendDelayMs({
    text: 'hi', now: 0, recentCount: 12, settings, random: () => 0,
  })
  assert.equal(wait, 5_000)
})

test('a long delay is capped but never below the minimum gap', () => {
  const settings = normalizeSettings({
    msPerUnit: 1_000, typingMinMs: 0, typingMaxMs: 60_000,
    readingMinMs: 0, readingMaxMs: 0, minGapMs: 0, maxDelayMs: 5_000,
  })
  // 20 CJK units would be 20 s of typing; the ceiling cuts it to 5 s.
  assert.equal(computeSendDelayMs({ text: '你好世界'.repeat(5), now: 0, settings, random: () => 0 }), 5_000)
})

test('pruneSendTimes keeps only the last minute', () => {
  const now = 100_000
  assert.deepEqual(pruneSendTimes([now - 90_000, now - 59_000, now], now), [now - 59_000, now])
  assert.deepEqual(pruneSendTimes(null, now), [])
})

test('splitLongSegment cuts at sentence boundaries and respects the limit', () => {
  assert.deepEqual(splitLongSegment('short', 100), ['short'])
  const text = '第一句。第二句。第三句。'
  const parts = splitLongSegment(text, 8)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    assert.ok(part.length <= 8, `part too long: ${part}`)
  }
  assert.equal(parts.join(''), text)
  // no punctuation at all still produces bounded pieces
  const hard = splitLongSegment('x'.repeat(25), 10)
  assert.deepEqual(hard.map((part) => part.length), [10, 10, 5])
  assert.deepEqual(splitLongSegment('', 10), [])
})

test('draftTargetFor accepts only the verified WeChat private key shape', () => {
  assert.deepEqual(
    draftTargetFor('weixin', 'p2p:abc123@im.wechat'),
    { kind: 'user', route: { toUserId: 'abc123@im.wechat' } },
  )
  assert.equal(draftTargetFor('weixin', 'group:123'), null)
  assert.equal(draftTargetFor('weixin', 'p2p:'), null)
  assert.equal(draftTargetFor('weixin', 'p2p:bad id'), null)
  assert.equal(draftTargetFor('telegram', 'p2p:abc'), null)
  assert.equal(draftTargetFor('weixin', 42), null)
})

test('isEnabledChannel only matches configured channels', () => {
  const settings = normalizeSettings({ channels: ['weixin'] })
  assert.equal(isEnabledChannel('weixin', settings), true)
  assert.equal(isEnabledChannel('feishu', settings), false)
  assert.equal(isEnabledChannel(null, settings), false)
})
