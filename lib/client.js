window.__ModuleLoader__.load({ id: "@haoku123/dsh-voice", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  MicButton: () => MicButton,
  VoicePanel: () => VoicePanel,
  VoiceSettingsPage: () => VoiceSettingsPage,
  __resetVoiceConfigCache: () => __resetVoiceConfigCache,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/aec.ts
var DEFAULT_FILTER_LENGTH = 256;
var DEFAULT_DELAY = 64;
var DEFAULT_STEP = 0.1;
var DEFAULT_EPSILON = 1e-6;
var NlmsAec = class {
  w;
  xBuf;
  filterLength;
  delay;
  mu;
  eps;
  /** Ring cursor into xBuf (reference history). */
  cursor = 0;
  /** How many reference samples we have buffered so far (for warm-up). */
  filled = 0;
  constructor(options = {}) {
    this.filterLength = options.filterLength ?? DEFAULT_FILTER_LENGTH;
    this.delay = options.delay ?? DEFAULT_DELAY;
    this.mu = options.step ?? DEFAULT_STEP;
    this.eps = options.epsilon ?? DEFAULT_EPSILON;
    this.w = new Float32Array(this.filterLength);
    this.xBuf = new Float32Array(this.delay + this.filterLength);
  }
  /**
   * Push the next mic/reference block; returns the echo-removed mic samples
   * (same length as the input). Reference may be shorter than the mic block
   * (e.g. silence pad) — it is zero-filled to the block length.
   */
  process(mic, ref) {
    const n = mic.length;
    const out = new Float32Array(n);
    if (n === 0) return out;
    const xBuf = this.xBuf;
    const bufLen = xBuf.length;
    let cursor = this.cursor;
    for (let i = 0; i < n; i++) {
      xBuf[cursor] = i < ref.length ? ref[i] : 0;
      cursor = (cursor + 1) % bufLen;
      this.filled = Math.min(this.filled + 1, bufLen);
      const d = mic[i];
      if (this.filled >= this.delay + this.filterLength) {
        let y = 0;
        let norm = 0;
        let idx = (cursor - this.delay + bufLen) % bufLen;
        for (let t = 0; t < this.filterLength; t++) {
          const x = xBuf[idx];
          y += this.w[t] * x;
          norm += x * x;
          idx = (idx - 1 + bufLen) % bufLen;
        }
        const e = d - y;
        out[i] = e;
        const denom = norm + this.eps;
        const gain = this.mu * e / denom;
        idx = (cursor - this.delay + bufLen) % bufLen;
        for (let t = 0; t < this.filterLength; t++) {
          this.w[t] += gain * xBuf[idx];
          idx = (idx - 1 + bufLen) % bufLen;
        }
      } else {
        out[i] = d;
      }
    }
    this.cursor = cursor;
    return out;
  }
  /** Reset adaptation (call on start/stop to avoid stale speaker->mic path). */
  reset() {
    this.w.fill(0);
    this.xBuf.fill(0);
    this.cursor = 0;
    this.filled = 0;
  }
};

// src/asr.ts
var SAMPLE_RATE = 16e3;
var ENERGY_THRESHOLD = 0.015;
var LEVEL_CEILING = 0.25;
var SILENCE_TIMEOUT_MS = 2e3;
var MODEL_WAIT_MS = 1500;
var MAX_MODEL_WAITS = 240;
var MAX_SEGMENT_MS = 3e4;
var PRE_PAD_MS = 250;
var POST_PAD_MS = 350;
var MIN_HOLD_SEGMENT_S = 0.25;
var PARTIAL_INTERVAL_MS = 900;
var PARTIAL_MIN_S = 0.5;
var PARTIAL_MAX_S = 12;
var BUFFER_SIZE = 1024;
function createAsrEngine(config, basePath, getEchoReference2) {
  let state = "idle";
  const stateListeners = /* @__PURE__ */ new Set();
  const transcriptListeners = /* @__PURE__ */ new Set();
  const speechStartListeners = /* @__PURE__ */ new Set();
  const levelListeners = /* @__PURE__ */ new Set();
  const partialListeners = /* @__PURE__ */ new Set();
  let silenceTimeoutMs = config.silenceMs ?? SILENCE_TIMEOUT_MS;
  let energyThreshold = config.energyThreshold ?? ENERGY_THRESHOLD;
  const asrUrl = `${location.origin}${basePath.replace(/\/+$/, "")}/asr`;
  const pendingSegments = [];
  let draining = false;
  let finalEpoch = 0;
  let audioCtx = null;
  let stream = null;
  let processor = null;
  let active = false;
  let holdMode = false;
  let speechActive = false;
  let segment = [];
  let prePad = [];
  let silenceMs = 0;
  let segmentMs = 0;
  let inFlush = false;
  let sincePartialMs = 0;
  let partialInFlight = false;
  let partialEpoch = 0;
  let partialAbort = null;
  let partialSentSamples = 0;
  let partialSessionId = "";
  const newPartialSession = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  };
  const setState = (s) => {
    state = s;
    for (const fn of stateListeners) {
      try {
        fn(s);
      } catch {
      }
    }
  };
  const emitTranscript = (text) => {
    const t = text.trim();
    if (!t) return;
    for (const fn of transcriptListeners) {
      try {
        fn(t);
      } catch {
      }
    }
  };
  const concatSegment = () => {
    const samples = new Float32Array(segment.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of segment) {
      samples.set(c, off);
      off += c.length;
    }
    return samples;
  };
  const requestPartial = async () => {
    if (partialInFlight || partialListeners.size === 0 || segment.length === 0) return;
    const seconds = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
    if (seconds < PARTIAL_MIN_S || seconds > PARTIAL_MAX_S) return;
    const samples = concatSegment();
    if (samples.length <= partialSentSamples) return;
    const delta = samples.subarray(partialSentSamples);
    partialSentSamples = samples.length;
    const epoch = partialEpoch;
    partialInFlight = true;
    const ctrl = new AbortController();
    partialAbort = ctrl;
    try {
      const res = await fetch(asrUrl, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-dsh-session": partialSessionId
        },
        // .slice() copies so the body is exactly the delta: subarray() is a
        // view whose .buffer still spans the whole capture.
        body: delta.slice().buffer,
        signal: ctrl.signal
      });
      if (!res.ok) return;
      const out = await res.json();
      if (epoch !== partialEpoch) return;
      const text = (out.text ?? "").trim();
      if (!text) return;
      for (const fn of partialListeners) {
        try {
          fn(text);
        } catch {
        }
      }
    } catch {
    } finally {
      partialInFlight = false;
      if (partialAbort === ctrl) partialAbort = null;
    }
  };
  const drainSegments = async () => {
    if (draining) return;
    draining = true;
    let modelWaits = 0;
    try {
      while (pendingSegments.length > 0) {
        const audio = pendingSegments.shift();
        const epoch = finalEpoch;
        setState("transcribing");
        try {
          const body = audio.slice().buffer;
          const res = await fetch(asrUrl, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body
          });
          if (res.status === 503) {
            modelWaits += 1;
            if (modelWaits > MAX_MODEL_WAITS) {
              throw new Error("\u8BED\u97F3\u6A21\u578B\u4ECD\u5728\u51C6\u5907\u4E2D\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
            }
            setState("loading-model");
            pendingSegments.unshift(audio);
            await new Promise((resolve) => setTimeout(resolve, MODEL_WAIT_MS));
            continue;
          }
          if (!res.ok) throw new Error(`asr http ${res.status}`);
          modelWaits = 0;
          const out = await res.json();
          if (epoch === finalEpoch && out.text) emitTranscript(out.text);
        } catch (e) {
          console.warn(`[dsh-voice] transcription failed: ${String(e)}`);
        }
      }
    } finally {
      draining = false;
      setState(active ? speechActive ? "speech" : "recording" : "idle");
    }
  };
  const transcribeSegment = (audio) => {
    pendingSegments.push(audio);
    void drainSegments();
  };
  const finalizeSegment = () => {
    if (segment.length === 0) return;
    const samples = concatSegment();
    segment = [];
    speechActive = false;
    silenceMs = 0;
    segmentMs = 0;
    transcribeSegment(samples);
  };
  const flushWithPad = () => {
    const padSamples = Math.floor(POST_PAD_MS / 1e3 * SAMPLE_RATE);
    if (padSamples > 0) segment.push(new Float32Array(padSamples));
    finalizeSegment();
  };
  const handleAudio = (data) => {
    if (!active || inFlush) return;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    const durationMs = data.length / SAMPLE_RATE * 1e3;
    const level = Math.min(1, rms / LEVEL_CEILING);
    for (const fn of levelListeners) {
      try {
        fn(level);
      } catch {
      }
    }
    if (holdMode) {
      if (!speechActive && rms > energyThreshold) {
        speechActive = true;
        setState("speech");
        for (const fn of speechStartListeners) {
          try {
            fn();
          } catch {
          }
        }
      }
      segmentMs += durationMs;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) {
        flushWithPad();
        return;
      }
      sincePartialMs += durationMs;
      if (sincePartialMs >= PARTIAL_INTERVAL_MS) {
        sincePartialMs = 0;
        void requestPartial();
      }
      return;
    }
    if (rms > energyThreshold) {
      if (!speechActive) {
        speechActive = true;
        setState("speech");
        for (const fn of speechStartListeners) {
          try {
            fn();
          } catch {
          }
        }
        for (const p of prePad) segment.push(p);
        prePad = [];
      }
      segmentMs += durationMs;
      silenceMs = 0;
      segment.push(data);
      if (segmentMs > MAX_SEGMENT_MS) flushWithPad();
    } else if (speechActive) {
      segmentMs += durationMs;
      silenceMs += durationMs;
      segment.push(data);
      if (silenceMs > silenceTimeoutMs) flushWithPad();
    } else {
      prePad.push(data);
      const keepMs = PRE_PAD_MS;
      let total = 0;
      let cut = 0;
      for (let i = prePad.length - 1; i >= 0; i--) {
        total += prePad[i].length / SAMPLE_RATE * 1e3;
        if (total > keepMs) {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) prePad = prePad.slice(cut);
    }
  };
  const startRecorder = async () => {
    if (active) return;
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const rawRef = getEchoReference2?.()?.node ?? null;
    const echoRef = rawRef !== null && rawRef.context === audioCtx ? rawRef : null;
    if (rawRef !== null && echoRef === null) {
      console.warn("[dsh-voice] echo reference belongs to another AudioContext; using browser AEC");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: echoRef === null,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const source = audioCtx.createMediaStreamSource(stream);
    if (echoRef === null) {
      processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        handleAudio(new Float32Array(input));
      };
      source.connect(processor);
    } else {
      const aec = new NlmsAec({});
      processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 2, 1);
      processor.onaudioprocess = (e) => {
        const mic = e.inputBuffer.getChannelData(0);
        const ref = e.inputBuffer.getChannelData(1);
        handleAudio(aec.process(mic, ref));
      };
      source.connect(processor, 0, 0);
      echoRef.connect(processor, 0, 1);
    }
    processor.connect(audioCtx.destination);
    active = true;
  };
  const releaseCapture = async () => {
    try {
      stream?.getTracks().forEach((t) => t.stop());
    } catch {
    }
    stream = null;
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    try {
      await audioCtx?.close();
    } catch {
    }
    audioCtx = null;
    active = false;
  };
  const stopRecorder = async (discard = false) => {
    if (!active) return;
    active = false;
    inFlush = true;
    partialEpoch++;
    sincePartialMs = 0;
    try {
      partialAbort?.abort();
    } catch {
    }
    partialAbort = null;
    const wasHold = holdMode;
    holdMode = false;
    try {
      const keep = discard ? false : wasHold ? segment.length > 0 : speechActive;
      if (keep) {
        const capturedS = segment.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
        if (!wasHold || capturedS >= MIN_HOLD_SEGMENT_S) {
          const padSamples = Math.floor(POST_PAD_MS / 1e3 * SAMPLE_RATE);
          segment.push(new Float32Array(padSamples));
          finalizeSegment();
        } else {
          segment = [];
        }
      } else {
        segment = [];
      }
      speechActive = false;
      silenceMs = 0;
      segmentMs = 0;
      prePad = [];
    } finally {
      inFlush = false;
    }
    try {
      processor?.disconnect();
    } catch {
    }
    processor = null;
    partialSentSamples = 0;
    partialSessionId = "";
    try {
      void stream?.getTracks().forEach((t) => t.stop());
    } catch {
    }
    stream = null;
    try {
      await audioCtx?.close();
    } catch {
    }
    audioCtx = null;
  };
  return {
    get state() {
      return state;
    },
    async start(options) {
      if (active) return;
      holdMode = options?.hold === true;
      partialEpoch++;
      sincePartialMs = 0;
      partialSentSamples = 0;
      partialSessionId = newPartialSession();
      setState("recording");
      try {
        await startRecorder();
      } catch (error) {
        await releaseCapture();
        holdMode = false;
        setState("idle");
        throw error;
      }
    },
    async stop() {
      if (!active) {
        if (!draining) setState("idle");
        return;
      }
      await stopRecorder();
      if (!draining) setState("idle");
    },
    async cancel() {
      finalEpoch++;
      pendingSegments.length = 0;
      await stopRecorder(true);
      setState("idle");
    },
    onSegment(fn) {
      transcriptListeners.add(fn);
      return () => {
        transcriptListeners.delete(fn);
      };
    },
    onState(fn) {
      stateListeners.add(fn);
      fn(state);
      return () => {
        stateListeners.delete(fn);
      };
    },
    onSpeechStart(fn) {
      speechStartListeners.add(fn);
      return () => {
        speechStartListeners.delete(fn);
      };
    },
    onLevel(fn) {
      levelListeners.add(fn);
      return () => {
        levelListeners.delete(fn);
      };
    },
    onPartial(fn) {
      partialListeners.add(fn);
      return () => {
        partialListeners.delete(fn);
      };
    },
    setTranscriptHandler(fn) {
      transcriptListeners.clear();
      transcriptListeners.add(fn);
    },
    setAsrConfig(next) {
      if (typeof next.silenceMs === "number") silenceTimeoutMs = next.silenceMs;
      if (typeof next.energyThreshold === "number") energyThreshold = next.energyThreshold;
    }
  };
}

