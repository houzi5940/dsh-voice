const TERMINAL = /[。！？!?；;…\n]/;
const SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
function plainText(text) {
  return String(text).replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/<\/?[a-zA-Z][^>]*>/g, " ");
}
function classifyFenceLine(line) {
  if (line.includes("\n")) return "text";
  let spaces = 0;
  while (spaces < line.length && line[spaces] === " ") spaces++;
  if (spaces > 3) return "text";
  const rest = line.slice(spaces);
  if (rest.length === 0) return "pending";
  const marker = rest[0];
  if (marker !== "`" && marker !== "~") return "text";
  let run = 0;
  while (run < rest.length && rest[run] === marker) run++;
  if (run >= 3) return "fence";
  return run < rest.length ? "text" : "pending";
}
class MarkdownStreamFilter {
  inFence = false;
  /** At a line start: the next characters decide whether a fence opens. */
  atLineStart = true;
  /** Leading spaces + marker run buffered until the line is decided. */
  lookahead = "";
  inlineCode = false;
  // Closing-fence detection for the current line inside a fence.
  fenceLineClosed = false;
  fenceRun = 0;
  fenceChar = "";
  fenceIndent = 0;
  push(chunk) {
    let out = "";
    for (const ch of chunk) {
      out += this.inFence ? this.pushFenced(ch) : this.pushNormal(ch);
    }
    return out;
  }
  /**
   * End of stream: a fence that never closed means the model cut off mid-code,
   * so its remaining content is dropped rather than spoken.
   */
  flush() {
    if (this.inFence) {
      this.reset();
      return "";
    }
    const pending = this.lookahead;
    this.lookahead = "";
    this.atLineStart = false;
    let out = "";
    for (const ch of pending) out += this.normalChar(ch);
    return out;
  }
  reset() {
    this.inFence = false;
    this.atLineStart = true;
    this.lookahead = "";
    this.inlineCode = false;
    this.resetFenceLine();
  }
  resetFenceLine() {
    this.fenceLineClosed = false;
    this.fenceRun = 0;
    this.fenceChar = "";
    this.fenceIndent = 0;
  }
  /** Inside a fence: drop everything until a closing fence line. */
  pushFenced(ch) {
    if (ch === "\n") {
      this.resetFenceLine();
      this.atLineStart = true;
      return "";
    }
    this.atLineStart = false;
    if (this.fenceLineClosed) return "";
    if (this.fenceRun === 0 && this.fenceIndent < 4 && ch === " ") {
      this.fenceIndent++;
      return "";
    }
    if (ch === "`" || ch === "~") {
      if (this.fenceRun === 0) this.fenceChar = ch;
      if (ch === this.fenceChar) {
        this.fenceRun++;
        if (this.fenceRun >= 3) {
          this.inFence = false;
          this.fenceLineClosed = true;
        }
        return "";
      }
    }
    this.fenceLineClosed = true;
    return "";
  }
  /** Outside a fence: detect fence openers, strip inline backticks. */
  pushNormal(ch) {
    if (this.atLineStart && !this.inlineCode) {
      const next = this.lookahead + ch;
      const verdict = classifyFenceLine(next);
      if (verdict === "fence") {
        this.inFence = true;
        this.lookahead = "";
        this.atLineStart = false;
        this.resetFenceLine();
        return "";
      }
      if (verdict === "text") {
        this.lookahead = "";
        this.atLineStart = false;
        let out = "";
        for (const c of next) out += this.normalChar(c);
        return out;
      }
      this.lookahead = next;
      return "";
    }
    return this.normalChar(ch);
  }
  normalChar(ch) {
    if (ch === "\n") {
      this.atLineStart = true;
      return ch;
    }
    this.atLineStart = false;
    if (ch === "`") {
      this.inlineCode = !this.inlineCode;
      return "";
    }
    return ch;
  }
}
function splitSentences(chunk) {
  const sentences = [];
  let start = 0;
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length;
    sentences.push(chunk.slice(start, end));
    start = end;
    lastEnd = end;
  }
  return { sentences, tail: chunk.slice(lastEnd) };
}
class SentenceSegmenter {
  buffer = "";
  maxChars;
  /** Removes markdown constructs that span deltas (fences, inline code). */
  markdown = new MarkdownStreamFilter();
  constructor(options = {}) {
    this.maxChars = options.maxSentenceChars ?? 200;
  }
  /** Feed a raw delta; returns the complete sentences it completes. */
  feed(chunk) {
    const cleaned = plainText(this.markdown.push(chunk));
    if (!cleaned) return [];
    this.buffer += cleaned;
    const { sentences, tail } = splitSentences(this.buffer);
    this.buffer = tail;
    const out = [];
    for (const s of sentences) {
      const t = s.trim();
      if (t && !SKIP_PREFIX.test(t)) out.push(t);
    }
    if (this.buffer.length > this.maxChars) {
      const cut = this.buffer.search(/[，,、\s]/);
      const idx = cut > 0 ? cut : Math.floor(this.maxChars / 2);
      const head = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx);
      if (head) out.push(head);
    }
    return out;
  }
  /** Flush the remaining buffer (end of stream). */
  flush() {
    const rest = plainText(this.markdown.flush());
    if (rest) this.buffer += rest;
    const t = this.buffer.trim();
    this.buffer = "";
    if (t && !SKIP_PREFIX.test(t)) return [t];
    return [];
  }
}
class ParagraphGate {
  seg = new SentenceSegmenter();
  /** Unfed raw text that may still turn out to precede a blank line. */
  tail = "";
  /** True once the first blank line has been consumed. */
  closed = false;
  /** Feed a raw delta; returns first-paragraph sentences it completes. */
  feed(chunk) {
    if (this.closed) return [];
    const window = this.tail + chunk;
    this.tail = "";
    const blank = /\n[ \t]*\n/.exec(window);
    if (blank !== null) {
      this.closed = true;
      return this.seg.feed(window.slice(0, blank.index));
    }
    const hold = /[ \t]*\n[ \t]*$/.exec(window);
    if (hold !== null) {
      this.tail = hold[0];
      return this.seg.feed(window.slice(0, window.length - hold[0].length));
    }
    return this.seg.feed(window);
  }
  /**
   * End of turn. Without a blank line the whole turn is one paragraph, so
   * the buffered tail speaks; after one, the buffer holds the first
   * paragraph's unterminated tail, which also speaks.
   */
  flush() {
    this.tail = "";
    return this.seg.flush();
  }
}
export {
  ParagraphGate,
  SentenceSegmenter,
  plainText,
  splitSentences
};
