import { callerInstructions, callerTools } from "./prompt";
import type { Env, Job } from "./types";

// Every voice provider plugs in here. The realtime wire protocol is shared
// (it is the OpenAI Realtime protocol; xAI implements a compatible version of it),
// so per call the only provider-specific parts are:
//   - the SIP URI Twilio bridges into once the callee answers
//   - whether the provider requires an explicit "accept" before attaching
//   - API endpoints, keys and default models/voices
export type VoiceProviderName = "xai" | "openai";

export function isVoiceProvider(v: unknown): v is VoiceProviderName {
  return v === "xai" || v === "openai";
}

export function providerDefault(env: Env): VoiceProviderName {
  const p = (env.VOICE_PROVIDER ?? "").trim().toLowerCase();
  return p === "openai" ? "openai" : "xai";
}

// `provider` is optional on stored jobs so calls written before multi-provider support keep working.
export function providerOf(job: Job | null | undefined, env: Env): VoiceProviderName {
  return job?.provider ?? providerDefault(env);
}

export function defaultVoice(name: VoiceProviderName): string {
  return name === "openai" ? "marin" : "eve";
}

export function apiKey(env: Env, name: VoiceProviderName): string {
  return name === "openai" ? env.OPENAI_API_KEY ?? "" : env.XAI_API_KEY;
}

// The SIP URI Twilio bridges the call into once the callee answers.
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
// before its sideband WebSocket can attach. xAI accepts implicitly.
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

export function chatCompletionsUrl(name: VoiceProviderName): string {
  return name === "openai" ? "https://api.openai.com/v1/chat/completions" : "https://api.x.ai/v1/chat/completions";
}

export function defaultSummaryModel(env: Env, name: VoiceProviderName): string {
  return env.SUMMARY_MODEL || (name === "openai" ? "gpt-5-mini" : "grok-4.7");
}

// Which secret a /<provider>/webhook endpoint verifies against.
export function webhookSecret(env: Env, name: VoiceProviderName): string {
  return (name === "openai" ? env.OPENAI_WEBHOOK_SECRET : env.XAI_WEBHOOK_SECRET) || "";
}
