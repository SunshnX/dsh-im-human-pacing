/**
 * Pacing and segmentation rules for human-looking IM replies.
 *
 * Pure functions only: no Node built-ins, no I/O, no timers. The Host plugin
 * turns these results into real waits; the unit tests exercise them directly.
 */

/** Fallback settings; every value is clamped again in `normalizeSettings`. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Channels that get segmented, paced replies. */
  channels: ['weixin'],
  /** Milliseconds of "typing" per visual character unit. */
  msPerUnit: 220,
  /** Shortest and longest single typing pause. */
  typingMinMs: 700,
  typingMaxMs: 6_000,
  /** Extra pause before a bubble, standing in for reading the previous one. */
  readingMinMs: 250,
  readingMaxMs: 1_400,
  /** Floor between two bubbles even when both would compute to zero. */
  minGapMs: 900,
  /** Ceiling for one wait, so a long bubble cannot stall the turn. */
  maxDelayMs: 15_000,
  /** Bubbles one turn may send before the tool refuses. */
  maxSegmentsPerTurn: 8,
  /** Bubbles one conversation may receive per rolling minute. */
  maxMessagesPerMinute: 20,
  /** Longer text is split further along sentence boundaries. */
  maxCharsPerSegment: 500,
  /** Registers a diagnostic tool that sends a paced demo. */
  selfTest: false,
})

const MINUTE_MS = 60_000

function finiteNumber(value, fallback) {
  const numeric = typeof value === 'string' && value.trim() ? Number(value.trim()) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : fallback
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

function positiveInt(value, fallback, low, high) {
  const numeric = Math.round(finiteNumber(value, fallback))
  return clamp(Number.isFinite(numeric) ? numeric : fallback, low, high)
}

/**
 * Resolve one raw config object into usable settings.
 *
 * Unknown or malformed entries fall back to the default for that field: a
 * half-typed config must never make the bot unable to answer.
 */
export function normalizeSettings(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const defaults = DEFAULT_SETTINGS

  const channels = Array.isArray(source.channels)
    ? source.channels
      .filter((channel) => typeof channel === 'string')
      .map((channel) => channel.trim().toLowerCase())
      .filter((channel) => /^[a-z][a-z0-9-]{0,31}$/.test(channel))
    : defaults.channels

  const typingMinMs = positiveInt(source.typingMinMs, defaults.typingMinMs, 0, 60_000)
  const typingMaxMs = Math.max(typingMinMs, positiveInt(source.typingMaxMs, defaults.typingMaxMs, 0, 120_000))
  const readingMinMs = positiveInt(source.readingMinMs, defaults.readingMinMs, 0, 60_000)
  const readingMaxMs = Math.max(readingMinMs, positiveInt(source.readingMaxMs, defaults.readingMaxMs, 0, 120_000))

  return Object.freeze({
    channels: Object.freeze([...new Set(channels)].length > 0 ? [...new Set(channels)] : [...defaults.channels]),
    msPerUnit: clamp(finiteNumber(source.msPerUnit, defaults.msPerUnit), 0, 5_000),
    typingMinMs,
    typingMaxMs,
    readingMinMs,
    readingMaxMs,
    minGapMs: positiveInt(source.minGapMs, defaults.minGapMs, 0, 60_000),
    maxDelayMs: positiveInt(source.maxDelayMs, defaults.maxDelayMs, 0, 300_000),
    maxSegmentsPerTurn: positiveInt(source.maxSegmentsPerTurn, defaults.maxSegmentsPerTurn, 1, 50),
    maxMessagesPerMinute: positiveInt(source.maxMessagesPerMinute, defaults.maxMessagesPerMinute, 1, 120),
    maxCharsPerSegment: positiveInt(source.maxCharsPerSegment, defaults.maxCharsPerSegment, 20, 1_800),
    selfTest: source.selfTest === true,
  })
}

const CJK_RANGES = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x303f], // CJK radicals and punctuation
  [0x3040, 0x30ff], // Kana
  [0x3130, 0x318f], // Hangul compatibility Jamo
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef], // Halfwidth and fullwidth forms
  [0x20000, 0x2fa1f], // CJK extension B and later
]

const EMOJI_RANGES = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2190, 0x21ff],
]

function inRanges(codePoint, ranges) {
  for (const [low, high] of ranges) {
    if (codePoint >= low && codePoint <= high) return true
  }
  return false
}

/**
 * Measured "typing cost" of one word-ish unit of text.
 *
 * A CJK glyph is one keystroke-worth of intent but many keystrokes of input,
 * so it counts as a full unit; a Latin letter is faster to produce.
 */
