// The bidirectional relay behind the media-stream providers (deepgram, google):
// Twilio <Connect><Stream> opens a WebSocket to this Worker; this class owns both
// ends of it and shuttles audio and tool calls between them. The Durable Object
// keeps job state; this keeps sockets. mulaw/8kHz from Twilio stays mulaw for
// Deepgram; Gemini gets PCM16/16kHz, with 24kHz PCM16 coming back decimated and
// re-encoded to mulaw (see src/audio.ts).
import {
  Downsampler3x1,
  b64decode,
  b64encode,
  bytesToPcm16,
  mulawToPcm16,
  pcm16ToBytes,
  pcm16ToMulaw,
} from "./audio.ts";
import { deepgramSettings, googleSettings, googleWsUrl, providerOf } from "./providers.ts";
import type { CallJob } from "./call-job.ts"; // type-only: no runtime import cycle
import type { Env, Job } from "./types.ts";

type TwilioMessage = { event: string; streamSid?: string; start?: { streamSid?: string }; media?: { payload?: string }; dtmf?: { digit?: string } };

export class MediaRelay {
  twilioWs: WebSocket | null = null;
  streamSid: string | null = null;
  providerWs: WebSocket | null = null;
  downsampler: Downsampler3x1 | null = null;
  settingsApplied = false;
  prebuffer: Uint8Array[] = [];
  private seenTypes = new Set<string>();

  constructor(private host: CallJob, private env: Env, private ctx: DurableObjectState) {}

  private get job(): Job | null {
    return this.host.job;
  }

  // ---- Lifecycle ----

