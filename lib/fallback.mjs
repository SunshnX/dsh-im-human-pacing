/**
 * Fallback segmentation for replies the model never submitted to `dsh_im_say`.
 *
 * The tool produces the best bubbles because the model decides the split. When
 * it forgets, this module still produces a human-looking sequence by cutting the
 * finished answer at natural boundaries, so a chat never receives one wall of
 * text merely because a tool call was skipped.
 *
 * Pure functions only; the Host plugin owns the pacing and the sending.
 */

/** Sentence terminators, longest first so `……` is consumed as one mark. */
const TERMINATORS = ['……', '…', '。', '！', '？', '!', '?', '；', ';', '...', '.']

/**
 * Whether the `.` at `index` really ends a sentence.
 *
 * A dot inside a decimal (`3.14`), a version (`v1.0.1`), or an abbreviation is
 * not a boundary, and neither is one in the middle of a run of dots.
 */
function isSentenceDot(source, index) {
  const before = source[index - 1]
  const after = source[index + 1]
  if (before !== undefined && /[0-9A-Za-z]/.test(before) && after !== undefined && /[0-9A-Za-z]/.test(after)) {
    return false
  }
  if (before === '.') return false
  return true
}

/** Trailing closer that belongs to the sentence it finishes. */
const CLOSERS = new Set(['”', '’', '"', "'", '）', ')', '】', '」', '』', '》', '〉', ']'])

/** Fewest bubbles the fallback may produce; below this the reply stays whole. */
export const FALLBACK_MIN_SEGMENTS = 2

/** Most bubbles the fallback produces for one reply. */
export const FALLBACK_MAX_SEGMENTS = 5

/**
 * Split `text` into sentence-ish pieces, keeping terminators attached.
 *
 * @param {string} text complete reply
 * @returns {string[]} non-empty pieces, in order
 */
export function splitSentences(text) {
  const source = typeof text === 'string' ? text : ''
  if (!source.trim()) return []

  const pieces = []
  let buffer = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    let matched = TERMINATORS.find((mark) => source.startsWith(mark, index))
    if (matched === '.') {
      const run = source.slice(index).match(/^\.+/)?.[0] ?? '.'
      if (run.length > 1) matched = run
      else if (!isSentenceDot(source, index)) matched = undefined
    }
    if (!matched) {
      buffer += char
      index += 1
      continue
    }
    buffer += matched
    index += matched.length
    // Absorb closing quotes so the sentence ends where the reader expects.
    while (index < source.length && CLOSERS.has(source[index])) {
      buffer += source[index]
      index += 1
    }
    if (buffer.trim()) pieces.push(buffer.trim())
    buffer = ''
  }
  if (buffer.trim()) pieces.push(buffer.trim())
  return pieces
}

/**
 * Group adjacent sentences so each bubble stays near `targetChars`.
 *
 * @param {string[]} sentences pieces from {@link splitSentences}
 * @param {number} targetChars preferred bubble size
 * @param {number} maxChars hard limit per bubble
 * @returns {string[]} grouped bubbles
 */
export function groupSentences(sentences, targetChars, maxChars) {
  const groups = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // This sentence alone is too long: flush, then cut it on its own.
      if (current.trim()) groups.push(current.trim())
      current = ''
      for (let start = 0; start < sentence.length; start += maxChars) {
        const part = sentence.slice(start, start + maxChars).trim()
        if (part) groups.push(part)
      }
      continue
    }
    const candidate = current ? `${current} ${sentence}` : sentence
    if (current && candidate.length > targetChars) {
      groups.push(current.trim())
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current.trim()) groups.push(current.trim())
  return groups
}

/**
 * Merge a fragment into the previous bubble, so a trailing "嗯。" does not
 * arrive as its own message a few seconds later.
 *
 * @param {string[]} groups bubbles in order
 * @param {number} minChars below this a bubble counts as a fragment
 * @returns {string[]} bubbles in order
 */
export function mergeShortTail(groups, minChars) {
  const out = []
  for (const group of groups) {
    if (out.length > 0 && group.length < minChars) {
      out[out.length - 1] = `${out[out.length - 1]} ${group}`
    } else {
      out.push(group)
    }
  }
  return out
}

/**
 * Turn a finished reply into the bubbles the fallback sends.
 *
 * Every returned bubble except the last is handed to the channel by the plugin;
 * the last one is left to the model's own final message, exactly like the tool
 * path. A single-element result means "there is nothing worth splitting".
 *
 * @param {string} text complete reply
 * @param {object} options
 * @param {number} options.targetChars preferred bubble size
 * @param {number} options.maxChars hard limit per bubble
 * @param {number} [options.minChars] fragment threshold for merging
 * @param {number} [options.maxSegments] most bubbles to produce
 * @returns {string[]} bubbles, or `[]` when the text should stay one message
 */
export function fallbackSegments(text, {
  targetChars,
  maxChars,
  minChars = 8,
  maxSegments = FALLBACK_MAX_SEGMENTS,
}) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (!source) return []

  const sentences = splitSentences(source)
  // A single sentence is the smallest unit this fallback can split, so a reply
  // that is one short sentence stays exactly as the channel will deliver it.
  if (sentences.length <= 1 && source.length <= maxChars) return []

  // Group towards `targetChars`, but never fold every sentence into one bubble:
  // the point of the fallback is that the chat keeps receiving several messages.
  // When the natural grouping collapses to one bubble, split at the halfway
  // sentence instead.
  const grouped = groupSentences(sentences, targetChars, maxChars)
  const threshold = Math.min(minChars, Math.max(2, Math.floor(targetChars / 4)))
  let groups = mergeShortTail(grouped, threshold)
  if (groups.length < FALLBACK_MIN_SEGMENTS && sentences.length >= FALLBACK_MIN_SEGMENTS) {
    const halfway = Math.ceil(sentences.length / 2)
    groups = [
      sentences.slice(0, halfway).join(' ').trim(),
      sentences.slice(halfway).join(' ').trim(),
    ].filter(Boolean)
  }
  if (groups.length < FALLBACK_MIN_SEGMENTS) return []

  // Fold the overflow into fewer bubbles rather than dropping any of it: a chat
  // must never lose words. A folded bubble can exceed `maxChars`, so it is cut
  // again afterwards; the ceiling wins over the bubble count.
  while (groups.length > maxSegments) {
    const tail = groups.pop()
    groups[groups.length - 1] = `${groups[groups.length - 1]} ${tail}`
  }
  return groups.flatMap((group) => {
    if (group.length <= maxChars) return [group]
    const parts = []
    for (let start = 0; start < group.length; start += maxChars) {
      const part = group.slice(start, start + maxChars).trim()
      if (part) parts.push(part)
    }
    return parts
  })
}
