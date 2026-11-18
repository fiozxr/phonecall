import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { safeEqual, verifyTwilio, verifyStandardWebhook } from "../src/verify.ts";

const enc = new TextEncoder();

test("safeEqual compares timing-safely", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

function signTwilio(authToken, url, params) {
  const keys = [...new Set(params.keys())].sort();
  let data = url;
  for (const k of keys) for (const v of params.getAll(k)) data += k + v;
  return createHmac("sha1", authToken).update(data).digest("base64");
}

test("verifyTwilio accepts valid signatures and rejects tampering", async () => {
  const authToken = "twilio-auth-token";
  const url = "https://phonecall.example.workers.dev/twilio/status/job_abc";
  const params = new URLSearchParams({ CallStatus: "ringing", CallSid: "CA123" });
  const signature = signTwilio(authToken, url, params);
  assert.equal(await verifyTwilio(authToken, url, params, signature), true);
  assert.equal(await verifyTwilio(authToken, url, params, "bogus"), false);
  const tampered = new URLSearchParams({ CallStatus: "completed", CallSid: "CA123" });
  assert.equal(await verifyTwilio(authToken, url, tampered, signature), false);
  assert.equal(await verifyTwilio(authToken, url, params, null), false);
});

function webhookHeaders(body, secret, timestamp) {
  const id = "wh_" + randomBytes(8).toString("hex");
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return new Headers({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${sig}` });
}

test("verifyStandardWebhook accepts valid signatures (OpenAI-style, whsec_ base64)", async () => {
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const body = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "rtc_test" } });
  assert.equal(await verifyStandardWebhook(secret, webhookHeaders(body, secret), body), true);
  assert.equal(await verifyStandardWebhook(secret, webhookHeaders(body, secret), body + "x"), false);
  // stale timestamp (>5 min) is rejected even with a valid signature
  const stale = Math.floor(Date.now() / 1000) - 400;
  assert.equal(await verifyStandardWebhook(secret, webhookHeaders(body, secret, stale), body), false);
});

test("verifyStandardWebhook supports multiple space-separated signatures", async () => {
  const secret = "whsec_" + randomBytes(32).toString("base64");
  const body = "{}";
  const id = "wh_" + randomBytes(8).toString("hex");
  const ts = Math.floor(Date.now() / 1000);
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  const headers = new Headers({ "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,deadbeef v1,${sig}` });
  assert.equal(await verifyStandardWebhook(secret, headers, body), true);
});
