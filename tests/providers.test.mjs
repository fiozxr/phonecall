import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isVoiceProvider,
  providerDefault,
  providerOf,
  isMediaStreamProvider,
  defaultVoice,
  sipUri,
  realtimeWsUrl,
  realtimeCallUrl,
  webhookSecret,
  chatCompletionsUrl,
  defaultSummaryModel,
  summaryConfig,
  deepgramSettings,
  googleSettings,
  googleWsUrl,
} from "../src/providers.ts";

const env = {
  TWILIO_PHONE_NUMBER: "+15551234567",
  XAI_API_KEY: "xai-key",
  XAI_WEBHOOK_SECRET: "whsec_xai",
  OPENAI_API_KEY: "sk-openai",
  OPENAI_PROJECT_ID: "proj_abc123",
  OPENAI_WEBHOOK_SECRET: "whsec_openai",
  DEEPGRAM_API_KEY: "dg-key",
  GOOGLE_API_KEY: "AIza-google-key",
};
const job = (over = {}) => ({ provider: "xai", id: "job_x", agentName: "Sam", principal: "Ryan", voice: "eve", brief: "Book a table for 2 at 7", ...over });

test("provider classification", () => {
  assert.deepEqual(["xai", "openai", "deepgram", "google"].filter(isVoiceProvider), ["xai", "openai", "deepgram", "google"]);
  assert.equal(isVoiceProvider("grok"), false);
  assert.equal(providerDefault({}), "xai");
  assert.equal(providerDefault({ VOICE_PROVIDER: "openAI" }), "openai");
  assert.equal(providerDefault({ VOICE_PROVIDER: "google" }), "google");
  assert.equal(providerDefault({ VOICE_PROVIDER: "garbage" }), "xai");
  assert.equal(providerOf(job({ provider: undefined }), {}), "xai"); // legacy jobs default to xai
  assert.equal(providerOf(job({ provider: undefined }), { VOICE_PROVIDER: "google" }), "google");
  assert.equal(isMediaStreamProvider("deepgram"), true);
  assert.equal(isMediaStreamProvider("google"), true);
  assert.equal(isMediaStreamProvider("xai"), false);
});

test("SIP bridge URLs are exact", () => {
  assert.equal(sipUri(env, job({ provider: "xai" })), "sip:+15551234567@sip.voice.x.ai;transport=tls?X-Job-Id=job_x");
  assert.equal(sipUri(env, job({ provider: "openai" })), "sip:proj_abc123@sip.api.openai.com;transport=tls");
  assert.equal(realtimeWsUrl(env, "xai", "call_9"), "wss://api.x.ai/v1/realtime?call_id=call_9");
  assert.equal(realtimeWsUrl(env, "openai", "call_9"), "wss://api.openai.com/v1/realtime?call_id=call_9");
  assert.equal(realtimeCallUrl("openai", "c", "hangup"), "https://api.openai.com/v1/realtime/calls/c/hangup");
  assert.equal(realtimeCallUrl("xai", "c", "accept"), "https://api.x.ai/v1/realtime/calls/c/accept");
  assert.equal(chatCompletionsUrl("openai"), "https://api.openai.com/v1/chat/completions");
  assert.equal(webhookSecret(env, "openai"), "whsec_openai");
  assert.equal(defaultSummaryModel({}, "xai"), "grok-4.7");
  assert.equal(defaultSummaryModel({ SUMMARY_MODEL: "custom" }, "xai"), "custom");
  assert.equal(defaultVoice("google"), "Kore");
});

test("deepgram settings: managed defaults", () => {
  const s = deepgramSettings(env, job({ provider: "deepgram", voice: "flux-kit-en" }));
  assert.equal(s.type, "Settings");
  assert.equal(s.audio.input.encoding, "mulaw");
  assert.equal(s.audio.input.sample_rate, 8000);
  assert.equal(s.agent.listen.provider.model, "flux-general-en");
  assert.equal(s.agent.think.provider.model, "gpt-4o-mini");
  assert.equal(s.agent.think.endpoint, undefined);
  assert.equal(s.agent.think.prompt.includes("Ryan"), true);
  assert.equal(s.agent.think.functions.length, 4);
  assert.equal(s.agent.think.functions.find((f) => f.name === "end_call").defer_until_eot, true);
  assert.equal(s.agent.speak.provider.model, "flux-kit-en");
});

test("deepgram settings: bring-your-own endpoint (local model)", () => {
  const s = deepgramSettings(
    { ...env, DEEPGRAM_THINK_ENDPOINT_URL: "https://abc.trycloudflare.com/v1/chat/completions", DEEPGRAM_THINK_MODEL: "qwen2.5:7b", DEEPGRAM_THINK_API_KEY: "ollama" },
    job({ provider: "deepgram" }),
  );
  assert.equal(s.agent.think.provider.model, "qwen2.5:7b");
  assert.equal(s.agent.think.endpoint.url, "https://abc.trycloudflare.com/v1/chat/completions");
  assert.equal(s.agent.think.endpoint.headers.authorization, "Bearer ollama");
  assert.throws(() => deepgramSettings({ ...env, DEEPGRAM_THINK_ENDPOINT_URL: "https://x/v1/chat/completions" }, job({ provider: "deepgram" })));
});

test("google settings: shape, tools stripped, BLOCKING", () => {
  const s = googleSettings(env, job({ provider: "google", voice: "Kore" }));
  assert.equal(s.setup.responseModalities[0], "AUDIO");
  assert.equal(s.setup.model, "models/gemini-3.8-live");
  assert.equal(s.setup.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
  assert.equal(s.setup.inputAudioTranscription !== undefined, true);
  assert.equal(s.setup.outputAudioTranscription !== undefined, true);
  assert.equal(s.setup.tools[0].functionDeclarations.length, 4);
  for (const f of s.setup.tools[0].functionDeclarations) {
    assert.equal("type" in f, false);
    assert.equal(f.behavior, "BLOCKING");
  }
  assert.equal(s.setup.systemInstruction.parts[0].text.includes("Ryan"), true);
  const s2 = googleSettings({ ...env, GOOGLE_LIVE_MODEL: "gemini-3.1-flash-live-preview" }, job({ provider: "google" }));
  assert.equal(s2.setup.model, "models/gemini-3.1-flash-live-preview");
  assert.equal(googleWsUrl(env).startsWith("wss://generativelanguage.googleapis.com/ws/"), true);
});

test("summary resolution across providers", () => {
  assert.equal(summaryConfig(env, job({ provider: "xai" })).model, "grok-4.7");
  assert.equal(summaryConfig(env, job({ provider: "openai" })).model, "gpt-5-mini");
  // deepgram with no BYO endpoint but an OPENAI_API_KEY falls back to OpenAI
  assert.equal(summaryConfig(env, job({ provider: "deepgram" })).url.includes("openai.com"), true);
  const noFallback = summaryConfig({ DEEPGRAM_API_KEY: "dg", XAI_API_KEY: "x", TWILIO_PHONE_NUMBER: "+1" }, job({ provider: "deepgram" }));
  assert.equal(noFallback, null); // nothing configured -> transcript-only report
  const byo = summaryConfig({ ...env, DEEPGRAM_THINK_ENDPOINT_URL: "https://t/v1/chat/completions", DEEPGRAM_THINK_MODEL: "qwen2.5:7b" }, job({ provider: "deepgram" }));
  assert.equal(byo.url, "https://t/v1/chat/completions");
  assert.equal(byo.model, "qwen2.5:7b");
  assert.equal(summaryConfig(env, job({ provider: "google" })), null); // google summarizes inline via generateContent
});
