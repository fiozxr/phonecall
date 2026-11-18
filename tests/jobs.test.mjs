import { test } from "node:test";
import assert from "node:assert/strict";
import { startJob } from "../src/jobs.ts";

// Validation and provider selection run before any Durable Object or network access,
// so these run with a stub env. The success path uses a stub DO that pretends to start.
const baseEnv = {
  PRINCIPAL_NAME: "Ryan",
  TWILIO_ACCOUNT_SID: "AC",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_PHONE_NUMBER: "+15551234567",
  SIP_USERNAME: "sip",
  SIP_PASSWORD: "pw",
  XAI_API_KEY: "xai-key",
  XAI_WEBHOOK_SECRET: "xai-whsec",
  CALL_JOB: { get: () => ({ start: async () => ({ ok: true }) }), idFromName: () => "stub" },
  REGISTRY: { get: () => ({}), idFromName: () => "main" },
};
const start = (input, env = baseEnv) => startJob(env, "https://phonecall.example.workers.dev", input);

test("rejects bad numbers and bad provider names", async () => {
  assert.equal((await start({ to: "555-1234", brief: "x" })).status, 400);
  assert.equal((await start({ to: "+1", brief: "x" })).status, 400);
  assert.equal((await start({ to: "+14155550100", brief: "x", provider: "grok" })).status, 400);
});

test("provider-specific secret requirements", async () => {
  const noOpenai = await start({ to: "+14155550100", brief: "x", provider: "openai" });
  assert.equal(noOpenai.status, 400);
  assert.match(noOpenai.error, /OPENAI_API_KEY/);
  const noDeepgram = await start({ to: "+14155550100", brief: "x", provider: "deepgram" });
  assert.equal(noDeepgram.status, 400);
  assert.match(noDeepgram.error, /DEEPGRAM_API_KEY/);
  const noGoogle = await start({ to: "+14155550100", brief: "x", provider: "google" });
  assert.equal(noGoogle.status, 400);
  assert.match(noGoogle.error, /GOOGLE_API_KEY/);
});

test("simulated calls are xai-only", async () => {
  const r = await start({ simulate: "a busy pizza counter", brief: "order a pizza", provider: "google" }, { ...baseEnv, GOOGLE_API_KEY: "g" });
  assert.equal(r.status, 400);
  assert.match(r.error, /xai/);
  const ok = await start({ simulate: "a busy pizza counter", brief: "order a pizza" }, { ...baseEnv, SIM_NUMBER: "+12125550100" });
  assert.match(ok.job_id, /^job_[0-9a-f]{12}$/);
});

test("brief requirements", async () => {
  assert.equal((await start({ to: "+14155550100" })).status, 400);
  assert.equal((await start({ to: "+14155550100", brief: "   " })).status, 400);
  assert.equal((await start({ to: "+14155550100", brief: "x".repeat(8001) })).status, 400);
});

test("success path returns a job id and validates provider routing", async () => {
  const xai = await start({ to: "+14155550100", brief: "book a table" });
  assert.match(xai.job_id, /^job_[0-9a-f]{12}$/);
  const google = await start({ to: "+14155550100", brief: "book a table", provider: "google" }, { ...baseEnv, GOOGLE_API_KEY: "g" });
  assert.match(google.job_id, /^job_[0-9a-f]{12}$/);
});