// src/client.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var BOOTSTRAP_BASE = "/dsh-voice-api";
var apiBase = BOOTSTRAP_BASE;
var configPromise = null;
function apiUrl(path) {
  return `${apiBase}${path}`;
}
function loadConfig(force = false) {
  if (force) configPromise = null;
  if (configPromise === null) {
    configPromise = fetch(`${BOOTSTRAP_BASE}/config`).then((r) => {
      if (!r.ok) throw new Error(`config http ${r.status}`);
      return r.json();
    }).then((c) => {
      const base = typeof c.basePath === "string" ? c.basePath.replace(/\/+$/, "") : "";
      if (base) apiBase = base;
      return c;
    }).catch((error) => {
      configPromise = null;
      throw error;
    });
  }
  return configPromise;
}
function __resetVoiceConfigCache() {
  configPromise = null;
  apiBase = BOOTSTRAP_BASE;
}
var inject = ["slots", "sessions"];
var PKG_NAME = "@haoku123/dsh-voice";
var SETTINGS_NS = "voice";
function isZhUi() {
  try {
    return String(navigator.language || "").toLowerCase().startsWith("zh");
  } catch {
    return false;
  }
}
function apply(ctx) {
  const engine = createAudioEngine();
  if (typeof ctx.inject === "function") {
    ctx.inject(["configForms"], (formsCtx) => {
      formsCtx.slots.inject(
        "plugins.bundle.config",
        () => formsCtx.slots.register(
          {
            name: "plugins.bundle.config",
            key: PKG_NAME
          },
          (ownerProps) => ownerProps.view === "summary" ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VoiceConfigPage, { formService: formsCtx.configForms })
        )
      );
      formsCtx.slots.inject(
        "settings.section",
        () => formsCtx.slots.register(
          {
            name: "settings.section",
            id: "voice",
            order: 37,
            label: () => isZhUi() ? "\u8BED\u97F3\u5BF9\u8BDD" : "Voice"
          },
          () => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VoiceSettingsPage, { formService: formsCtx.configForms })
        )
      );
    });
  }
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "voice",
        order: 100,
        inject: () => engine
      },
      VoicePanel
    )
  );
  ctx.slots.inject(
    "conversation.input.right",
    () => ctx.slots.register(
      {
        name: "conversation.input.right",
        id: "voice-mic",
        order: 50,
        // Barge-in primitives: skipPlayback is always safe (silence TTS +
        // drop the host synthesis queue); cancelTurn is the stop-button
        // route and is only fired while the session has a running turn.
        inject: (sessionId) => ({
          skipPlayback: () => {
            engine.skip();
            if (sessionId !== void 0) {
              void fetch(apiUrl("/cancel"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId })
              }).catch(() => {
              });
            }
          },
          cancelTurn: () => {
            if (sessionId === void 0) return;
            void ctx.sessions.binding(sessionId)?.session.cancel().catch(() => {
            });
          }
        })
      },
      MicButton
    )
  );
}
function base64ToAudioUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}
var audioElement = new Audio();
var sharedAudioCtx = null;
var echoRefNode = null;
function getEchoReference() {
  return echoRefNode ? { node: echoRefNode } : null;
}
function ensureAudioCtx() {
  if (sharedAudioCtx === null) {
    sharedAudioCtx = new AudioContext();
    const el = audioElement;
    if (el !== null && echoRefNode === null) {
      echoRefNode = sharedAudioCtx.createMediaElementSource(el);
      echoRefNode.connect(sharedAudioCtx.destination);
    }
  }
  return sharedAudioCtx;
}
function createAudioEngine() {
  const listeners = /* @__PURE__ */ new Set();
  let state = { connected: false, playing: false, caption: null };
  const queue = [];
  const audio = audioElement;
  let source = null;
  let connecting = false;
  const notify = () => {
    for (const fn of listeners) fn(state);
  };
  const setState = (patch) => {
    state = { ...state, ...patch };
    notify();
  };
  const playNext = () => {
    const frame = queue.shift();
    if (!frame) {
      setState({ playing: false, caption: null });
      return;
    }
    ensureAudioCtx();
    const url = base64ToAudioUrl(frame.audio);
    audio.src = url;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      playNext();
    };
    setState({ playing: true, caption: frame.text });
    void audio.play().catch(() => {
      setState({ playing: false });
    });
  };
  const connect = () => {
    if (source !== null || connecting) return;
    connecting = true;
    void loadConfig().then(() => {
      if (source !== null) return;
      source = new EventSource(apiUrl("/stream"));
      source.onopen = () => setState({ connected: true });
      source.onerror = () => setState({ connected: false });
      source.addEventListener("audio", (e) => {
        const frame = JSON.parse(e.data);
        queue.push(frame);
        if (audio.paused) playNext();
      });
    }).catch(() => {
      setState({ connected: false });
    }).finally(() => {
      connecting = false;
    });
  };
  const disconnect = () => {
    source?.close();
    source = null;
    setState({ connected: false, playing: false, caption: null });
  };
  const skip = () => {
    queue.length = 0;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    setState({ playing: false, caption: null });
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    fn(state);
    return () => {
      listeners.delete(fn);
    };
  };
  return { connect, disconnect, skip, subscribe };
}
function VoicePanel(props) {
  const { connect, disconnect, skip, subscribe } = props;
  const [state, setState] = (0, import_react.useState)({
    connected: false,
    playing: false,
    caption: null
  });
  (0, import_react.useEffect)(() => {
    connect();
    const unsubscribe = subscribe(setState);
    return () => {
      unsubscribe();
      disconnect();
    };
  }, [connect, disconnect, subscribe]);
  useStyle(UI_CSS);
  const playing = state.connected && state.playing;
  const dot = playing ? "#2ea043" : state.connected ? "#8b949e" : "#f85149";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "div",
    {
      style: {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderRadius: 999,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
        pointerEvents: "auto",
        background: "rgba(22, 24, 28, 0.85)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 8px 28px rgba(0, 0, 0, 0.4)",
        color: "#e6e8eb",
        maxWidth: 480,
        animation: "dshv-fadein 0.25s ease"
      },
      children: [
        playing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EqualizerBars, { color: "#2ea043", height: 13 }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            style: {
              width: 8,
              height: 8,
              borderRadius: 999,
              background: dot,
              flexShrink: 0,
              transition: "background 0.2s ease",
              ...state.connected ? {} : {
                "--dshv-pulse": "rgba(248, 81, 73, 0.45)",
                animation: "dshv-pulse 1.6s ease-out infinite"
              }
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            style: {
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              animation: "dshv-fadein 0.2s ease"
            },
            children: state.caption ?? (state.connected ? "voice ready" : "voice offline")
          },
          state.caption ?? "idle"
        ),
        state.playing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            className: "dshv-skip",
            onClick: skip,
            style: {
              border: "none",
              background: "rgba(255, 255, 255, 0.14)",
              color: "#fff",
              borderRadius: 999,
              padding: "3px 12px",
              fontSize: 11,
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 0.15s ease"
            },
            children: "skip"
          }
        ) : null
      ]
    }
  );
}
var STATE_LABEL = {
  idle: "voice: tap to speak",
  recording: "voice: listening\u2026",
  speech: "voice: speaking\u2026",
  transcribing: "voice: transcribing\u2026",
  "loading-model": "voice: loading model\u2026"
};
var STATE_COLOR = {
  idle: "#8b949e",
  recording: "#f85149",
  speech: "#2ea043",
  transcribing: "#58a6ff",
  "loading-model": "#bc8cff"
};
var UI_CSS = `
@keyframes dshv-fadein { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
@keyframes dshv-eq { 0%, 100% { transform: scaleY(0.35) } 50% { transform: scaleY(1) } }
@keyframes dshv-spin { to { transform: rotate(360deg) } }
@keyframes dshv-pulse {
  0% { box-shadow: 0 0 0 0 var(--dshv-pulse, rgba(248, 81, 73, 0.45)) }
  70% { box-shadow: 0 0 0 6px transparent }
  100% { box-shadow: 0 0 0 0 transparent }
}
.dshv-skip:hover { background: rgba(255, 255, 255, 0.26) !important }
.dshv-mic:hover { background: rgba(139, 148, 158, 0.14) !important }
.dshv-mic { touch-action: none }
@keyframes dshv-ptt-in { from { opacity: 0; transform: translateY(10px) scale(0.96) } to { opacity: 1; transform: none } }
.dshv-ptt-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 96px;
  pointer-events: none;
  background: linear-gradient(to top, rgba(1, 4, 9, 0.55), transparent 45%);
}
.dshv-ptt-card {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 18px 26px 14px;
  border-radius: 18px;
  background: rgba(22, 27, 34, 0.92);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(63, 185, 80, 0.35);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  animation: dshv-ptt-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  transition: border-color 0.2s ease;
}
.dshv-ptt-card.cancel { border-color: rgba(248, 81, 73, 0.5) }
.dshv-ptt-wave { display: flex; align-items: center; gap: 3px; height: 40px }
.dshv-ptt-wave.frozen .dshv-ptt-bar { opacity: 0.22 !important }
.dshv-ptt-bar {
  width: 3px; border-radius: 99px;
  transition: height 0.08s linear, background 0.2s ease, opacity 0.08s linear;
}
.dshv-ptt-hint {
  font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
  font-family: -apple-system, system-ui, sans-serif;
  transition: color 0.2s ease;
}
@keyframes dshv-blink { 50% { opacity: 0 } }
.dshv-ptt-live {
  max-width: 340px;
  font-size: 13.5px; line-height: 1.5;
  text-align: center; word-break: break-word;
  color: #e6edf3;
  font-family: -apple-system, system-ui, sans-serif;
  animation: dshv-fadein 0.18s ease;
}
.dshv-ptt-live.stale { color: #8b949e }
.dshv-ptt-caret {
  display: inline-block; width: 2px; height: 1em;
  margin-left: 3px; vertical-align: -0.15em;
  background: #3fb950;
  animation: dshv-blink 1s steps(1) infinite;
}
.dshv-ptt-spinner {
  display: inline-block; width: 10px; height: 10px;
  margin-right: 6px; vertical-align: -1px;
  border-radius: 999px;
  border: 2px solid rgba(88, 166, 255, 0.25);
  border-top-color: #58a6ff;
  animation: dshv-spin 0.7s linear infinite;
}
.dshv-kbd {
  display: inline-block; margin: 0 2px; padding: 0 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: #c9d1d9;
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.16);
}
.dshv-toast {
  position: fixed; left: 50%; bottom: 104px; z-index: 10001;
  transform: translateX(-50%);
  max-width: 460px;
  padding: 9px 16px; border-radius: 10px;
  font-family: -apple-system, system-ui, sans-serif;
  font-size: 12px; line-height: 1.5;
  color: #ffdcd7;
  background: rgba(45, 17, 17, 0.94);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(248, 81, 73, 0.45);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45);
  animation: dshv-ptt-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
@keyframes dshv-cover-in { from { transform: scale(0.7); opacity: 0 } to { transform: scale(1); opacity: 1 } }
.dshv-sendcover {
  position: fixed; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px;
  pointer-events: none;
  color: #fff;
  background: linear-gradient(135deg, #4493f8, #1f6feb);
  box-shadow: 0 2px 10px rgba(31, 111, 235, 0.45);
  animation: dshv-cover-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.dshv-sendcover.cancel {
  background: linear-gradient(135deg, #f85149, #b62324);
  box-shadow: 0 2px 10px rgba(248, 81, 73, 0.5);
}
`;
var styleInjected = false;
function useStyle(css) {
  (0, import_react.useEffect)(() => {
    if (styleInjected) return;
    styleInjected = true;
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  }, [css]);
}
var WAVE_BARS = 28;
var CANCEL_DRAG_PX = 80;
var HOLD_THRESHOLD_MS = 260;
var KEY_HOLD_THRESHOLD_MS = 600;
function hotkeyLabel(key) {
  const mac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? "");
  switch (key) {
    case "Control":
      return mac ? "\u2303" : "Ctrl";
    case "Alt":
      return mac ? "\u2325" : "Alt";
    case "Meta":
      return mac ? "\u2318" : "Win";
    case "Shift":
      return "Shift";
    case " ":
      return "Space";
    default:
      return key;
  }
}
function PressToTalkOverlay({
  levels,
  armedCancel,
  pending,
  partial,
  source,
  hotkey
}) {
  const accent = armedCancel ? "#f85149" : "#2ea043";
  const bars = Array.from({ length: WAVE_BARS }, (_, i) => levels[i] ?? 0);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-ptt-backdrop", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dshv-ptt-card${armedCancel ? " cancel" : ""}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `dshv-ptt-wave${pending ? " frozen" : ""}`, children: bars.map((v, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        className: "dshv-ptt-bar",
        style: {
          // 3px floor keeps the baseline visible during silence
          height: `${3 + v * 37}px`,
          background: accent,
          opacity: 0.45 + v * 0.55
        }
      },
      i
    )) }),
    partial && !armedCancel ? (
      // The interim text is a preview, not the transcript that will be
      // sent — dim it once the final pass is running to say so.
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dshv-ptt-live${pending ? " stale" : ""}`, children: [
        partial,
        pending ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-ptt-caret" })
      ] })
    ) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-ptt-hint", style: { color: armedCancel ? "#f85149" : "#8b949e" }, children: pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-ptt-spinner" }),
      "\u8BC6\u522B\u4E2D\u2026"
    ] }) : armedCancel ? "\u677E\u5F00\u624B\u6307 \u53D6\u6D88\u53D1\u9001" : source === "key" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      "\u677E\u5F00 ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-kbd", children: hotkeyLabel(hotkey) }),
      " \u53D1\u9001 \xB7",
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-kbd", children: "Esc" }),
      " \u53D6\u6D88"
    ] }) : "\u677E\u5F00\u53D1\u9001 \xB7 \u4E0A\u6ED1\u53D6\u6D88" })
  ] }) });
}
function micErrorMessage(err) {
  const name = err instanceof DOMException ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "\u9EA6\u514B\u98CE\u88AB\u62D2\u7EDD\uFF1A\u8BF7\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u7684\u6743\u9650\u8BBE\u7F6E\u91CC\u5141\u8BB8\u9EA6\u514B\u98CE";
    case "NotFoundError":
    case "OverconstrainedError":
      return "\u627E\u4E0D\u5230\u9EA6\u514B\u98CE\u8BBE\u5907\uFF1A\u8BF7\u68C0\u67E5\u7CFB\u7EDF\u8F93\u5165\u8BBE\u5907";
    case "NotReadableError":
      return "\u9EA6\u514B\u98CE\u88AB\u5176\u4ED6\u7A0B\u5E8F\u5360\u7528";
    case "NotSupportedError":
      return `\u97F3\u9891\u529F\u80FD\u4E0D\u53EF\u7528\uFF08NotSupportedError\uFF09\uFF1A${raw || "\u6D4F\u89C8\u5668\u65E0\u6CD5\u521B\u5EFA\u97F3\u9891\u4E0A\u4E0B\u6587\uFF0C\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5"}`;
    case "AbortError":
      return "\u5F55\u97F3\u542F\u52A8\u88AB\u4E2D\u65AD\uFF1A\u8BF7\u91CD\u8BD5";
    case "InvalidStateError":
      return `\u5F55\u97F3\u72B6\u6001\u5F02\u5E38\uFF08InvalidStateError\uFF09\uFF1A${raw || "\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5"}`;
    default:
      return raw ? `\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528\uFF08${name || "Error"}\uFF09\uFF1A${raw}` : "\u9EA6\u514B\u98CE\u4E0D\u53EF\u7528";
  }
}
function errorDetail(err) {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  return name ? `${name}: ${raw}` : raw;
}
async function runMicDiagnostics() {
  const checks = [];
  const add = (label, ok, detail) => {
    checks.push({ label, ok, detail });
  };
  add(
    "\u5B89\u5168\u4E0A\u4E0B\u6587",
    window.isSecureContext,
    window.isSecureContext ? "isSecureContext = true\uFF08localhost / HTTPS\uFF09" : "\u975E\u5B89\u5168\u4E0A\u4E0B\u6587\uFF1A\u6D4F\u89C8\u5668\u4F1A\u7981\u7528\u9EA6\u514B\u98CE\uFF0C\u8BF7\u7528 localhost \u6216 HTTPS \u6253\u5F00"
  );
  const md = navigator.mediaDevices;
  add("MediaDevices API", md !== void 0, md !== void 0 ? "\u53EF\u7528" : "navigator.mediaDevices \u4E0D\u5B58\u5728");
  if (md !== void 0) {
    try {
      const status = await navigator.permissions?.query({ name: "microphone" });
      const state = status?.state ?? "unknown";
      add(
        "\u9EA6\u514B\u98CE\u6743\u9650",
        state === "granted",
        state === "granted" ? "\u5DF2\u6388\u6743" : state === "denied" ? "\u5DF2\u88AB\u62D2\u7EDD\uFF08\u9700\u5728\u7AD9\u70B9\u6743\u9650\u91CC\u91CD\u65B0\u5141\u8BB8\uFF09" : "\u5C1A\u672A\u51B3\u5B9A\uFF08\u9996\u6B21\u5F55\u97F3\u4F1A\u5F39\u51FA\u6388\u6743\uFF09"
      );
    } catch {
      add("\u9EA6\u514B\u98CE\u6743\u9650", true, "\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u6743\u9650\u67E5\u8BE2\uFF0C\u8DF3\u8FC7");
    }
    try {
      const devices = await md.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput");
      const names = mics.map((m) => m.label || `\u8BBE\u5907 ${m.deviceId.slice(0, 6)}`).join("\u3001");
      add("\u8F93\u5165\u8BBE\u5907", mics.length > 0, mics.length > 0 ? `${mics.length} \u4E2A\uFF1A${names}` : "\u672A\u53D1\u73B0\u97F3\u9891\u8F93\u5165\u8BBE\u5907");
    } catch (e) {
      add("\u8F93\u5165\u8BBE\u5907", false, errorDetail(e));
    }
    let stream = null;
    try {
      stream = await md.getUserMedia({ audio: true });
      add("getUserMedia", true, "\u5DF2\u83B7\u53D6\u9EA6\u514B\u98CE\u97F3\u8F68");
    } catch (e) {
      add("getUserMedia", false, errorDetail(e));
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }
  try {
    const ctx = new AudioContext({ sampleRate: 16e3 });
    add("AudioContext(16k)", true, `state=${ctx.state}\uFF0C\u5B9E\u9645\u91C7\u6837\u7387 ${ctx.sampleRate}Hz`);
    await ctx.close();
  } catch (e) {
    add("AudioContext(16k)", false, errorDetail(e));
  }
  try {
    const res = await fetch(apiUrl("/config"), { cache: "no-store" });
    add("Host \u8BED\u97F3\u670D\u52A1", res.ok, res.ok ? "\u5DF2\u8FDE\u63A5" : `HTTP ${res.status}`);
  } catch (e) {
    add("Host \u8BED\u97F3\u670D\u52A1", false, errorDetail(e));
  }
  try {
    const res = await fetch(apiUrl("/status"), { cache: "no-store" });
    const data = await res.json();
    const m = data.model ?? {};
    const mb = (n) => `${Math.round((n ?? 0) / 1024 / 1024)}MB`;
    if (m.state === "ready") add("\u8BED\u97F3\u6A21\u578B", true, `\u5DF2\u5C31\u7EEA\uFF08${mb(m.total)}\uFF09`);
    else if (m.state === "downloading")
      add("\u8BED\u97F3\u6A21\u578B", false, `\u4E0B\u8F7D\u4E2D\uFF1A${mb(m.received)} / ${m.total ? mb(m.total) : "\u672A\u77E5"}\uFF08\u9996\u6B21\u4F7F\u7528\u9700\u4E0B\u8F7D\uFF0C\u5B8C\u6210\u540E\u81EA\u52A8\u53EF\u7528\uFF09`);
    else if (m.state === "error") add("\u8BED\u97F3\u6A21\u578B", false, `\u4E0B\u8F7D\u5931\u8D25\uFF1A${m.error ?? "\u672A\u77E5\u9519\u8BEF"}`);
    else add("\u8BED\u97F3\u6A21\u578B", false, "\u672A\u4E0B\u8F7D\uFF1A\u9996\u6B21\u8BF4\u8BDD\u65F6\u81EA\u52A8\u4E0B\u8F7D\u5E76\u91CD\u8BD5\uFF0C\u4E5F\u53EF\u70B9\u300C\u51C6\u5907\u8BED\u97F3\u6A21\u578B\u300D\u7ACB\u5373\u5F00\u59CB");
  } catch (e) {
    add("\u8BED\u97F3\u6A21\u578B", false, errorDetail(e));
  }
  return checks;
}
function SendKeyMicCover({
  rect,
  armedCancel,
  pending
}) {
  const size = Math.min(rect.width, rect.height);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      className: `dshv-sendcover${armedCancel ? " cancel" : ""}`,
      style: {
        left: rect.left + (rect.width - size) / 2,
        top: rect.top + (rect.height - size) / 2,
        width: size,
        height: size
      },
      children: pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "span",
        {
          className: "dshv-cover-spin",
          style: {
            width: size * 0.46,
            height: size * 0.46,
            borderRadius: 999,
            border: "2px solid rgba(255, 255, 255, 0.35)",
            borderTopColor: "#fff",
            animation: "dshv-spin 0.7s linear infinite"
          }
        }
      ) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 24 24", width: size * 0.52, height: size * 0.52, "aria-hidden": "true", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "path",
          {
            fill: "currentColor",
            d: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "path",
          {
            fill: "currentColor",
            d: "M17.3 11a.9.9 0 0 0-1.8 0 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8 0 5.3 5.3 0 0 0 4.4 5.2v1.9h-1.7a.9.9 0 0 0 0 1.8h5.2a.9.9 0 0 0 0-1.8h-1.7v-1.9A5.3 5.3 0 0 0 17.3 11Z"
          }
        )
      ] })
    }
  );
}
function EqualizerBars({ color, height = 12 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { display: "inline-flex", alignItems: "flex-end", gap: 2, height, flexShrink: 0 }, children: [0, 1, 2].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "span",
    {
      style: {
        width: 3,
        height: "100%",
        borderRadius: 99,
        background: color,
        transformOrigin: "bottom",
        animation: `dshv-eq 0.85s ease-in-out ${i * 0.18}s infinite`
      }
    },
    i
  )) });
}
function MicButton({ useSession, useInput, inputActions, skipPlayback, cancelTurn }) {
  const [asrState, setAsrState] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)(null);
  const engineRef = (0, import_react.useRef)(null);
  const configRef = (0, import_react.useRef)(null);
  const actionsRef = (0, import_react.useRef)(inputActions);
  const draftRef = (0, import_react.useRef)("");
  const runningRef = (0, import_react.useRef)(false);
  const [holding, setHolding] = (0, import_react.useState)(false);
  const [armedCancel, setArmedCancel] = (0, import_react.useState)(false);
  const [levels, setLevels] = (0, import_react.useState)([]);
  const [partial, setPartial] = (0, import_react.useState)("");
  const [pending, setPending] = (0, import_react.useState)(false);
  const [holdSource, setHoldSource] = (0, import_react.useState)("pointer");
  const holdSourceRef = (0, import_react.useRef)(null);
  const holdTimerRef = (0, import_react.useRef)(null);
  const startYRef = (0, import_react.useRef)(0);
  const armedCancelRef = (0, import_react.useRef)(false);
  const holdingRef = (0, import_react.useRef)(false);
  const hotkeyRef = (0, import_react.useRef)("");
  const [hotkey, setHotkey] = (0, import_react.useState)("");
  const submitOnTranscriptRef = (0, import_react.useRef)(false);
  const suppressClickRef = (0, import_react.useRef)(false);
  const [sendRect, setSendRect] = (0, import_react.useState)(null);
  const draft = useInput ? useInput((s) => s === void 0 ? void 0 : s.draft) : void 0;
  const running = useSession ? useSession((s) => s === void 0 ? void 0 : s.running) : void 0;
  const bargeRef = (0, import_react.useRef)({ skipPlayback, cancelTurn });
  (0, import_react.useEffect)(() => {
    bargeRef.current = { skipPlayback, cancelTurn };
  }, [skipPlayback, cancelTurn]);
  (0, import_react.useEffect)(() => {
    actionsRef.current = inputActions;
  }, [inputActions]);
  (0, import_react.useEffect)(() => {
    if (draft !== void 0) draftRef.current = String(draft ?? "");
  }, [draft]);
  (0, import_react.useEffect)(() => {
    runningRef.current = running === true;
  }, [running]);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    loadConfig().then((c) => {
      if (cancelled) return;
      configRef.current = c.asr;
      const hk = c.asr.hotkey ?? "";
      hotkeyRef.current = hk;
      setHotkey(hk);
      const engine = createAsrEngine(c.asr, c.basePath, getEchoReference);
      engine.onState(setAsrState);
      engine.onSpeechStart(() => {
        const { skipPlayback: skip, cancelTurn: cancel } = bargeRef.current;
        skip();
        if (runningRef.current) cancel();
      });
      engine.onSegment((text) => {
        setPending(false);
        setPartial("");
        setSendRect(null);
        const actions = actionsRef.current;
        if (!actions || typeof actions.setDraft !== "function") return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const current = draftRef.current;
        const next = current.trim() === "" ? trimmed : current.replace(/\s+$/, "") + " " + trimmed;
        actions.setDraft(next);
        const submitNow = submitOnTranscriptRef.current || c.asr.autoSend;
        submitOnTranscriptRef.current = false;
        if (submitNow && typeof actions.submit === "function") {
          setTimeout(() => {
            try {
              actions.submit?.();
            } catch {
            }
          }, 60);
        }
      });
      engineRef.current = engine;
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
      void engineRef.current?.stop();
      engineRef.current = null;
    };
  }, []);
  (0, import_react.useEffect)(() => {
    if (error === null) return;
    const t = setTimeout(() => setError(null), 4e3);
    return () => clearTimeout(t);
  }, [error]);
  const refreshAsrConfig = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      const c = await loadConfig(true);
      configRef.current = c.asr;
      engine.setAsrConfig(c.asr);
    } catch {
    }
  };
  const toggle = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setError(null);
    try {
      if (engine.state === "idle") {
        void refreshAsrConfig();
        await engine.start();
      } else {
        await engine.stop();
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  (0, import_react.useEffect)(() => {
    const engine = engineRef.current;
    if (!holding || !engine) return;
    setLevels([]);
    return engine.onLevel((level) => {
      setLevels((prev) => {
        const next = prev.length < WAVE_BARS ? [...prev, level] : [...prev.slice(1), level];
        return next;
      });
    });
  }, [holding]);
  (0, import_react.useEffect)(() => {
    const engine = engineRef.current;
    if (!holding || !engine || typeof engine.onPartial !== "function") return;
    setPartial("");
    return engine.onPartial(setPartial);
  }, [holding]);
  (0, import_react.useEffect)(() => {
    if (!pending) return;
    if (asrState === "transcribing" || asrState === "loading-model") return;
    const grace = asrState === "idle" ? 220 : 12e3;
    const t = setTimeout(() => {
      setPending(false);
      setPartial("");
      setSendRect(null);
    }, grace);
    return () => clearTimeout(t);
  }, [pending, asrState]);
  const endHold = (cancel) => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!holdingRef.current) {
      holdSourceRef.current = null;
      return;
    }
    const source = holdSourceRef.current;
    holdingRef.current = false;
    holdSourceRef.current = null;
    if (source === "pointer") suppressClickRef.current = true;
    setHolding(false);
    setArmedCancel(false);
    armedCancelRef.current = false;
    const engine = engineRef.current;
    if (cancel) {
      setSendRect(null);
      setPartial("");
      setPending(false);
      submitOnTranscriptRef.current = false;
      void engine?.cancel();
      return;
    }
    setPending(true);
    submitOnTranscriptRef.current = true;
    void engine?.stop();
  };
  const beginHold = (clientY, capture, overlayTarget, source = "pointer", thresholdMs = HOLD_THRESHOLD_MS) => {
    if (engineRef.current === null) return;
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    startYRef.current = clientY;
    holdSourceRef.current = source;
    capture?.();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      holdingRef.current = true;
      setHoldSource(source);
      setHolding(true);
      setPending(false);
      setPartial("");
      setError(null);
      const target = overlayTarget?.();
      if (target) {
        const r = target.getBoundingClientRect();
        setSendRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      void refreshAsrConfig();
      void engineRef.current?.start({ hold: true }).catch((err) => {
        setError(micErrorMessage(err));
        holdingRef.current = false;
        holdSourceRef.current = null;
        setHolding(false);
        setSendRect(null);
      });
    }, thresholdMs);
  };
  const moveHold = (clientY) => {
    if (!holdingRef.current) return;
    if (holdSourceRef.current === "key") return;
    const armed = startYRef.current - clientY > CANCEL_DRAG_PX;
    if (armed !== armedCancelRef.current) {
      armedCancelRef.current = armed;
      setArmedCancel(armed);
    }
  };
  const holdProps = {
    onPointerDown: (e) => {
      beginHold(e.clientY, () => {
        try {
          ;
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
        }
      });
    },
    onPointerMove: (e) => moveHold(e.clientY),
    onPointerUp: () => {
      if (holdSourceRef.current === "key") return;
      endHold(armedCancelRef.current);
    },
    onPointerCancel: () => {
      if (holdSourceRef.current === "key") return;
      endHold(true);
    }
  };
  const anchorRef = (0, import_react.useRef)(null);
  const findSendKey = () => {
    const anchor = anchorRef.current;
    if (!anchor) return null;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 4; depth++) {
      const buttons = Array.from(node.querySelectorAll("button")).filter(
        (b) => b !== anchor && !anchor.contains(b)
      );
      if (buttons.length > 0) return buttons[buttons.length - 1];
      node = node.parentElement;
    }
    return null;
  };
  const findSendKeyRef = (0, import_react.useRef)(findSendKey);
  findSendKeyRef.current = findSendKey;
  const beginHoldRef = (0, import_react.useRef)(beginHold);
  beginHoldRef.current = beginHold;
  const moveHoldRef = (0, import_react.useRef)(moveHold);
  moveHoldRef.current = moveHold;
  const endHoldRef = (0, import_react.useRef)(endHold);
  endHoldRef.current = endHold;
  (0, import_react.useEffect)(() => {
    const onDown = (e) => {
      const key = findSendKeyRef.current();
      if (!key) return;
      const r = key.getBoundingClientRect();
      const hit = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!hit) return;
      beginHoldRef.current(e.clientY, void 0, () => findSendKeyRef.current());
    };
    const onMove = (e) => moveHoldRef.current(e.clientY);
    const onUp = () => {
      if (holdSourceRef.current === "key") return;
      endHoldRef.current(armedCancelRef.current);
    };
    const onCancel = () => {
      if (holdSourceRef.current === "key") return;
      endHoldRef.current(true);
    };
    const onClick = (e) => {
      if (!suppressClickRef.current) return;
      const key = findSendKeyRef.current();
      const target = e.target;
      if (!key || !target || !(key === target || key.contains(target))) return;
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("click", onClick, true);
    };
  }, []);
  (0, import_react.useEffect)(() => {
    const onKeyDown = (e) => {
      const hk = hotkeyRef.current;
      if (!hk) return;
      if (holdSourceRef.current !== null) {
        if (e.key === hk) return;
        if (holdSourceRef.current === "pointer" && e.key !== "Escape") return;
        endHoldRef.current(true);
        return;
      }
      if (e.key !== hk || e.repeat || e.isComposing) return;
      beginHoldRef.current(
        0,
        void 0,
        () => findSendKeyRef.current(),
        "key",
        KEY_HOLD_THRESHOLD_MS
      );
    };
    const onKeyUp = (e) => {
      if (holdSourceRef.current !== "key") return;
      if (e.key !== hotkeyRef.current) return;
      endHoldRef.current(false);
    };
    const onBlur = () => {
      if (holdSourceRef.current === "key") endHoldRef.current(true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useStyle(UI_CSS);
  const busy = asrState === "transcribing" || asrState === "loading-model";
  const indicator = busy ? (
    // spinner ring while the host is recognizing / loading the model
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "span",
      {
        style: {
          width: 10,
          height: 10,
          borderRadius: 999,
          border: "2px solid rgba(188, 140, 255, 0.25)",
          borderTopColor: STATE_COLOR[asrState],
          animation: "dshv-spin 0.7s linear infinite",
          flexShrink: 0
        }
      }
    )
  ) : asrState === "speech" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EqualizerBars, { color: "#2ea043", height: 11 }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "span",
    {
      style: {
        width: 10,
        height: 10,
        borderRadius: 999,
        background: error ? "#f85149" : STATE_COLOR[asrState],
        display: "inline-block",
        flexShrink: 0,
        transition: "background 0.2s ease",
        ...asrState === "recording" && !error ? {
          "--dshv-pulse": "rgba(248, 81, 73, 0.45)",
          animation: "dshv-pulse 1.2s ease-out infinite"
        } : {}
      }
    }
  );
  const label = error ? "voice error" : asrState === "idle" ? "mic" : STATE_LABEL[asrState].replace("voice: ", "");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    holding || pending ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      PressToTalkOverlay,
      {
        levels,
        armedCancel,
        pending,
        partial,
        source: holdSource,
        hotkey
      }
    ) : null,
    (holding || pending) && sendRect ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SendKeyMicCover, { rect: sendRect, armedCancel, pending }) : null,
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-toast", children: error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        ref: anchorRef,
        className: "dshv-mic",
        onClick: toggle,
        ...holdProps,
        title: error ?? `${STATE_LABEL[asrState]}\uFF08\u957F\u6309\u8BF4\u8BDD\uFF0C\u677E\u5F00\u53D1\u9001${hotkey ? `\uFF1B\u4E5F\u53EF\u957F\u6309 ${hotkeyLabel(hotkey)}` : ""}\uFF09`,
        style: {
          border: "none",
          background: holding ? "rgba(63, 185, 80, 0.16)" : "transparent",
          cursor: "pointer",
          padding: "4px 8px",
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontFamily: "system-ui, sans-serif",
          color: error ? "#f85149" : holding ? "#3fb950" : "#8b949e",
          transition: "background 0.15s ease, color 0.2s ease"
        },
        children: [
          indicator,
          holding ? armedCancel ? "\u677E\u5F00\u53D6\u6D88" : "\u677E\u5F00\u53D1\u9001" : label
        ]
      }
    )
  ] });
}
var TTS_MODES = [
  { value: "first", label: "\u53EA\u64AD\u9996\u53E5", hint: "\u6BCF\u8F6E\u56DE\u7B54\u53EA\u6717\u8BFB\u7B2C\u4E00\u53E5\uFF0C\u5176\u4F59\u4EC5\u5728\u4F1A\u8BDD\u4E2D\u663E\u793A\uFF08\u6700\u7B80\u77ED\uFF09" },
  { value: "paragraph", label: "\u6717\u8BFB\u9996\u6BB5", hint: "\u6717\u8BFB\u56DE\u7B54\u7684\u7B2C\u4E00\u6BB5\uFF08\u5230\u7B2C\u4E00\u4E2A\u7A7A\u884C\u4E3A\u6B62\uFF09\uFF0C\u5176\u4F59\u4EC5\u663E\u793A\uFF08\u63A8\u8350\uFF1A\u65E2\u6709\u5185\u5BB9\u611F\u53C8\u4E0D\u5570\u55E6\uFF09" },
  { value: "all", label: "\u6574\u7BC7\u6717\u8BFB", hint: "\u9010\u53E5\u6717\u8BFB\u5B8C\u6574\u56DE\u7B54\uFF08\u539F\u7248\u884C\u4E3A\uFF09" },
  { value: "off", label: "\u9759\u97F3", hint: "\u53EA\u8F93\u5165\u4E0D\u6717\u8BFB\uFF1B\u9EA6\u514B\u98CE\u4E0E\u505C\u987F\u53D1\u9001\u4E0D\u53D7\u5F71\u54CD" }
];
var VOICE_OPTIONS = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-XiaoyiNeural",
  "zh-TW-HsiaoChenNeural",
  "en-US-AriaNeural",
  "en-US-GuyNeural",
  "ja-JP-NanamiNeural"
];
function asNested(value, key, fallback) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const inner = value[key];
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      return inner;
    }
  }
  return fallback;
}
function VoiceConfigPage({
  formService,
  showTitle = true
}) {
  useConfigStyle();
  const form = formService.get(SETTINGS_NS);
  const [snap, setSnap] = (0, import_react.useState)(form.getSnapshot());
  const [error, setError] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const update = () => setSnap(form.getSnapshot());
    update();
    return form.subscribe(update);
  }, [form]);
  const asr = asNested(snap.value, "asr", {});
  const tts = asNested(snap.value, "tts", {});
  const voice = typeof snap.value?.["voice"] === "string" ? snap.value["voice"] : "zh-CN-XiaoxiaoNeural";
  const autoSend = asr["autoSend"] === true;
  const hotkey = typeof asr["hotkey"] === "string" ? asr["hotkey"] : "Control";
  const silenceMs = typeof asr["silenceMs"] === "number" ? asr["silenceMs"] : 2e3;
  const ttsMode = typeof tts["mode"] === "string" ? tts["mode"] : "all";
  const [silenceText, setSilenceText] = (0, import_react.useState)(null);
  const shownSilence = silenceText ?? String(silenceMs);
  const [checks, setChecks] = (0, import_react.useState)(null);
  const [checking, setChecking] = (0, import_react.useState)(false);
  const energyThreshold = typeof asr["energyThreshold"] === "number" ? asr["energyThreshold"] : 0.015;
  const [thresholdText, setThresholdText] = (0, import_react.useState)(null);
  const shownThreshold = thresholdText ?? energyThreshold.toFixed(3);
  const write = async (ops) => {
    if (busy || !snap.writable) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await form.mutate(ops);
      if (!ok) setError("\u4FDD\u5B58\u88AB\u62D2\u7EDD\uFF1A\u914D\u7F6E\u53EF\u80FD\u521A\u88AB\u5176\u4ED6\u5730\u65B9\u4FEE\u6539\uFF0C\u5DF2\u91CD\u65B0\u52A0\u8F7D\u6700\u65B0\u503C");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (snap.status !== "ready") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("section", { className: "dshv-cfg", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshv-cfg-hint", children: snap.status === "loading" ? "\u6B63\u5728\u8BFB\u53D6\u8BED\u97F3\u914D\u7F6E\u2026" : "\u8BED\u97F3\u914D\u7F6E\u6682\u4E0D\u53EF\u7528\uFF08\u63D2\u4EF6\u672A\u6FC0\u6D3B\u6216\u90E8\u7F72\u53EA\u8BFB\uFF09" }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dshv-cfg", "aria-busy": busy, children: [
    showTitle && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dshv-cfg-title", children: "\u8BED\u97F3\u5BF9\u8BDD" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dshv-cfg-hint", children: [
      "\u4FEE\u6539\u7ACB\u5373\u751F\u6548\uFF1A\u4FDD\u5B58\u4F1A\u5199\u5165\u5F53\u524D profile \u7684\u63D2\u4EF6\u914D\u7F6E\u5E76\u70ED\u66F4\u65B0\uFF0C\u65E0\u9700\u91CD\u542F\u3002\u70B9\u6309\u9EA6\u514B\u98CE\u5F00\u542F\u8FDE\u7EED\u542C\u5199\uFF1B\u8BF4\u8BDD",
      " ",
      shownSilence,
      "ms \u9759\u97F3\u5373\u81EA\u52A8\u53D1\u9001\uFF1B\u6717\u8BFB\u65F6\u5F00\u53E3\u5373\u53EF\u6253\u65AD\u3002"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u505C\u987F\u5373\u53D1\u9001" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "checkbox",
            checked: autoSend,
            disabled: busy || !snap.writable,
            onChange: (e) => write([{ op: "set", path: ["asr", "autoSend"], value: e.target.checked }])
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-sub", children: "\u505C\u987F\u65AD\u53E5\u540E\u81EA\u52A8\u63D0\u4EA4\uFF0C\u4E0D\u7528\u624B\u52A8\u70B9\u53D1\u9001" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u9759\u97F3\u65AD\u53E5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "range",
            min: 200,
            max: 4e3,
            step: 100,
            value: shownSilence,
            disabled: busy || !snap.writable,
            onChange: (e) => setSilenceText(e.target.value),
            onInput: (e) => setSilenceText(e.target.value),
            onBlur: () => {
              const n = Number(shownSilence);
              setSilenceText(null);
              if (Number.isFinite(n) && n !== silenceMs) {
                void write([{ op: "set", path: ["asr", "silenceMs"], value: Math.max(200, Math.min(1e4, n)) }]);
              }
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-sub", children: [
          shownSilence,
          " ms\uFF08\u8D8A\u5C0F\u53D1\u9001\u8D8A\u5FEB\uFF0C\u8D8A\u5927\u8D8A\u80FD\u5BB9\u5FCD\u601D\u8003\u505C\u987F\uFF09"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u8BED\u97F3\u89E6\u53D1\u9608\u503C" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "range",
            min: 4e-3,
            max: 0.06,
            step: 1e-3,
            value: shownThreshold,
            disabled: busy || !snap.writable,
            onChange: (e) => setThresholdText(e.target.value),
            onBlur: () => {
              const n = Number(shownThreshold);
              setThresholdText(null);
              if (Number.isFinite(n) && Math.abs(n - energyThreshold) > 1e-9) {
                void write([{ op: "set", path: ["asr", "energyThreshold"], value: n }]);
              }
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-sub", children: [
          shownThreshold,
          " \xB7 ",
          shownThreshold >= "0.030" ? "\u8F83\u8FDF\u949D\uFF1A\u53EA\u5BF9\u8F83\u5927\u7684\u58F0\u97F3\u54CD\u5E94" : shownThreshold >= "0.015" ? "\u6807\u51C6\uFF1A\u9ED8\u8BA4\u7075\u654F\u5EA6" : "\u8F83\u7075\u654F\uFF1A\u8F7B\u58F0\u4E5F\u4F1A\u89E6\u53D1",
          "\uFF08\u8D8A\u5927\u8D8A\u6297\u566A\uFF0C\u8D8A\u5C0F\u8D8A\u7075\u654F\uFF09"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u6717\u8BFB\u7B56\u7565" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshv-cfg-control dshv-cfg-stack", children: TTS_MODES.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshv-cfg-choice", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "radio",
            name: "dshv-tts-mode",
            value: m.value,
            checked: ttsMode === m.value,
            disabled: busy || !snap.writable,
            onChange: () => write([{ op: "set", path: ["tts", "mode"], value: m.value }])
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: m.label }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: m.hint })
        ] })
      ] }, m.value)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u6717\u8BFB\u97F3\u8272" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            value: VOICE_OPTIONS.includes(voice) ? voice : "",
            disabled: busy || !snap.writable,
            onChange: (e) => write([{ op: "set", path: ["voice"], value: e.target.value }]),
            children: [
              !VOICE_OPTIONS.includes(voice) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "", children: [
                voice,
                "\uFF08\u81EA\u5B9A\u4E49\uFF09"
              ] }),
              VOICE_OPTIONS.map((v) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: v, children: v }, v))
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-sub", children: "\u5FAE\u8F6F Edge TTS \u5728\u7EBF\u5408\u6210" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u957F\u6309\u8BF4\u8BDD\u952E" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshv-cfg-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "select",
          {
            value: ["Control", "Alt", "Meta", "Shift", "Space", ""].includes(hotkey) ? hotkey : "",
            disabled: busy || !snap.writable,
            onChange: (e) => write([{ op: "set", path: ["asr", "hotkey"], value: e.target.value }]),
            children: [
              !["Control", "Alt", "Meta", "Shift", "Space", ""].includes(hotkey) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: "", children: [
                hotkey,
                "\uFF08\u81EA\u5B9A\u4E49\uFF09"
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "Control", children: "Control\uFF08\u9ED8\u8BA4\uFF09" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "Alt", children: "Alt" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "Meta", children: "\u2318 / Win" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "Shift", children: "Shift" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "Space", children: "Space" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u5173\u95ED\u952E\u76D8\u957F\u6309" })
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-sub", children: "\u957F\u6309\u8BF4\u8BDD\u3001\u677E\u5F00\u53D1\u9001\uFF1B\u6309\u4F4F\u671F\u95F4\u6309\u5176\u4ED6\u952E\u4F1A\u53D6\u6D88\u5F55\u97F3" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshv-cfg-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-name", children: "\u9EA6\u514B\u98CE\u81EA\u68C0" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshv-cfg-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshv-cfg-checkrow", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "dshv-cfg-check",
              disabled: checking,
              onClick: () => {
                setChecking(true);
                setChecks(null);
                void runMicDiagnostics().then(setChecks).catch((e) => setChecks([{ label: "\u81EA\u68C0\u5931\u8D25", ok: false, detail: errorDetail(e) }])).finally(() => setChecking(false));
              },
              children: checking ? "\u68C0\u6D4B\u4E2D\u2026" : "\u8FD0\u884C\u81EA\u68C0"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "dshv-cfg-check",
              disabled: checking,
              title: "\u4E0B\u8F7D SenseVoice \u6A21\u578B\uFF08\u7EA6 240MB\uFF09\uFF0C\u9996\u6B21\u4F7F\u7528\u5FC5\u987B\u5B8C\u6210",
              onClick: () => {
                setChecking(true);
                setChecks(null);
                void fetch(apiUrl("/model"), { method: "POST" }).catch(() => {
                }).then(() => new Promise((r) => setTimeout(r, 1200))).then(() => runMicDiagnostics()).then(setChecks).catch((e) => setChecks([{ label: "\u81EA\u68C0\u5931\u8D25", ok: false, detail: errorDetail(e) }])).finally(() => setChecking(false));
              },
              children: "\u51C6\u5907\u8BED\u97F3\u6A21\u578B"
            }
          )
        ] }),
        checks !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "dshv-cfg-checks", children: checks.map((c) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { "data-ok": c.ok ? "true" : "false", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: c.ok ? "\u2713" : "\u2717" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: c.label }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: c.detail })
        ] }, c.label)) }),
        checks === null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshv-cfg-sub", children: '\u957F\u6309\u9EA6\u514B\u98CE\u63D0\u793A"\u4E0D\u53EF\u7528"\u65F6\u8DD1\u4E00\u6B21\uFF1A\u9010\u9879\u68C0\u67E5\u5B89\u5168\u4E0A\u4E0B\u6587\u3001\u6743\u9650\u3001\u8BBE\u5907\u3001\u97F3\u9891\u4E0A\u4E0B\u6587\u4E0E Host \u8FDE\u63A5\uFF0C\u5931\u8D25\u9879\u4F1A\u5E26\u9519\u8BEF\u540D\u3002' })
      ] })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshv-cfg-error", role: "alert", children: error }),
    !snap.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshv-cfg-error", role: "status", children: "\u5F53\u524D\u90E8\u7F72\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u4FEE\u6539\u3002" })
  ] });
}
function VoiceSettingsPage({ formService }) {
  useConfigStyle();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dshv-cfg-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "dshv-cfg-page-title", children: "\u8BED\u97F3\u5BF9\u8BDD" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dshv-cfg-page-intro", children: "\u9EA6\u514B\u98CE\u8FDE\u7EED\u542C\u5199\u3001\u505C\u987F\u81EA\u52A8\u53D1\u9001\u3001\u8BED\u97F3\u6253\u65AD\u4E0E\u6717\u8BFB\u7B56\u7565\u3002\u4FEE\u6539\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(VoiceConfigPage, { formService, showTitle: false })
  ] });
}
var CONFIG_CSS = `
.dshv-cfg-page { display:flex; flex-direction:column; gap:10px; padding-top:8px; }
.dshv-cfg-page-title { margin:0; font-size:18px; font-weight:600; color:var(--dsw-alias-label-primary,inherit); }
.dshv-cfg-page-intro { margin:0 0 8px; font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary,inherit); }
.dshv-cfg { display:flex; flex-direction:column; gap:18px; font-family:var(--ds-font-family,-apple-system,system-ui,sans-serif); }
.dshv-cfg-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary,inherit); }
.dshv-cfg-hint { margin:0; font-size:12.5px; line-height:1.6; color:var(--dsw-alias-label-tertiary,inherit); }
.dshv-cfg-row { display:flex; gap:14px; align-items:flex-start; margin:0; }
.dshv-cfg-name { flex:none; width:92px; padding-top:6px; font-size:13px; font-weight:500; color:var(--dsw-alias-label-secondary,inherit); }
.dshv-cfg-control { flex:1; display:flex; flex-direction:column; gap:4px; min-width:0; }
.dshv-cfg-control input[type=checkbox] { width:16px; height:16px; accent-color:var(--dsw-alias-state-business-primary,#4f46e5); }
.dshv-cfg-control input[type=range] { width:100%; max-width:320px; accent-color:var(--dsw-alias-state-business-primary,#4f46e5); }
.dshv-cfg-control select {
  max-width:280px; height:32px; padding:0 10px; font:inherit; font-size:13px;
  color:var(--dsw-alias-label-primary,inherit); background:var(--dsw-alias-bg-layer-2,transparent);
  border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.4)); border-radius:8px; outline:none;
}
.dshv-cfg-control select:focus-visible { border-color:var(--dsw-alias-state-business-primary,#4f46e5); }
.dshv-cfg-sub { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary,inherit); }
.dshv-cfg-stack { gap:8px; }
.dshv-cfg-choice { display:flex; gap:10px; align-items:flex-start; cursor:pointer; }
.dshv-cfg-choice input[type=radio] { margin-top:3px; width:15px; height:15px; accent-color:var(--dsw-alias-state-business-primary,#4f46e5); }
.dshv-cfg-choice span { display:flex; flex-direction:column; gap:2px; }
.dshv-cfg-choice strong { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary,inherit); }
.dshv-cfg-choice em { font-style:normal; font-size:12px; color:var(--dsw-alias-label-tertiary,inherit); }
.dshv-cfg-error { margin:0; font-size:12.5px; color:var(--dsw-alias-state-error-primary,#f85149); }
.dshv-cfg-checkrow { display:flex; gap:8px; flex-wrap:wrap; }
.dshv-cfg-check {
  align-self:flex-start; height:28px; padding:0 12px; font:inherit; font-size:12.5px; cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit); background:var(--dsw-alias-bg-layer-3,transparent);
  border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.4)); border-radius:8px;
}
.dshv-cfg-check:hover:not(:disabled) { border-color:var(--dsw-alias-state-business-primary,#4f46e5); }
.dshv-cfg-check:disabled { opacity:.6; cursor:default; }
.dshv-cfg-checks { margin:8px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:6px; }
.dshv-cfg-checks li { display:flex; gap:8px; align-items:flex-start; font-size:12.5px; line-height:1.5; }
.dshv-cfg-checks li span { flex:none; width:12px; }
.dshv-cfg-checks li[data-ok=true] span { color:var(--dsw-alias-state-success-primary,#2ea043); }
.dshv-cfg-checks li[data-ok=false] span { color:var(--dsw-alias-state-error-primary,#f85149); }
.dshv-cfg-checks strong { flex:none; min-width:96px; font-weight:500; color:var(--dsw-alias-label-secondary,inherit); }
.dshv-cfg-checks em { font-style:normal; color:var(--dsw-alias-label-tertiary,inherit); overflow-wrap:anywhere; }
`;
var configStyleInjected = false;
function useConfigStyle() {
  (0, import_react.useEffect)(() => {
    if (configStyleInjected) return;
    configStyleInjected = true;
    const el = document.createElement("style");
    el.textContent = CONFIG_CSS;
    document.head.appendChild(el);
  }, []);
}
return module.exports; } });
