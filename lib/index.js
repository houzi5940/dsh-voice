// src/index.ts
import z from "@deepseek-ai/schemastery";
import { PassThrough, Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import os from "node:os";
import sherpa_onnx from "sherpa-onnx";

// src/segmenter.ts
var SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
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
var MarkdownStreamFilter = class {
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
};
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
var SentenceSegmenter = class {
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
};

// src/tts-queue.ts
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
var MP3_MAGIC = 255;
var RETRY_BASE_MS = 1e3;
var RETRY_MAX_MS = 3e4;
var MAX_RETRIES = 5;
var TtsQueue = class {
  tts = new MsEdgeTTS();
  queues = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  voice;
  prosody;
  ready = null;
  constructor(options = {}) {
    this.voice = options.voice ?? "zh-CN-XiaoxiaoNeural";
    this.prosody = options.prosody;
  }
  /** Initialize the Edge TTS WebSocket once (lazy, re-runnable after close). */
  async ensureReady() {
    if (this.ready) return this.ready;
    this.ready = this.tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
      wordBoundaryEnabled: false,
      sentenceBoundaryEnabled: false
    }).catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Enqueue one sentence for a session; starts the pump if idle. */
  enqueue(sessionId, text) {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = { pending: [], busy: false, seq: 0, epoch: 0, failures: 0, retry: null };
      this.queues.set(sessionId, q);
    }
    q.pending.push({ text, epoch: q.epoch });
    void this.pump(sessionId, q);
  }
  /**
   * Drop all pending sentences and invalidate the in-flight synthesis for
   * one session (barge-in). Sentences enqueued after this call get the new
   * epoch and play normally.
   */
  cancel(sessionId) {
    const q = this.queues.get(sessionId);
    if (q) {
      q.epoch++;
      q.pending.length = 0;
      this.clearRetry(q);
    }
  }
  /** Stop the backoff timer (if any) and let a fresh enqueue pump at once. */
  clearRetry(q) {
    if (q.retry !== null) {
      clearTimeout(q.retry);
      q.retry = null;
    }
  }
  /**
   * Re-run the pump after an exponential backoff.
   *
   * `ensureReady()` rejects whenever the Edge TTS handshake fails (offline,
   * blocked network, 403 after an upstream change). Retrying immediately —
   * which a `finally`-based re-pump would do — turns that into a hot loop of
   * WebSocket attempts. Back off instead, and drop the batch after a few
   * failures so a dead service cannot pin the queue forever.
   */
  scheduleRetry(sessionId, q) {
    if (q.pending.length === 0) return;
    q.failures++;
    if (q.failures > MAX_RETRIES) {
      console.warn(
        `[dsh-voice] TTS still unavailable, dropping ${q.pending.length} pending sentence(s)`
      );
      q.pending.length = 0;
      q.failures = 0;
      return;
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (q.failures - 1), RETRY_MAX_MS);
    this.clearRetry(q);
    q.retry = setTimeout(() => {
      q.retry = null;
      void this.pump(sessionId, q);
    }, delay);
    q.retry.unref?.();
  }
  async pump(sessionId, q) {
    if (q.busy || q.retry !== null) return;
    q.busy = true;
    try {
      await this.ensureReady();
      q.failures = 0;
      while (q.pending.length > 0) {
        const item = q.pending.shift();
        try {
          const { audioStream } = await this.tts.toStream(item.text);
          const chunks = [];
          for await (const chunk of audioStream) {
            chunks.push(chunk);
          }
          const buf = Buffer.concat(chunks);
          if (buf.length === 0 || buf[0] !== MP3_MAGIC) continue;
          if (item.epoch !== q.epoch) continue;
          const frame = {
            sessionId,
            seq: q.seq++,
            text: item.text,
            audio: buf.toString("base64")
          };
          for (const fn of this.listeners) {
            try {
              fn(frame);
            } catch {
            }
          }
        } catch (e) {
          console.warn(`[dsh-voice] synthesis failed: ${String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[dsh-voice] TTS unavailable: ${String(e)}`);
      this.scheduleRetry(sessionId, q);
    } finally {
      q.busy = false;
    }
  }
  async close() {
    for (const q of this.queues.values()) this.clearRetry(q);
    await this.tts.close();
    this.ready = null;
  }
};

// src/index.ts
var { createOfflineRecognizer } = sherpa_onnx;
var name = "voice";
var inject = ["webServer"];
var BOOTSTRAP_BASE = "/dsh-voice-api";
var Config = z.object({
  basePath: z.string().default("/dsh-voice-api"),
  voice: z.string().default("zh-CN-XiaoxiaoNeural"),
  enabled: z.boolean().default(true),
  cacheDir: z.string().default(join(os.homedir(), ".cache", "dsh-voice", "models")),
  asr: z.object({
    model: z.string().default("csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"),
    modelHost: z.string().default("https://huggingface.co"),
    language: z.string().default("auto"),
    useItn: z.boolean().default(true),
    autoSend: z.boolean().default(false),
    mode: z.union([z.const("toggle"), z.const("hold")]).default("toggle"),
    hotkey: z.string().default("Control")
  }).default({})
});
function apply(ctx, config) {
  const base = config.basePath.replace(/\/+$/, "") || BOOTSTRAP_BASE;
  const clients = /* @__PURE__ */ new Set();
  const queue = new TtsQueue({ voice: config.voice });
  const unsubscribe = queue.subscribe((frame) => {
    for (const send of clients) {
      try {
        send(frame);
      } catch {
      }
    }
  });
  ctx.effect(() => unsubscribe);
  const sessionSegmenters = /* @__PURE__ */ new Map();
  ctx.on("llm/stream", (options, next) => {
    const sessionId = options.sessionId;
    if (!config.enabled || sessionId === void 0) return next();
    return tapStream(sessionId, next(), queue, sessionSegmenters);
  });
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/stream`,
      handler: (req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        });
        res.write("retry: 3000\n\n");
        const send = (frame) => {
          res.write(`event: audio
data: ${JSON.stringify(frame)}

`);
        };
        clients.add(send);
        const heartbeat = setInterval(() => {
          res.write(": hb\n");
        }, 25e3);
        const cleanup = () => {
          clearInterval(heartbeat);
          clients.delete(send);
        };
        req.on("close", cleanup);
        res.on("close", cleanup);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/cancel`,
      handler: (req, res) => {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          let sessionId;
          try {
            sessionId = JSON.parse(body || "{}").sessionId;
          } catch {
          }
          if (sessionId) queue.cancel(sessionId);
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        });
      }
    })
  );
  const configHandler = (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ asr: config.asr, basePath: base }));
  };
  for (const prefix of /* @__PURE__ */ new Set([base, BOOTSTRAP_BASE])) {
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path: `${prefix}/config`,
        handler: configHandler
      })
    );
  }
  let recognizer = null;
  const getRecognizer = () => {
    if (recognizer) return recognizer;
    const repo = join(config.cacheDir, config.asr.model, "resolve", "main");
    recognizer = createOfflineRecognizer({
      modelConfig: {
        senseVoice: {
          model: join(repo, "model.int8.onnx"),
          language: config.asr.language,
          useInverseTextNormalization: config.asr.useItn ? 1 : 0
        },
        tokens: join(repo, "tokens.txt"),
        numThreads: 4,
        debug: 0,
        provider: "cpu"
      },
      decodingMethod: "greedy_search"
    });
    return recognizer;
  };
  const PARTIAL_WINDOW_S = 8;
  const PARTIAL_WINDOW_SAMPLES = PARTIAL_WINDOW_S * 16e3;
  const asrSessions = /* @__PURE__ */ new Map();
  const SESSION_TTL_MS = 6e4;
  const asrSessionTouch = /* @__PURE__ */ new Map();
  const touchSession = (id) => {
    asrSessionTouch.set(id, Date.now());
  };
  const sessionSweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, last] of asrSessionTouch) {
      if (now - last > SESSION_TTL_MS) {
        asrSessions.delete(id);
        asrSessionTouch.delete(id);
      }
    }
  }, 3e4);
  sessionSweeper.unref();
  const decodeSamples = (samples) => {
    const rec = getRecognizer();
    const stream = rec.createStream();
    stream.acceptWaveform(16e3, samples);
    rec.decode(stream);
    const text = rec.getResult(stream).text;
    stream.free();
    return text;
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: `${base}/asr`,
      handler: (req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const buf = Buffer.concat(chunks);
          res.setHeader("content-type", "application/json");
          if (buf.length % 4 !== 0 || buf.length === 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "invalid pcm payload" }));
            return;
          }
          const delta = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
          const session = String(req.headers["x-dsh-session"] ?? "");
          try {
            let text;
            if (session !== "") {
              const prev = asrSessions.get(session) ?? new Float32Array(0);
              const merged = new Float32Array(prev.length + delta.length);
              merged.set(prev, 0);
              merged.set(delta, prev.length);
              if (merged.length > PARTIAL_WINDOW_SAMPLES) {
                text = decodeSamples(merged.subarray(merged.length - PARTIAL_WINDOW_SAMPLES));
              } else {
                text = decodeSamples(merged);
              }
              asrSessions.set(session, merged);
              touchSession(session);
            } else {
              text = decodeSamples(delta);
            }
            res.statusCode = 200;
            res.end(JSON.stringify({ text }));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(error) }));
          }
        });
      }
    })
  );
  const inflight = /* @__PURE__ */ new Map();
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: `${base}/hf`,
      handler: (req, res) => {
        const suffix = req.url.slice(`${base}/hf`.length);
        const rel = decodeURIComponent(suffix.split("?")[0]).split("/").filter((s) => s && s !== "." && s !== "..");
        if (rel.length === 0) {
          res.statusCode = 400;
          res.end("bad path");
          return;
        }
        const localPath = join(config.cacheDir, ...rel);
        const upstreamUrl = config.asr.modelHost.replace(/\/+$/, "") + suffix;
        void serveModel(localPath, upstreamUrl, req.headers, res, inflight);
      }
    })
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: base,
      handler: (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, name: "dsh-voice", enabled: config.enabled }));
      }
    })
  );
  ctx.effect(() => () => {
    clearInterval(sessionSweeper);
    recognizer?.free();
    recognizer = null;
    void queue.close().catch(() => void 0);
  });
}
var MODEL_MIME = {
  ".json": "application/json; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8"
};
async function serveModel(localPath, upstreamUrl, headers, res, inflight) {
  const st = await stat(localPath).catch(() => null);
  if (st?.isFile()) {
    serveLocal(localPath, st, headers, res);
    return;
  }
  const partPath = `${localPath}.part`;
  const partSt = await stat(partPath).catch(() => null);
  const upstreamHeaders = {};
  if (headers.range) upstreamHeaders.range = headers.range;
  else if (partSt?.size) upstreamHeaders.range = `bytes=${partSt.size}-`;
  let up;
  try {
    up = await fetch(upstreamUrl, { headers: upstreamHeaders });
  } catch (error) {
    res.statusCode = 502;
    res.end(`upstream fetch failed: ${String(error)}`);
    return;
  }
  if (up.status === 416 && partSt?.size) {
    await rename(partPath, localPath).catch(() => void 0);
    const st2 = await stat(localPath).catch(() => null);
    if (st2?.isFile()) {
      serveLocal(localPath, st2, headers, res);
      return;
    }
  }
  const resumeFrom = partSt?.size ?? 0;
  const contentRange = up.headers.get("content-range");
  const rangeStart = contentRange === null ? NaN : Number(/^bytes (\d+)-/.exec(contentRange)?.[1] ?? NaN);
  const appending = up.status === 206 && resumeFrom > 0 && rangeStart === resumeFrom;
  res.statusCode = up.status;
  const pass = (name2) => {
    const value = up.headers.get(name2);
    if (value) res.setHeader(name2, value);
  };
  pass("content-type");
  pass("content-range");
  pass("accept-ranges");
  pass("etag");
  if (!up.headers.get("content-encoding")) pass("content-length");
  if (!up.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(up.body);
  const cacheable = (up.status === 200 || appending) && !headers.range && !inflight.has(localPath);
  if (!cacheable) {
    body.pipe(res);
    return;
  }
  try {
    await mkdir(dirname(localPath), { recursive: true });
  } catch {
    body.pipe(res);
    return;
  }
  const sink = createWriteStream(partPath, appending ? { flags: "a" } : {});
  const tee = new PassThrough();
  tee.pipe(res);
  tee.pipe(sink);
  body.pipe(tee);
  body.on("error", (error) => tee.destroy(error));
  tee.on("error", () => sink.destroy());
  const done = new Promise((resolve) => {
    sink.on("finish", () => {
      void rename(partPath, localPath).catch(() => unlink(partPath).catch(() => void 0)).finally(resolve);
    });
    sink.on("error", () => {
      void unlink(partPath).catch(() => void 0);
      resolve();
    });
  });
  inflight.set(localPath, done);
  await done;
  inflight.delete(localPath);
}
function serveLocal(filePath, st, headers, res) {
  const type = MODEL_MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("content-type", type);
  res.setHeader("accept-ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(headers.range ?? "");
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.statusCode = 416;
      res.setHeader("content-range", `bytes */${st.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("content-length", String(end - start + 1));
    res.setHeader("content-range", `bytes ${start}-${end}/${st.size}`);
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-length", String(st.size));
  createReadStream(filePath).pipe(res);
}
async function* tapStream(sessionId, inner, queue, sessionSegmenters) {
  const segmenter = new SentenceSegmenter();
  sessionSegmenters.set(sessionId, segmenter);
  let flushed = false;
  let completed = false;
  let finishReason = null;
  const flushOnce = () => {
    if (flushed) return;
    flushed = true;
    for (const s of segmenter.flush()) queue.enqueue(sessionId, s);
  };
  try {
    for await (const chunk of inner) {
      if (chunk.type === "text-delta" && chunk.text) {
        for (const s of segmenter.feed(chunk.text)) queue.enqueue(sessionId, s);
      }
      if (chunk.type === "finish") finishReason = chunk.reason;
      yield chunk;
    }
    completed = true;
  } finally {
    const aborted = finishReason !== null && typeof finishReason === "object" && finishReason.kind === "aborted";
    if (completed && !aborted) flushOnce();
    sessionSegmenters.delete(sessionId);
  }
}
export {
  Config,
  apply,
  inject,
  name
};
