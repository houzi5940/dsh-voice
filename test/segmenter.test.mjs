// Sentence segmenter unit test (runs on plain Node, no harness needed).
import { SentenceSegmenter, plainText, splitSentences } from '../lib/segmenter.js'

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

console.log(failures === 0 ? '\nALL SEGMENTER TESTS PASSED' : `\n${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