export function charWeight(codePoint, char) {
  if (inRanges(codePoint, CJK_RANGES)) return 1
  if (inRanges(codePoint, EMOJI_RANGES)) return 1
  if (char === '\n' || char === '\r') return 0.6
  if (/\s/u.test(char)) return 0.12
  if (/[\p{L}\p{N}]/u.test(char)) return 0.55
  return 0.4
}

/** Total visual units in `text`; never negative. */
export function visualUnits(text) {
  if (typeof text !== 'string' || !text) return 0
  let units = 0
  for (const char of text) {
    units += charWeight(char.codePointAt(0), char)
  }
  return Math.round(units * 100) / 100
}

/**
 * How long to wait before sending `text` as the next bubble.
 *
 * The wait stands for typing this bubble (scaled by its measured length) plus
 * a little reading time, and never falls below `minGapMs` since the previous
 * send in the same conversation.
 *
 * @param {object} input
 * @param {string} input.text bubble about to be sent
 * @param {number} input.now current epoch milliseconds
 * @param {number|undefined} input.lastSendAt last send in this conversation
 * @param {number} [input.recentCount] bubbles already sent in the rolling minute
 * @param {() => number} [input.random] injection point for tests
 * @param {object} input.settings resolved settings
 * @returns {number} milliseconds to wait, `0` when the send may proceed now
 */
export function computeSendDelayMs({ text, now, lastSendAt, recentCount = 0, random = Math.random, settings }) {
  const draw = typeof random === 'function' ? random() : 0.5
  const jitter = clamp(Number.isFinite(draw) ? draw : 0.5, 0, 1)

  const units = visualUnits(text)
  const typing = clamp(units * settings.msPerUnit, settings.typingMinMs, settings.typingMaxMs)
  const reading = settings.readingMinMs + (settings.readingMaxMs - settings.readingMinMs) * jitter

  let wanted = typing + reading
  if (recentCount >= settings.maxMessagesPerMinute) {
    // At the rolling-minute budget: wait for the oldest tick to age out.
    wanted = Math.max(wanted, MINUTE_MS / settings.maxMessagesPerMinute)
  }
  wanted = Math.min(wanted, settings.maxDelayMs)

  const earliest = Number.isFinite(lastSendAt) ? lastSendAt + settings.minGapMs : -Infinity
  const target = Math.max(now + wanted, earliest)
  return Math.max(0, Math.round(target - now))
}

/** Timestamps inside the rolling minute ending at `now`. */
export function pruneSendTimes(sendTimes, now) {
  if (!Array.isArray(sendTimes)) return []
  return sendTimes.filter((at) => Number.isFinite(at) && at > now - MINUTE_MS)
}

const SENTENCE_CHARS = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '.', '\n'])

/**
 * Break over-long text into bubbles at sentence boundaries.
 *
 * Used when the model hands over more text than one bubble should carry, so a
 * single oversized paragraph can never reach the chat unchanged.
 */
export function splitLongSegment(text, limit) {
  const source = typeof text === 'string' ? text : ''
  if (!source) return []
  if (!(limit > 0) || source.length <= limit) return [source]

  const parts = []
  let rest = source
  while (rest.length > limit) {
    let cut = -1
    for (let index = 0; index < limit; index += 1) {
      if (SENTENCE_CHARS.has(rest[index])) cut = index + 1
    }
    if (cut <= 0) {
      const space = rest.lastIndexOf(' ', limit)
      cut = space > limit * 0.5 ? space + 1 : limit
    }
    const head = rest.slice(0, cut).trim()
    if (head) parts.push(head)
    rest = rest.slice(cut).trimStart()
  }
  if (rest.trim()) parts.push(rest.trim())
  return parts
}

const PLAIN_ID = /^[^\s:\u0000-\u001f\u007f]{1,512}$/u

/**
 * Turn one channel conversation key into the draft delivery target
 * `DeliveryService.send()` accepts for that channel.
 *
 * Only shapes this plugin actually verifies are accepted; an unknown key
 * returns `null` so the caller reports the miss instead of guessing a target.
 */
export function draftTargetFor(channel, conversationKey) {
  if (typeof conversationKey !== 'string' || !conversationKey) return null
  if (channel !== 'weixin') return null
  const marker = 'p2p:'
  if (!conversationKey.startsWith(marker)) return null
  const toUserId = conversationKey.slice(marker.length)
  if (!PLAIN_ID.test(toUserId)) return null
  return Object.freeze({ kind: 'user', route: Object.freeze({ toUserId }) })
}

/** True when `channel` should be served by this plugin. */
export function isEnabledChannel(channel, settings) {
  return typeof channel === 'string' && settings.channels.includes(channel)
}