  async acceptTwilio(request: Request): Promise<Response> {
    const job = this.job!;
    const provider = providerOf(job, this.env);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket upgrade", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.twilioWs = server as unknown as WebSocket;
    server.accept();
    server.addEventListener("message", (m) => this.onTwilioEvent(m as { data: string | ArrayBuffer }));
    server.addEventListener("close", () => {
      this.twilioWs = null;
      this.streamSid = null;
    });

    const res =
      provider === "google"
        ? await fetch(googleWsUrl(this.env), { headers: { Upgrade: "websocket" } })
        : await fetch("wss://agent.deepgram.com/v1/agent/converse", {
            headers: { Upgrade: "websocket", Authorization: `Token ${this.env.DEEPGRAM_API_KEY}` },
          });
    const dg = res.webSocket;
    if (!dg) {
      const detail = (await res.text()).slice(0, 200);
      this.host.emit("error", { message: `${provider} connect failed: ${res.status} ${detail}` });
      server.close(1011, "provider connect failed");
      return new Response(`${provider} connect failed`, { status: 502 });
    }
    this.providerWs = dg;
    dg.accept();
    if (provider === "google") {
      this.downsampler = new Downsampler3x1();
      try {
        this.sendJson(googleSettings(this.env, job));
      } catch (err) {
        this.host.emit("error", { message: `google configuration invalid: ${String(err).slice(0, 200)}` });
        server.close(1011, "bad setup");
        dg.close(1000, "bad setup");
        return new Response("google configuration invalid", { status: 502 });
      }
    }
    dg.addEventListener("message", (m) => (provider === "google" ? this.onGoogleEvent(m as { data: string | ArrayBuffer }) : this.onDeepgramEvent(m as { data: string | ArrayBuffer })));
    dg.addEventListener("close", (e: CloseEvent) => {
      this.providerWs = null;
      this.settingsApplied = false;
      this.host.emit("status", { status: "voice_session_closed", code: e.code });
      // If the provider dropped first (crash, session limit), hang up the phone leg too —
      // otherwise the callee is stuck on a silent line until Twilio's TimeLimit.
      if (this.twilioWs && this.job && this.job.status !== "done" && this.job.status !== "ended") this.ctx.waitUntil(this.host.endCall());
    });
    await this.host.markAttached();
    this.host.emit("debug", { media: `twilio<->${provider}` });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Close both ends of the relay (deliberate hangup or provider teardown).
  close() {
    for (const ws of [this.providerWs, this.twilioWs]) {
      try {
        ws?.close(1000, "call ended");
      } catch {}
    }
    this.providerWs = null;
    this.twilioWs = null;
    this.settingsApplied = false;
    this.streamSid = null;
    this.prebuffer = [];
    this.downsampler = null;
  }

  // ---- Transport ----

  private sendJson(msg: unknown) {
    this.providerWs?.send(JSON.stringify(msg));
  }

  private toTwilio(msg: Record<string, unknown>) {
    this.twilioWs?.send(JSON.stringify(msg));
  }

  private sendAudioToProvider(mulaw: Uint8Array) {
    if (!this.providerWs) return;
    if (providerOf(this.job, this.env) === "google") {
      // Declare rate=8000 and let Gemini resample; just decode mulaw -> PCM16 LE.
      const pcm = mulawToPcm16(mulaw);
      this.sendJson({ realtimeInput: { audio: { data: b64encode(pcm16ToBytes(pcm)), mimeType: "audio/pcm;rate=8000" } } });
      return;
    }
    this.providerWs.send(mulaw.buffer as ArrayBuffer);
  }

  // Tool responses: deepgram wants FunctionCallResponse, gemini wants toolResponse.
  // The agent continues the turn once it receives this message.
  toolResponse(fc: { id: string; name: string }, result: unknown) {
    if (providerOf(this.job!, this.env) === "google") {
      const response = typeof result === "object" && result !== null && !Array.isArray(result) ? result : { result };
      this.sendJson({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response }] } });
      return;
    }
    this.sendJson({ type: "FunctionCallResponse", id: fc.id, name: fc.name, content: JSON.stringify(result) });
  }

  private onTwilioEvent(m: { data: string | ArrayBuffer }) {
    if (typeof m.data !== "string") return;
    let msg: TwilioMessage;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    switch (msg.event) {
      case "connected":
        break;
      case "start":
        this.streamSid = msg.start?.streamSid ?? msg.streamSid ?? null;
        this.host.emit("debug", { media_stream_sid: this.streamSid });
        break;
      case "media": {
        const payload = msg.media?.payload;
        if (typeof payload !== "string") break;
        const bytes = b64decode(payload);
        if (this.providerWs && this.settingsApplied) this.sendAudioToProvider(bytes);
        else if (this.prebuffer.length < 200) this.prebuffer.push(bytes);
        break;
      }
      case "dtmf":
        this.host.emit("dtmf", { digit: msg.dtmf?.digit });
        break;
      case "mark":
        break;
      case "stop":
        try {
          this.providerWs?.close(1000, "call ended");
        } catch {}
        this.providerWs = null;
        this.downsampler = null;
        break;
    }
  }

  // ---- Deepgram Voice Agent ----

  private onDeepgramEvent(m: { data: string | ArrayBuffer }) {
    // Binary frames are the agent's voice (mulaw/8kHz): pipe them to the caller unchanged.
    if (m.data instanceof ArrayBuffer) {
      if (this.twilioWs && this.streamSid) this.toTwilio({ event: "media", streamSid: this.streamSid, media: { payload: b64encode(new Uint8Array(m.data)) } });
      return;
    }
    let e: any;
    try {
      e = JSON.parse(String(m.data));
    } catch {
      return;
    }
    switch (e.type) {
      case "Welcome": {
        try {
          this.sendJson(deepgramSettings(this.env, this.job!));
        } catch (err) {
          this.host.emit("error", { message: `deepgram configuration invalid: ${String(err).slice(0, 200)}` });
          this.closeSides(1011);
        }
        break;
      }
      case "SettingsApplied":
        this.settingsApplied = true;
        this.flushPrebuffer();
        break;
      case "Settings":
      case "SettingsError":
      case "UnhandledClientMessage":
        if (e.type === "SettingsError") {
          this.host.emit("error", { message: `deepgram rejected Settings: ${JSON.stringify(e).slice(0, 300)}` });
          this.closeSides(1011);
        } else this.host.emit("debug", { deepgram_event: e.type, detail: e.description ?? String(e).slice(0, 200) });
        break;
      case "ConversationText": {
        const text = typeof e.content === "string" ? e.content.trim() : "";
        if (!text) break;
        if (e.role === "user") this.host.emit("said", { who: "them", text });
        else if (e.role === "assistant") this.host.noteAgentText(text);
        break;
      }
      case "UserStartedSpeaking":
        this.host.userSpeaking = true;
        // Barge-in: stop any buffered agent audio on the call right away.
        if (this.twilioWs && this.streamSid) this.toTwilio({ event: "clear", streamSid: this.streamSid });
        break;
      case "AgentThinking":
      case "ConversationTextDone":
        break;
      case "AgentAudioDone":
        this.host.noteAgentAudioDone();
        break;
      case "FunctionCallRequest":
        for (const fc of e.functions ?? []) {
          if (fc.client_side === false) {
            this.host.emit("debug", { server_side_function: fc.name });
            continue;
          }
          this.host.onTool(fc.name, fc.id, typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments ?? {}));
        }
        break;
      case "FunctionCallCancelled":
        for (const fc of e.functions ?? []) {
          if (this.host.pendingCheck?.id === fc.id) this.host.pendingCheck = null;
        }
        break;
      case "Error":
        this.host.emit("error", { message: e.description ?? e.message ?? JSON.stringify(e).slice(0, 300) });
        break;
      case "Warning":
        this.host.emit("debug", { deepgram_warning: e.description ?? String(e).slice(0, 200) });
        break;
      default:
        if (!this.seenTypes.has(e.type)) {
          this.seenTypes.add(e.type);
          this.host.emit("debug", { deepgram_event: e.type });
        }
    }
  }

  // ---- Gemini Live ----

  private onGoogleEvent(m: { data: string | ArrayBuffer }) {
    if (typeof m.data !== "string") return; // Gemini sends only JSON text frames
    let e: any;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (e.setupComplete !== undefined) {
      this.settingsApplied = true;
      this.flushPrebuffer();
      return;
    }
    if (e.toolCall) {
      for (const fc of e.toolCall.functionCalls ?? []) {
        this.host.onTool(fc.name, fc.id, JSON.stringify(fc.args ?? {}));
      }
      return;
    }
    if (e.toolCallCancellation) {
      for (const id of e.toolCallCancellation.ids ?? []) {
        if (this.host.pendingCheck?.id === id) this.host.pendingCheck = null;
      }
      return;
    }
    if (e.error) {
      this.host.emit("error", { message: `google: ${e.error.message ?? JSON.stringify(e.error).slice(0, 300)}` });
      return;
    }
    const sc = e.serverContent;
    if (sc) {
      // The callee's audio arrives base64-encoded as 24kHz PCM16 inside the model turn.
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          const b64 = part?.inlineData?.data;
          if (typeof b64 !== "string") continue;
          const pcm = bytesToPcm16(b64decode(b64));
          if (!this.downsampler) this.downsampler = new Downsampler3x1();
          const pcm8k = this.downsampler.process(pcm);
          const mulaw = pcm16ToMulaw(pcm8k);
          if (this.twilioWs && this.streamSid) {
            this.toTwilio({ event: "media", streamSid: this.streamSid, media: { payload: b64encode(mulaw) } });
          }
        }
      }
      // VAD interruption: the callee started talking over the agent — stop playback now.
      if (sc.interrupted === true) {
        this.host.userSpeaking = true;
        if (this.twilioWs && this.streamSid) this.toTwilio({ event: "clear", streamSid: this.streamSid });
      }
      if (sc.inputTranscription?.text) {
        // Gemini sends transcription deltas per message (same order as audio), like the SDK examples log them.
        const text = String(sc.inputTranscription.text).trim();
        if (text) this.host.emit("said", { who: "them", text });
      }
      if (sc.outputTranscription?.text) {
        const text = String(sc.outputTranscription.text).trim();
        if (text) this.host.noteAgentText(text);
      }
      if (sc.turnComplete) this.host.noteAgentAudioDone();
      return;
    }
    if (e.usageMetadata) return; // noise; could feed cost tracking later
    if (!this.seenTypes.has(e.type ?? "unknown")) {
      this.seenTypes.add(e.type ?? "unknown");
      this.host.emit("debug", { google_event: e.type ?? Object.keys(e)[0] });
    }
  }

  private flushPrebuffer() {
    for (const bytes of this.prebuffer) this.sendAudioToProvider(bytes);
    this.prebuffer = [];
  }

  private closeSides(code: number) {
    try {
      this.twilioWs?.close(code, "settings failed");
    } catch {}
    try {
      this.providerWs?.close(1000, "settings failed");
    } catch {}
  }
}
