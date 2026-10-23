// Sentence segmenter unit test (runs on plain Node, no harness needed).
import { ParagraphGate, SentenceSegmenter, plainText, splitSentences } from '../lib/segmenter.js'

let failures = 0
function assert(cond, label) {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures++
    console.error(`FAIL  ${label}`)
  }
}

// 1. plainText strips markdown
const cleaned = plainText('**加粗** `code` [link](http://x) ```js\ncode\n``` 剩下')
assert(!cleaned.includes('**') && !cleaned.includes('```') && cleaned.includes('剩下'), 'plainText strips markdown')

// 2. splitSentences keeps tail
{
  const r = splitSentences('你好。世界！未完成')
  assert(r.sentences.length === 2 && r.sentences[0] === '你好。' && r.sentences[1] === '世界！' && r.tail === '未完成', 'splitSentences splits + tails')
}

// 3. feed across chunks emits complete sentences
{
  const seg = new SentenceSegmenter()
  const out1 = seg.feed('第一句')
  assert(out1.length === 0, 'no sentence until terminal punctuation')
  const out2 = seg.feed('结束。第二句还在')
  assert(out2.length === 1 && out2[0] === '第一句结束。', 'cross-chunk sentence emitted')
  const out3 = seg.flush()
  assert(out3.length === 1 && out3[0] === '第二句还在', 'flush emits the tail')
}

// 4. skip punctuation-only fragments
{
  const seg = new SentenceSegmenter()
  seg.feed('（')
  const out = seg.feed('）')
  assert(out.length === 0, 'punctuation-only fragment skipped')
}

// 5. English + mixed punctuation
{
  const seg = new SentenceSegmenter()
  const out = seg.feed('Hello world. This is a test! 中文也支持。')
  assert(out.length === 3, 'mixed punctuation emits 3 sentences, got ' + out.length)
}

// 6. fenced code split across deltas must never be spoken
{
  const seg = new SentenceSegmenter()
  const out1 = seg.feed('这是说明。\n\n```js\nconst a = 1\n')
  const out2 = seg.feed('const b = 2\n```\n\n结束。')
  const all = [...out1, ...out2]
  assert(
    all.length === 2 && all[0] === '这是说明。' && all[1] === '结束。',
    'fenced code across deltas is dropped: ' + JSON.stringify(all),
  )
}

// 7. a fence marker that is itself split across deltas
{
  const seg = new SentenceSegmenter()
  const out1 = seg.feed('前文。\n``')
  const out2 = seg.feed('`\ncode\n``')
  const out3 = seg.feed('`\n后文。')
  const all = [...out1, ...out2, ...out3]
  assert(
    all.length === 2 && all[0] === '前文。' && all[1] === '后文。',
    'split fence marker is handled: ' + JSON.stringify(all),
  )
}

// 8. tilde fences + inline code kept as text (backticks removed)
{
  const seg = new SentenceSegmenter()
  const fenced = seg.feed('~~~\ncode line\n~~~\n保留这句。')
  assert(
    fenced.length === 1 && fenced[0] === '保留这句。',
    'tilde fence is dropped: ' + JSON.stringify(fenced),
  )
  const inline = new SentenceSegmenter()
  inline.feed('用 `npm')
  const out = inline.feed(' install` 装。')
  assert(
    out.length === 1 && out[0] === '用 npm install 装。',
    'inline code survives across deltas: ' + JSON.stringify(out),
  )
}


// --- ParagraphGate (tts.mode = 'paragraph'): speak only the first paragraph ---

// P1. first-paragraph sentences stream out; the second paragraph is dropped
{
  const gate = new ParagraphGate()
  const a = gate.feed('第一段第一句。')
  const b = gate.feed('第一段第二句！\n\n')
  const c = gate.feed('第二段第一句。第二段结束。')
  const f = gate.flush()
  assert(a.length === 1 && a[0] === '第一段第一句。', 'P1: first sentence streams')
  assert(b.length === 1 && b[0] === '第一段第二句！', 'P1: second sentence streams before blank line')
  assert(c.length === 0, 'P1: everything after the blank line is dropped')
  assert(f.length === 0, 'P1: nothing left to flush')
}

// P2. blank line split across chunks is detected (the trailing "\n" is held)
{
  const gate = new ParagraphGate()
  const a = gate.feed('首段说完。\n')
  const b = gate.feed('\n第二段开始。到此。')
  assert(a.length === 1 && a[0] === '首段说完。', 'P2: held line break does not emit early')
  assert(b.length === 0, 'P2: cross-chunk blank line closes the gate')
}

// P3. no blank line anywhere: the whole turn is the first paragraph
{
  const gate = new ParagraphGate()
  const a = gate.feed('一句。')
  const b = gate.feed('两句。')
  const f = gate.flush()
  assert(a.length === 1 && b.length === 1, 'P3: sentences stream without a blank line')
  assert(f.length === 0, 'P3: no residue to flush')
}

// P4. single-line turn: flush speaks the unterminated tail
{
  const gate = new ParagraphGate()
  gate.feed('没有标点的结尾')
  const f = gate.flush()
  assert(f.length === 1 && f[0] === '没有标点的结尾', 'P4: unterminated first paragraph flushes')
}

// P5. leading blank line before any text: nothing is spoken
{
  const gate = new ParagraphGate()
  const a = gate.feed('\n\n正文第一句。')
  assert(a.length === 0, 'P5: leading blank line closes before any speech')
}

console.log(failures === 0 ? '\nALL SEGMENTER TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
