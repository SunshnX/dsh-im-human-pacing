import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FALLBACK_MAX_SEGMENTS,
  FALLBACK_MIN_SEGMENTS,
  fallbackSegments,
  groupSentences,
  mergeShortTail,
  splitSentences,
} from '../lib/fallback.mjs'

/** Compare while ignoring the whitespace the splitter normalizes. */
function sameText(left, right) {
  return left.replace(/\s+/gu, '') === right.replace(/\s+/gu, '')
}

test('splitSentences keeps terminators attached and splits every sentence', () => {
  assert.deepEqual(splitSentences('第一句。第二句！'), ['第一句。', '第二句！'])
  assert.deepEqual(splitSentences('a. b?'), ['a.', 'b?'])
  assert.deepEqual(splitSentences(''), [])
  assert.deepEqual(splitSentences('   '), [])
  assert.deepEqual(splitSentences('没有终止符'), ['没有终止符'])
})

test('splitSentences absorbs closing quotes into the sentence', () => {
  assert.deepEqual(splitSentences('他说：“走吧。”然后走了。'), [
    '他说：“走吧。”',
    '然后走了。',
  ])
})

test('splitSentences treats a full ellipsis as one terminator', () => {
  const pieces = splitSentences('嗯……让我想想……')
  assert.deepEqual(pieces, ['嗯……', '让我想想……'])
})

test('groupSentences stays near the target and never exceeds the hard limit', () => {
  const sentences = ['一二三。', '四五六。', '七八九。', '十十一十二。']
  const groups = groupSentences(sentences, 12, 100)
  assert.ok(groups.length >= 2)
  for (const group of groups) assert.ok(group.length <= 100)
  assert.ok(sameText(groups.join(''), sentences.join('')))
})

test('groupSentences hard-cuts a single oversized sentence without losing text', () => {
  const long = 'x'.repeat(25)
  const groups = groupSentences([long], 10, 10)
  assert.deepEqual(groups.map((group) => group.length), [10, 10, 5])
  assert.equal(groups.join(''), long)
})

test('mergeShortTail folds a fragment into the previous bubble', () => {
  assert.deepEqual(mergeShortTail(['这是一句正常长度的话', '嗯。'], 8), ['这是一句正常长度的话 嗯。'])
  assert.deepEqual(mergeShortTail(['嗯。'], 8), ['嗯。'])
})

test('a short single-sentence reply is left alone', () => {
  assert.deepEqual(fallbackSegments('好的。', { targetChars: 70, maxChars: 500 }), [])
  assert.deepEqual(fallbackSegments('没问题，我这就去办。', { targetChars: 70, maxChars: 500 }), [])
})

test('a multi-sentence reply is split and stays lossless', () => {
  const text = '第一句内容在这里。第二句内容也在这里。第三句同样在这里。第四句收尾。'
  const segments = fallbackSegments(text, { targetChars: 20, maxChars: 500 })
  assert.ok(segments.length >= FALLBACK_MIN_SEGMENTS)
  assert.ok(sameText(segments.join(''), text), 'no words may be lost')
})

test('the fallback never exceeds its bubble ceiling', () => {
  const text = Array.from({ length: 40 }, (_, index) => `第${index}句内容。`).join('')
  const segments = fallbackSegments(text, { targetChars: 10, maxChars: 500 })
  assert.ok(segments.length <= FALLBACK_MAX_SEGMENTS, `got ${segments.length}`)
  assert.ok(sameText(segments.join(''), text), 'folding must not drop text')
})

test('folding respects maxChars even when it merges bubbles', () => {
  // Many tiny sentences: the ceiling forces folding, which must then be cut
  // back to the hard limit instead of producing one huge bubble.
  const text = Array.from({ length: 40 }, (_, index) => `第${index}句内容。`).join('')
  const segments = fallbackSegments(text, { targetChars: 10, maxChars: 40 })
  for (const segment of segments) {
    assert.ok(segment.length <= 40, `bubble too long: ${segment.length}`)
  }
  assert.ok(sameText(segments.join(''), text))
})

test('long unpunctuated text is still bounded by maxChars', () => {
  const text = '这是一段没有任何标点的很长文字'.repeat(20)
  const segments = fallbackSegments(text, { targetChars: 70, maxChars: 50 })
  assert.ok(segments.length >= FALLBACK_MIN_SEGMENTS, 'a wall of text still gets split')
  for (const segment of segments.slice(0, -1)) {
    assert.ok(segment.length <= 50, `bubble too long: ${segment.length}`)
  }
  assert.ok(sameText(segments.join(''), text), 'hard cuts must not lose text')
})
