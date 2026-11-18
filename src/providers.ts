import { callerInstructions, callerTools } from "./prompt.ts";
import type { Env, Job } from "./types.ts";

// Voice providers plug in here. Two families:
//   - SIP bridge (xai, openai): Twilio <Dial><Sip> connects the call provider-side; the
//     Worker only manages the realtime sideband WebSocket and the job lifecycle.
//   - Media stream (deepgram, google): Twilio <Connect><Stream> opens a WebSocket to *this* Worker,
//     which relays phone audio to the Voice Agent / Live API and back.
export type VoiceProviderName = "xai" | "openai" | "deepgram" | "google";

export function isVoiceProvider(v: unknown): v is VoiceProviderName {
  return v === "xai" || v === "openai" || v === "deepgram" || v === "google";
}

export function providerDefault(env: Env): VoiceProviderName {
  const p = (env.VOICE_PROVIDER ?? "").trim().toLowerCase();
  return p === "openai" ? "openai" : p === "deepgram" ? "deepgram" : p === "google" ? "google" : "xai";
}

// `provider` is optional on stored jobs so calls written before multi-provider support keep working.
export function providerOf(job: Job | null | undefined, env: Env): VoiceProviderName {
  return job?.provider ?? providerDefault(env);
}

export function isMediaStreamProvider(name: VoiceProviderName): boolean {
  return name === "deepgram" || name === "google";
}

export function defaultVoice(name: VoiceProviderName): string {
  if (name === "openai") return "marin";
  if (name === "deepgram") return "flux-kit-en";
  if (name === "google") return "Kore";
  return "eve";
}

export function apiKey(env: Env, name: VoiceProviderName): string {
  switch (name) {
    case "openai": return env.OPENAI_API_KEY ?? "";
    case "deepgram": return env.DEEPGRAM_API_KEY ?? "";
    case "google": return env.GOOGLE_API_KEY ?? "";
    default: return env.XAI_API_KEY;
  }
}

// The SIP URI Twilio bridges the call into once the callee answers (SIP-bridge providers only).
// xAI exposes the job id as a SIP URI parameter, which it echoes back in the webhook's sip_headers;
// OpenAI's URI is fixed per project, so jobs are correlated from the webhook instead (see unattached()).
export function sipUri(env: Env, job: Job): string {
  const name = providerOf(job, env);
  if (name === "openai") return `sip:${env.OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls`;
  return `sip:${env.TWILIO_PHONE_NUMBER}@sip.voice.x.ai;transport=tls?X-Job-Id=${job.id}`;
}

export function realtimeWsUrl(env: Env, name: VoiceProviderName, callId: string): string {
  const base = name === "openai" ? "wss://api.openai.com/v1/realtime" : "wss://api.x.ai/v1/realtime";
  return `${base}?call_id=${encodeURIComponent(callId)}`;
}

export function realtimeCallUrl(name: VoiceProviderName, callId: string, action: "accept" | "hangup"): string {
  const base = name === "openai" ? "https://api.openai.com/v1/realtime/calls" : "https://api.x.ai/v1/realtime/calls";
  return `${base}/${encodeURIComponent(callId)}/${action}`;
}

// OpenAI requires the inbound SIP call to be accepted (with the session config)
// before its sideband WebSocket can attach. xAI accepts implicitly; Deepgram has no SIP accept step.
export async function acceptCall(env: Env, job: Job, callId: string): Promise<{ ok: true } | { error: string }> {
  const name = providerOf(job, env);
  if (name !== "openai") return { ok: true };
  const res = await fetch(realtimeCallUrl(name, callId, "accept"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey(env, name)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "realtime",
      model: env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
      instructions: callerInstructions(job),
      voice: job.voice,
      turn_detection: { type: "server_vad" },
      tools: callerTools(job.principal),
    }),
  });
  if (res.ok) return { ok: true };
  const text = (await res.text()).slice(0, 300);
  return { error: `OpenAI accept failed (${res.status}): ${text}` };
}

// ---- Deepgram Voice Agent (media-stream provider) ----

