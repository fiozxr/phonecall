import { DurableObject } from "cloudflare:workers";
import { callerInstructions, callerTools, simulatedCalleeInstructions, summaryPrompt } from "./prompt.ts";
import { MS_PER_CHAR } from "./audio.ts";
import { MediaRelay } from "./media-relay.ts";
import { apiKey, acceptCall, summaryConfig, isMediaStreamProvider, providerDefault, providerOf, realtimeCallUrl, realtimeWsUrl, sipUri, defaultVoice, type VoiceProviderName } from "./providers.ts";
import type { Env, Job, JobEvent, JobStatus, Question, Report } from "./types.ts";

const TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export interface StartInput {
  id: string;
  to: string;
  brief: string;
  origin: string;
  principal?: string;
  agentName?: string;
  voice?: string;
  maxMinutes?: number;
  answerTimeoutSec?: number;
  simulate?: string;
  provider?: VoiceProviderName;
}

type Answer = { question: string; answer: string | null; note?: string };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const send = (ws: WebSocket | null, msg: unknown) => ws?.send(JSON.stringify(msg));

// One phone call: dials through Twilio, runs the Grok voice session, collects questions and the transcript.
export class CallJob extends DurableObject<Env> {
  job: Job | null = null;
  agent: WebSocket | null = null;
  sim: WebSocket | null = null;
  // Media-stream pipeline (deepgram, google): owned by media-relay.ts, composed here.
  private readonly relay = new MediaRelay(this, this.env, this.ctx);
  // A check_messages call whose response is held until the principal answers an open question.
  pendingCheck: { id: string; name: string } | null = null;
  responseActive = false;
  userSpeaking = false;
  responseStartedAt = 0;
  audioEndsAt = 0;
  hangupPending = false;
  openerTimer: ReturnType<typeof setTimeout> | null = null;
  queue: Answer[] = [];
  waiters = new Set<() => void>();
  seenTypes = new Set<string>();
  finalizing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, type TEXT, data TEXT)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, question TEXT, status TEXT, answer TEXT, asked_at INTEGER, answered_at INTEGER)`);
    ctx.blockConcurrencyWhile(async () => {
      this.job = (await ctx.storage.get<Job>("job")) ?? null;
    });
  }

  // Media-stream helpers called by MediaRelay.
  async markAttached() {
    if (this.job) await this.registry().update(this.job.id, { attached: true });
  }

  noteAgentText(text: string) {
    this.emit("said", { who: "agent", text });
    this.audioEndsAt = Math.max(this.audioEndsAt, Date.now() + text.length * MS_PER_CHAR);
  }

  noteAgentAudioDone() {
    this.userSpeaking = false;
    this.audioEndsAt = Date.now();
    if (this.hangupPending) this.scheduleHangup();
  }

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("main"));
  }

  private async save() {
    await this.ctx.storage.put("job", this.job);
  }

  emit(type: string, data: Record<string, unknown> = {}) {
    this.ctx.storage.sql.exec(`INSERT INTO events (at, type, data) VALUES (?, ?, ?)`, Date.now(), type, JSON.stringify(data));
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private setStatus(status: JobStatus, extra: Record<string, unknown> = {}) {
    if (!this.job || this.job.status === status) return;
    this.job.status = status;
    this.emit("status", { status, ...extra });
    this.ctx.waitUntil(this.registry().update(this.job.id, { status }));
  }

  private events(after: number): JobEvent[] {
    return this.ctx.storage.sql
      .exec<{ seq: number; at: number; type: string; data: string }>(`SELECT * FROM events WHERE seq > ? ORDER BY seq`, after)
      .toArray()
      .map((r) => ({ seq: r.seq, at: r.at, type: r.type, data: JSON.parse(r.data) }));
  }

  private questions(status?: Question["status"]): Question[] {
    const rows = status
      ? this.ctx.storage.sql.exec(`SELECT * FROM questions WHERE status = ? ORDER BY asked_at`, status)
      : this.ctx.storage.sql.exec(`SELECT * FROM questions ORDER BY asked_at`);
    return rows.toArray().map((r) => ({
      id: r.id as string,
      question: r.question as string,
      status: r.status as Question["status"],
      answer: r.answer as string | null,
      askedAt: r.asked_at as number,
      answeredAt: r.answered_at as number | null,
    }));
  }

  // ---- API ----

  async start(input: StartInput): Promise<{ ok: true } | { error: string }> {
    if (this.job) return { error: "job already exists" };
    const env = this.env;
    const provider = input.provider ?? providerDefault(env);
    // env.VOICE is xai/openai-specific; deepgram's voice is the Flux TTS model id, google's the Gemini voice.
    const fallbackVoice = provider === "deepgram" ? env.DEEPGRAM_TTS_MODEL || "flux-kit-en" : provider === "google" ? env.GOOGLE_VOICE || "Kore" : env.VOICE || defaultVoice(provider);
    this.job = {
      id: input.id,
      to: input.to,
      brief: input.brief,
      principal: input.principal || env.PRINCIPAL_NAME || "",
      agentName: input.agentName || env.AGENT_NAME || "Sam",
      voice: input.voice || fallbackVoice,
      provider,
      maxMinutes: clamp(input.maxMinutes ?? 10, 1, 30),
      answerTimeoutSec: clamp(input.answerTimeoutSec ?? 60, 10, 300),
      simulate: input.simulate,
      origin: input.origin,
      status: "dialing",
      createdAt: Date.now(),
    };
    await this.save();
    await this.registry().add(this.job.id, this.job.to, this.job.brief);
    this.emit("status", { status: "dialing", to: this.job.to, simulated: !!this.job.simulate, provider });
    // Backstop in case Twilio's final status callback never arrives.
    await this.ctx.storage.setAlarm(Date.now() + (this.job.maxMinutes + 5) * 60_000);

    // Twilio connects the callee to the provider once they answer.
    // SIP bridges (xai, openai) use <Dial><Sip>; the xai URI carries an X-Job-Id parameter that
    // comes back in the webhook's sip_headers. Media-stream providers (deepgram, google) use a
    // bidirectional <Connect><Stream> WebSocket straight to this Worker, which relays the audio.
    let twiml: string;
    if (isMediaStreamProvider(provider)) {
      twiml = `<Response><Connect><Stream url="${xml(`${this.job.origin}/twilio/media/${this.job.id}`)}"/></Connect></Response>`;
    } else {
      const agentUri = sipUri(env, this.job);
      // OpenAI routes by the project id in the URI and needs no digest auth; xAI expects the SIP credentials.
      const sipElement = provider === "openai"
        ? `<Sip>${xml(agentUri)}</Sip>`
        : `<Sip username="${xml(env.SIP_USERNAME)}" password="${xml(env.SIP_PASSWORD)}">${xml(agentUri)}</Sip>`;
      twiml = `<Response><Dial>${sipElement}</Dial></Response>`;
    }
    const params = new URLSearchParams({
      From: env.TWILIO_PHONE_NUMBER,
      To: this.job.simulate ? `sip:${env.SIM_NUMBER}@sip.voice.x.ai;transport=tls?X-Sim-Job=${this.job.id}` : this.job.to,
      Twiml: twiml,
      StatusCallback: `${this.job.origin}/twilio/status/${this.job.id}`,
      StatusCallbackMethod: "POST",
      Timeout: "30",
      TimeLimit: String(this.job.maxMinutes * 60),
    });
    for (const e of ["initiated", "ringing", "answered", "completed"]) params.append("StatusCallbackEvent", e);
    if (this.job.simulate) {
      params.set("SipAuthUsername", env.SIP_USERNAME);
      params.set("SipAuthPassword", env.SIP_PASSWORD);
    }
    const res = await this.twilio("Calls.json", params);
    const body = await res.json<{ sid?: string; message?: string }>();
    if (!res.ok || !body.sid) {
      this.emit("error", { message: `Twilio refused the call: ${body.message ?? res.status}` });
      await this.finalize("failed");
      return { error: body.message ?? `twilio ${res.status}` };
    }
    this.job.twilioCallSid = body.sid;
    await this.save();
    return { ok: true };
  }

  async twilioStatus(p: Record<string, string>) {
    if (!this.job || this.job.status === "done") return;
    const s = p.CallStatus;
    this.job.twilioStatus = s;
    if (s === "ringing") this.setStatus("ringing");
    else if (s === "in-progress") {
      this.job.answeredAt = Date.now();
      this.setStatus("connected");
    } else if (TERMINAL.has(s)) {
      this.job.durationSec = Number(p.CallDuration ?? 0);
      await this.save();
      await this.finalize(s);
      return;
    }
    await this.save();
  }

  // OpenAI requires the inbound SIP call to be accepted before anything can attach to it.
  // xAI accepts implicitly, so this is a no-op there.
  async acceptVoiceCall(callId: string): Promise<{ ok: true } | { error: string }> {
    if (!this.job) return { error: "unknown job" };
    if (providerOf(this.job, this.env) !== "openai") return { ok: true };
    const result = await acceptCall(this.env, this.job, callId);
    if ("error" in result) {
      this.emit("error", { message: result.error });
      return result;
    }
    this.emit("debug", { accepted: true });
    return { ok: true };
  }

  // Twilio <Connect><Stream> opens a bidirectional WebSocket to /twilio/media/<job-id>.
  // This Worker is the media relay for the media-stream providers (see media-relay.ts).
  async fetch(request: Request): Promise<Response> {
    if (!this.job) return new Response("unknown job", { status: 404 });
    const provider = providerOf(this.job, this.env);
    if (!isMediaStreamProvider(provider)) return new Response("unknown job", { status: 404 });
    return this.relay.acceptTwilio(request);
  }


  async attach(callId: string, role: "agent" | "sim", sipHeaders: string[]): Promise<{ ok: true } | { error: string }> {
    if (isMediaStreamProvider(providerOf(this.job, this.env))) return { error: "this provider uses Twilio media streams, not SIP attach" };
    if (!this.job || this.job.status === "done" || this.job.status === "ended") return { error: "no live job" };
    if (role === "agent" ? this.agent : this.sim) return { error: "already attached" };
    this.emit("debug", { sip_leg: role, sip_headers: sipHeaders });
    if (role === "agent") this.job.xaiCallId = callId; // realtime call id (both providers)
    else this.job.simCallId = callId;
    await this.save();

    const env = this.env;
    const provider = providerOf(this.job, env);
    const res = await fetch(realtimeWsUrl(env, provider, callId), {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${apiKey(env, provider)}` },
    });
    const ws = res.webSocket;
    if (!ws) {
      this.emit("error", { message: `${provider} realtime connect failed (${role}): ${res.status} ${(await res.text()).slice(0, 200)}` });
      return { error: "realtime connect failed" };
    }
    ws.accept();
    if (role === "agent") {
      this.agent = ws;
      await this.registry().update(this.job.id, { attached: true });
      this.setupAgent(ws);
    } else {
      this.sim = ws;
      this.setupSim(ws);
    }
    return { ok: true };
  }

  async watch(after: number, timeoutMs: number) {
    if (!this.job) return null;
    let events = this.events(after);
    if (!events.length && this.job.status !== "done" && !this.questions("pending").length) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
        setTimeout(resolve, timeoutMs);
      });
      events = this.events(after);
    }
    return {
      status: this.job.status,
      cursor: events.at(-1)?.seq ?? after,
      events,
      pending: this.questions("pending"),
      report: this.job.report ?? null,
    };
  }

  async reply(questionId: string, answer: string): Promise<{ ok: true; delivered: boolean } | { error: string }> {
    const q = this.questions().find((x) => x.id === questionId);
    if (!q) return { error: `unknown question ${questionId}` };
    if (q.status === "answered") return { error: `${questionId} is already answered` };
    this.ctx.storage.sql.exec(`UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?`, answer, Date.now(), questionId);
    this.emit("answer", { id: questionId, answer, late: q.status === "timed_out" });
    if (!this.agent) return { ok: true, delivered: false };
    this.queue.push({ question: q.question, answer });
    this.flush();
    return { ok: true, delivered: true };
  }

  async hangup() {
    if (!this.job) return { error: "unknown job" };
    this.emit("status", { status: "hangup_requested" });
    await this.endCall();
    return { ok: true };
  }

  async report() {
    if (!this.job) return null;
    const { origin: _origin, ...job } = this.job;
    return {
      job,
      questions: this.questions(),
      transcript: this.events(0)
        .filter((e) => e.type === "said")
        .map((e) => ({ at: e.at, who: e.data.who, text: e.data.text })),
    };
  }

  async alarm() {
    if (this.job && this.job.status !== "done") {
      await this.endCall();
      await this.finalize("timeout");
    }
  }

  // ---- Voice session ----

  private setupAgent(ws: WebSocket) {
    const job = this.job!;
    ws.addEventListener("message", (m) => {
      if (typeof m.data === "string") this.onAgentEvent(JSON.parse(m.data));
    });
    ws.addEventListener("close", (e) => {
      this.agent = null;
      this.emit("status", { status: "voice_session_closed", code: e.code });
    });
    send(ws, {
      type: "session.update",
      session: {
        instructions: callerInstructions(job),
        voice: job.voice,
        turn_detection: { type: "server_vad" },
        tools: callerTools(job.principal),
      },
    });
    // The callee usually said "hello" before the bridge connected; open if they don't speak again.
    this.openerTimer = setTimeout(() => {
      if (!this.responseActive && !this.userSpeaking) this.respond();
    }, 1500);
  }

  // The transcript records what our agent heard, so a simulated call exercises the same path as a real one.
  private setupSim(ws: WebSocket) {
    ws.addEventListener("close", () => {
      this.sim = null;
    });
    send(ws, {
      type: "session.update",
      session: { instructions: simulatedCalleeInstructions(this.job!.simulate!), voice: "rex", turn_detection: { type: "server_vad" } },
    });
    send(ws, { type: "response.create" });
  }

  private onAgentEvent(e: any) {
    // Events still buffered after the call ended were never heard by anyone.
    if (!this.job || this.job.status === "ended" || this.job.status === "done") return;
    const provider = providerOf(this.job, this.env);
    switch (e.type) {
      case "response.created":
        this.responseActive = true;
        this.responseStartedAt = Date.now();
        break;
      case "response.output_audio.delta":
      case "response.output_audio_transcript.delta":
      case "response.function_call_arguments.delta":
      case "input_audio_buffer.append":
      case "ping":
        break;
      case "response.output_audio_transcript.done": {
        const text = e.transcript?.trim();
        if (!text) break;
        this.emit("said", { who: "agent", text });
        this.audioEndsAt = Math.max(this.audioEndsAt, this.responseStartedAt + text.length * MS_PER_CHAR);
        break;
      }
      case "conversation.item.added": {
        // xAI puts the caller's transcript on the committed user item; there is no separate transcription event.
        if (provider === "openai") break; // OpenAI reports it on its own transcription event instead
        const item = e.item ?? {};
        if (item.role !== "user" || item.type !== "message") break;
        const text = (item.content ?? [])
          .filter((c: any) => c.type === "input_audio")
          .map((c: any) => c.transcript ?? "")
          .join(" ")
          .trim();
        if (text) this.emit("said", { who: "them", text });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (provider !== "openai") break;
        const text = typeof e.transcript === "string" ? e.transcript.trim() : "";
        if (text) this.emit("said", { who: "them", text });
        break;
      }
      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        if (this.openerTimer) clearTimeout(this.openerTimer);
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        setTimeout(() => this.flush(), 400);
        break;
      case "response.function_call_arguments.done":
        this.onTool(e.name, e.call_id, e.arguments);
        break;
      case "response.done":
        this.responseActive = false;
        if (this.hangupPending) this.scheduleHangup();
        else this.flush();
        break;
      case "error":
        this.emit("error", { message: e.error?.message ?? JSON.stringify(e).slice(0, 300) });
        break;
      default:
        if (!this.seenTypes.has(e.type)) {
          this.seenTypes.add(e.type);
          this.emit("debug", { event: e.type, sample: JSON.stringify(e).slice(0, 300) });
        }
    }
  }

  onTool(name: string, callId: string, argsJson: string) {
    const job = this.job!;
    const provider = providerOf(job, this.env);
    const isMedia = isMediaStreamProvider(provider);
    // SIP providers need a function_call_output (+ sometimes response.create); the media-stream
    // providers take one response per request id and continue the turn by themselves.
    const out = (result: unknown, respond: boolean) =>
      isMedia ? this.relay.toolResponse({ id: callId, name }, result) : this.output(callId, result, respond);
    let args: Record<string, string> = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {}
    switch (name) {
      case "send_dtmf":
        // xAI sends the tones itself; the media-stream providers have no way to inject tones mid-stream.
        this.emit("dtmf", args);
        if (isMedia) out({ note: "DTMF isn't supported on this provider. Say you can't press the keys and ask for a person instead." }, false);
        return;
      case "request_input": {
        const id = `q${this.questions().length + 1}`;
        this.ctx.storage.sql.exec(`INSERT INTO questions (id, question, status, asked_at) VALUES (?, ?, 'pending', ?)`, id, args.question ?? "", Date.now());
        this.emit("input_request", { id, question: args.question });
        out({ status: "sent", note: `${job.principal} has your question. Don't say anything else about it unless they talk to you.` }, false);
        setTimeout(() => this.expireQuestion(id), job.answerTimeoutSec * 1000);
        // The agent is expected to call check_messages right after this response.
        return;
      }
      case "check_messages": {
        const answers = this.queue.splice(0);
        // With nothing to report, stay quiet instead of prompting a turn ("Still nothing...").
        if (answers.length) out({ answers }, true);
        else if (isMedia) this.pendingCheck = { id: callId, name }; // hold the call open; reply()/expireQuestion() answer it
        else out({ answers: [], note: `${job.principal} is still checking. Don't comment on it; carry on only if they talk to you.` }, false);
        return;
      }
      case "end_call":
        job.endCall = { outcome: args.outcome ?? "done", notes: args.notes };
        this.ctx.waitUntil(this.save());
        this.emit("end_call", job.endCall);
        out({ ok: true }, false);
        this.hangupPending = true;
        if (isMedia) {
          // No responseActive tracking: wait for AgentAudioDone, with a ceiling as backstop.
          this.audioEndsAt = Date.now() + 2500;
          this.scheduleHangup();
        } else if (!this.responseActive) this.scheduleHangup();
        return;
      default:
        out({ error: `unknown tool ${name}` }, true);
    }
  }

  private output(callId: string, result: unknown, respond: boolean) {
    send(this.agent, { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) } });
    if (respond) this.respond();
  }

  private respond() {
    if (!this.agent) return;
    send(this.agent, { type: "response.create" });
    this.responseActive = true;
  }

  // Deliver answers as a check_messages tool result. A plain system message gets ignored by the model.
  private flush() {
    if (!this.job) return;
    if (isMediaStreamProvider(providerOf(this.job, this.env))) {
      // The media providers can't be given a synthetic tool call; answer a check_messages we're holding open instead.
      if (this.pendingCheck && this.queue.length) {
        const answers = this.queue.splice(0);
        this.relay.toolResponse(this.pendingCheck, { answers });
        this.pendingCheck = null;
      }
      return;
    }
    if (!this.agent || this.responseActive || this.userSpeaking || this.hangupPending || !this.queue.length) return;
    const answers = this.queue.splice(0);
    const callId = `call-msg-${Date.now()}`;
    send(this.agent, { type: "conversation.item.create", item: { type: "function_call", call_id: callId, name: "check_messages", arguments: "{}" } });
    send(this.agent, { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ answers }) } });
    this.respond();
  }

  private expireQuestion(id: string) {
    const q = this.questions("pending").find((x) => x.id === id);
    if (!q || !this.job) return;
    this.ctx.storage.sql.exec(`UPDATE questions SET status = 'timed_out' WHERE id = ?`, id);
    this.emit("input_timeout", { id });
    this.queue.push({ question: q.question, answer: null, note: `${this.job.principal} didn't answer in time. Say you'll have to get back to them on that part and keep going.` });
    this.flush();
  }

  private scheduleHangup() {
    const wait = Math.max(this.audioEndsAt - Date.now(), 0) + 1200;
    setTimeout(() => this.ctx.waitUntil(this.endCall()), wait);
  }

  async endCall() {
    const job = this.job;
    if (!job) return;
    if (isMediaStreamProvider(providerOf(job, this.env))) this.relay.close();
    if (job.xaiCallId) {
      const provider = providerOf(job, this.env);
      const res = await fetch(realtimeCallUrl(provider, job.xaiCallId, "hangup"), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey(this.env, provider)}` },
      });
      if (res.ok) return;
    }
    if (job.twilioCallSid) {
      const status = job.status === "connected" ? "completed" : "canceled";
      await this.twilio(`Calls/${job.twilioCallSid}.json`, new URLSearchParams({ Status: status }));
    }
  }

  private twilio(path: string, body: URLSearchParams) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = this.env;
    return fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  // ---- Wrap-up ----

  private finalize(reason: string): Promise<void> {
    if (!this.job || this.job.status === "done") return Promise.resolve();
    this.finalizing ??= (async () => {
      const job = this.job!;
      job.endedAt = Date.now();
      this.setStatus("ended", { reason });
      if (this.openerTimer) clearTimeout(this.openerTimer);
      for (const ws of [this.agent, this.sim]) {
        try {
          ws?.close(1000, "call ended");
        } catch {}
      }
      this.relay.close();
      this.agent = this.sim = null;
      this.ctx.storage.sql.exec(`UPDATE questions SET status = 'timed_out' WHERE status = 'pending'`);
      job.report = await this.summarize(reason);
      await this.save();
      this.setStatus("done");
      this.emit("done", { report: job.report });
      await this.ctx.storage.deleteAlarm();
    })();
    return this.finalizing;
  }

  private async summarize(reason: string): Promise<Report> {
    const job = this.job!;
    const lines = this.events(0)
      .filter((e) => e.type === "said")
      .map((e) => `${e.data.who === "agent" ? job.agentName : "Them"}: ${e.data.text}`);
    const empty = (outcome: string, summary: string): Report => ({ outcome, summary, details: {}, commitments: [], follow_ups: [] });
    if (!lines.length) {
      if (reason === "busy") return empty("no_answer", "The line was busy.");
      if (reason === "no-answer") return empty("no_answer", "Nobody picked up.");
      if (reason === "completed") return empty("failed", "The call connected but nothing was said.");
      return empty("failed", `The call ended before anyone talked (${reason}).`);
    }
    const questions = this.questions()
      .map((q) => `- ${q.question} → ${q.answer ?? "(no answer)"}`)
      .join("\n");
    const provider = providerOf(job, this.env);
    try {
      if (provider === "google") {
        const model = this.env.GOOGLE_SUMMARY_MODEL || "gemini-2.5-flash";
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": this.env.GOOGLE_API_KEY ?? "", "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: summaryPrompt(job, lines.join("\n"), questions) }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        });
        const body = await res.json<any>();
        const text: string = body?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
        const parsed = JSON.parse(text);
        return {
          outcome: parsed.outcome ?? job.endCall?.outcome ?? "partial",
          summary: parsed.summary ?? "",
          details: parsed.details ?? {},
          commitments: parsed.commitments ?? [],
          follow_ups: parsed.follow_ups ?? [],
        };
      }
      const summary = summaryConfig(this.env, job);
      if (!summary) {
        return empty(job.endCall?.outcome ?? "partial", `Summary skipped (no summary LLM configured: set DEEPGRAM_THINK_ENDPOINT_URL/DEEPGRAM_THINK_MODEL or OPENAI_API_KEY). Agent note: ${job.endCall?.notes ?? "none"}`);
      }
      const res = await fetch(summary.url, {
        method: "POST",
        headers: { Authorization: summary.auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: summary.model,
          messages: [{ role: "user", content: summaryPrompt(job, lines.join("\n"), questions) }],
          response_format: { type: "json_object" },
        }),
      });
      const body = await res.json<any>();
      const parsed = JSON.parse(body.choices[0].message.content);
      return {
        outcome: parsed.outcome ?? job.endCall?.outcome ?? "partial",
        summary: parsed.summary ?? "",
        details: parsed.details ?? {},
        commitments: parsed.commitments ?? [],
        follow_ups: parsed.follow_ups ?? [],
      };
    } catch (err) {
      return empty(job.endCall?.outcome ?? "partial", `Summary failed (${String(err).slice(0, 120)}). Agent note: ${job.endCall?.notes ?? "none"}`);
    }
  }
}