// Settings for the Voice Agent pipeline: Flux STT (turn-taking built in) + your choice of LLM
// ("think") + Flux TTS. The think step can point at ANY OpenAI-compatible chat completions URL,
// including a local model exposed through a tunnel — that is what "bring your own base URL" means.
export function deepgramSettings(env: Env, job: Job): Record<string, unknown> {
  const endpoint = (env.DEEPGRAM_THINK_ENDPOINT_URL ?? "").trim();
  const model = (env.DEEPGRAM_THINK_MODEL ?? "").trim() || (endpoint ? "" : "gpt-4o-mini");
  if (endpoint && !model) throw new Error("DEEPGRAM_THINK_ENDPOINT_URL is set but DEEPGRAM_THINK_MODEL is empty (any model name your endpoint understands, e.g. qwen2.5:7b)");
  const think: Record<string, unknown> = {
    provider: { type: "open_ai", model, ...(env.DEEPGRAM_THINK_TEMPERATURE ? { temperature: Number(env.DEEPGRAM_THINK_TEMPERATURE) } : {}) },
    prompt: callerInstructions(job),
    // defer_until_eot: hanging up must wait until the caller's turn is confirmed — a premature
    // end_call can't be un-hung-up.
    functions: callerTools(job.principal).map((f) => f.name === "end_call" ? { ...f, defer_until_eot: true } : f),
  };
  if (endpoint) think.endpoint = { url: endpoint, headers: { authorization: `Bearer ${env.DEEPGRAM_THINK_API_KEY ?? ""}` } };
  return {
    type: "Settings",
    mip_opt_out: true,
    audio: {
      // Phone audio: mulaw 8kHz both ways, no transcoding anywhere.
      input: { encoding: "mulaw", sample_rate: 8000 },
      output: { encoding: "mulaw", sample_rate: 8000, container: "none" },
    },
    agent: {
      listen: { provider: { type: "deepgram", model: env.DEEPGRAM_STT_MODEL || "flux-general-en", version: "v2" } },
      think,
      speak: { provider: { type: "deepgram", version: "v2", model: job.voice || env.DEEPGRAM_TTS_MODEL || "flux-kit-en" } },
    },
  };
}

// ---- Gemini Live API (media-stream provider) ----

// Gemini Live speaks raw PCM16 (16kHz in / 24kHz out). The Worker transcodes mulaw/8kHz from
// Twilio in and out (src/audio.ts). Transcriptions are requested both ways so the transcript
// path matches the other providers.
export function googleSettings(env: Env, job: Job): Record<string, unknown> {
  const model = (env.GOOGLE_LIVE_MODEL ?? "").trim() || "gemini-3.8-live";
  // Gemini functionDeclarations take {name, description, parameters}; blocking semantics keep
  // tool turns deterministic (check_messages stays open until it gets its response).
  const functionDeclarations = callerTools(job.principal).map(({ type: _t, ...rest }) => ({
    ...rest,
    behavior: "BLOCKING",
  }));
  return {
    setup: {
      model: model.startsWith("models/") ? model : `models/${model}`,
      responseModalities: ["AUDIO"],
      systemInstruction: { parts: [{ text: callerInstructions(job) }] },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: job.voice || "Kore" } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [{ functionDeclarations }],
    },
  };
}

export function googleWsUrl(env: Env): string {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(env.GOOGLE_API_KEY ?? "")}`;
}

export function chatCompletionsUrl(name: VoiceProviderName): string {
  return name === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.x.ai/v1/chat/completions";
}

export function defaultSummaryModel(env: Env, name: VoiceProviderName): string {
  return env.SUMMARY_MODEL || (name === "openai" ? "gpt-5-mini" : "grok-4.7");
}

// Deepgram manages no chat-completions endpoint of its own, so the post-call summary reuses the
// BYO think endpoint when one is configured, then falls back to OpenAI if a key is present.
// Neither available → null, and the report ships as transcript + a note instead of an LLM summary.
// (xai/openai/google resolve their summary inline; google uses generateContent with its own key.)
export function summaryConfig(env: Env, job: Job): { url: string; auth: string; model: string } | null {
  if (providerOf(job, env) === "google") return null;
  if (providerOf(job, env) !== "deepgram") {
    const name = providerOf(job, env);
    return { url: chatCompletionsUrl(name), auth: `Bearer ${apiKey(env, name)}`, model: defaultSummaryModel(env, name) };
  }
  if (env.DEEPGRAM_THINK_ENDPOINT_URL) {
    return { url: env.DEEPGRAM_THINK_ENDPOINT_URL, auth: `Bearer ${env.DEEPGRAM_THINK_API_KEY ?? ""}`, model: env.DEEPGRAM_SUMMARY_MODEL || env.DEEPGRAM_THINK_MODEL || "" };
  }
  if (env.OPENAI_API_KEY) {
    return { url: chatCompletionsUrl("openai"), auth: `Bearer ${env.OPENAI_API_KEY}`, model: env.SUMMARY_MODEL || "gpt-5-mini" };
  }
  return null;
}

// Which secret a /<provider>/webhook endpoint verifies against.
export function webhookSecret(env: Env, name: VoiceProviderName): string {
  return (name === "openai" ? env.OPENAI_WEBHOOK_SECRET : env.XAI_WEBHOOK_SECRET) || "";
}
