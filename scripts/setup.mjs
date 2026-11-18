#!/usr/bin/env node
// One-time setup: stores the Worker's secrets with wrangler and writes the CLI config to ~/.config/phonecall.
// Works for all voice providers:
//   xai      (default) registers the Twilio number with xAI's SIP service; simulated test calls work
//   openai             no registration needed; you create the OpenAI webhook by hand (the script tells you how)
//   deepgram           no registration needed; STT/TTS run on Deepgram, and you can plug your own
//                      OpenAI-compatible LLM (including a local model via a tunnel) as the brain
// Values can come from environment variables of the same name; anything missing is asked for.
import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const simulate = !process.argv.includes("--no-sim");
const rl = createInterface({ input: process.stdin, output: process.stderr });

async function value(name, question, valid = () => true) {
  let v = process.env[name]?.trim();
  while (!v || !valid(v)) {
    if (v) console.error("  That doesn't look right, try again.");
    v = (await rl.question(`${question}: `)).trim();
  }
  return v;
}

function fail(message) {
  console.error(`\nsetup: ${message}`);
  process.exit(1);
}

const provider = (process.env.VOICE_PROVIDER?.trim().toLowerCase() || (await rl.question("Voice provider, xai, openai or deepgram [xai]: ")).trim().toLowerCase() || "xai");
if (provider !== "xai" && provider !== "openai" && provider !== "deepgram") fail("provider must be xai, openai or deepgram");
if (provider !== "xai" && simulate && !process.argv.includes("--no-sim")) {
  console.error("Note: --simulate is only supported by the xai provider; simulation will not be set up.");
}

const url = (await value("PHONECALL_URL", "Worker URL from `npx wrangler deploy` (https://phonecall.<you>.workers.dev)", (v) => v.startsWith("https://"))).replace(/\/$/, "");
const twilioSid = await value("TWILIO_ACCOUNT_SID", "Twilio Account SID (starts with AC)", (v) => v.startsWith("AC"));
const twilioToken = await value("TWILIO_AUTH_TOKEN", "Twilio Auth Token");
const number = await value("TWILIO_PHONE_NUMBER", "Twilio number to call from, like +14155550100", (v) => /^\+[1-9]\d{7,14}$/.test(v));
const principal = await value("PRINCIPAL_NAME", 'Your name, as the caller says it ("I\'m calling for ...")');

console.error("\nChecking Twilio...");
const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`, {
  headers: { Authorization: `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64")}` },
});
if (!tw.ok) fail(`Twilio rejected the credentials (HTTP ${tw.status}).`);
if (!(await tw.json()).incoming_phone_numbers?.length) fail(`${number} isn't a phone number on this Twilio account.`);

// Reuse PHONECALL_TOKEN when given, so connected CLIs and MCP clients keep working after a re-run.
const phonecallToken = process.env.PHONECALL_TOKEN?.trim() || randomBytes(32).toString("hex");
const secrets = {
  VOICE_PROVIDER: provider,
  TWILIO_ACCOUNT_SID: twilioSid,
  TWILIO_AUTH_TOKEN: twilioToken,
  TWILIO_PHONE_NUMBER: number,
  PRINCIPAL_NAME: principal,
  PHONECALL_TOKEN: phonecallToken,
};

if (provider === "openai") {
  const openaiKey = await value("OPENAI_API_KEY", "OpenAI API key", (v) => v.startsWith("sk-"));
  const projectId = await value("OPENAI_PROJECT_ID", "OpenAI project ID (starts with proj_, from platform.openai.com settings)", (v) => v.startsWith("proj_"));
  secrets.OPENAI_API_KEY = openaiKey;
  secrets.OPENAI_PROJECT_ID = projectId;
  const model = process.env.OPENAI_REALTIME_MODEL?.trim();
  if (model) secrets.OPENAI_REALTIME_MODEL = model;
  console.error(`
OpenAI needs one webhook, created by hand:
  1. platform.openai.com → your project → Webhooks → create
  2. URL: ${url}/openai/webhook
  3. Subscribe to the event: realtime.call.incoming
  4. Copy the webhook's signing secret (starts with whsec_)
`);
  secrets.OPENAI_WEBHOOK_SECRET = await value("OPENAI_WEBHOOK_SECRET", "OpenAI webhook signing secret (whsec_…)", (v) => v.length > 0);
  rl.close();
} else if (provider === "deepgram") {
  const deepgramKey = await value("DEEPGRAM_API_KEY", "Deepgram API key (free, no card: console.deepgram.com)");
  secrets.DEEPGRAM_API_KEY = deepgramKey;
  console.error(`
Deepgram does the ears and voice (Flux STT + Flux TTS, ~$200 of free credit).
The brain is an LLM of your choice — leave empty to use Deepgram's managed OpenAI models:`);
  const endpoint = process.env.DEEPGRAM_THINK_ENDPOINT_URL?.trim() ?? (await rl.question("LLM base URL, any OpenAI-compatible /v1/chat/completions (e.g. https://api.groq.com/openai/v1/chat/completions, or a tunnel to a local model — empty = Deepgram-managed OpenAI): ")).trim();
  if (endpoint) {
    secrets.DEEPGRAM_THINK_ENDPOINT_URL = endpoint;
    secrets.DEEPGRAM_THINK_MODEL = await value("DEEPGRAM_THINK_MODEL", "Model name your endpoint expects (e.g. qwen2.5:7b, openai/gpt-oss-20b)");
    secrets.DEEPGRAM_THINK_API_KEY = process.env.DEEPGRAM_THINK_API_KEY?.trim() ?? (await rl.question("API key for that endpoint (empty if it needs none): ")).trim();
    console.error("Local model tip: run Ollama + `cloudflared tunnel --url http://localhost:11434` and use https://<tunnel>/v1/chat/completions with a tool-capable model.");
  }
  const tts = process.env.DEEPGRAM_TTS_MODEL?.trim();
  if (tts) secrets.DEEPGRAM_TTS_MODEL = tts;
  rl.close();
} else {
  const xaiKey = await value("XAI_API_KEY", "xAI API key");
  rl.close();

  const sipUsername = `phonecall-${randomBytes(4).toString("hex")}`;
  const sipPassword = randomBytes(24).toString("hex");
  const xai = (path, init = {}) => fetch(`https://api.x.ai${path}`, { ...init, headers: { Authorization: `Bearer ${xaiKey}`, "Content-Type": "application/json", ...init.headers } });

  // Registers a number with xAI's SIP service and returns its webhook signing secret.
  // A registration left over from an earlier run is replaced, since its secret can't be read back.
  async function register(phone, name) {
    const body = JSON.stringify({
      origin: "byo_trunk",
      name,
      phone_number: phone,
      webhook: { name: "phonecall", url: `${url}/xai/webhook` },
      sip_auth: { auth_username: sipUsername, auth_password: sipPassword },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await xai("/v2/phone-numbers", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data.webhook.dispatch_signing_secret;
      const list = await (await xai("/v2/phone-numbers")).json().catch(() => ({}));
      const existing = list.phone_numbers?.find((n) => n.phone_number === phone);
      if (attempt > 0 || !existing) fail(`xAI didn't register ${phone} (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
      console.error(`  Replacing the earlier xAI registration for ${phone}`);
      await xai(`/v2/phone-numbers/${existing.phone_number_id}`, { method: "DELETE" });
    }
  }

  // NANP reserves 555-0100 to 555-0199 for fiction, so the simulator number can never be a real line.
  function fictionalNumber() {
    let areaCode;
    do areaCode = `${randomInt(2, 10)}${randomInt(0, 10)}${randomInt(0, 10)}`;
    while (areaCode.endsWith("11"));
    return `+1${areaCode}55501${String(randomInt(0, 100)).padStart(2, "0")}`;
  }

  console.error(`Registering ${number} with xAI...`);
  const webhookSecrets = [await register(number, "phonecall")];
  let simNumber;
  if (simulate) {
    simNumber = fictionalNumber();
    console.error(`Registering ${simNumber} for simulated calls...`);
    webhookSecrets.push(await register(simNumber, "phonecall simulator"));
  }

  Object.assign(secrets, {
    XAI_API_KEY: xaiKey,
    XAI_WEBHOOK_SECRET: webhookSecrets.join(","),
    SIP_USERNAME: sipUsername,
    SIP_PASSWORD: sipPassword,
    ...(simNumber ? { SIM_NUMBER: simNumber } : {}),
  });
}

console.error("Storing Worker secrets...");
const dir = mkdtempSync(join(tmpdir(), "phonecall-"));
const file = join(dir, "secrets.json");
writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
const [cmd, ...args] = (process.env.WRANGLER ?? "npx wrangler").split(" ");
const result = spawnSync(cmd, [...args, "secret", "bulk", file], { stdio: ["ignore", "inherit", "inherit"] });
rmSync(dir, { recursive: true, force: true });
if (result.status !== 0) fail("wrangler couldn't store the secrets. Run `npx wrangler login`, then `npm run setup` again.");

const configDir = join(homedir(), ".config", "phonecall");
mkdirSync(configDir, { recursive: true, mode: 0o700 });
for (const [name, content] of [
  ["config.json", `${JSON.stringify({ url, token: phonecallToken }, null, 2)}\n`],
  ["token", phonecallToken],
]) {
  writeFileSync(join(configDir, name), content, { mode: 0o600 });
  chmodSync(join(configDir, name), 0o600);
}

console.log(`
Done. phonecall is live at ${url} (provider: ${provider})

CLI config: ~/.config/phonecall/config.json
MCP token:  ~/.config/phonecall/token
${provider === "xai" ? `
Try a simulated call (nobody is dialed):
  phonecall call --simulate "You run the counter at a busy pizza place." \\
    --brief "Order a large pepperoni for pickup at 7pm." --watch` : provider === "openai" ? `
Try a test call:
  phonecall call +1XXXXXXXXXX --watch \\
    --brief "Book a table for 2 at 7pm tonight."` : `
Try a test call:
  phonecall call +1XXXXXXXXXX --watch \\
    --brief "Book a table for 2 at 7pm tonight."

Deepgram is doing the listening and the talking. The brain:
  - managed OpenAI (default): nothing else to set
  - your own endpoint: set DEEPGRAM_THINK_ENDPOINT_URL / DEEPGRAM_THINK_MODEL / DEEPGRAM_THINK_API_KEY
    (e.g. Groq's free tier, OpenRouter, or a tunnel to your local Ollama — see README)
  - summaries after the call: reuses the think endpoint, or OPENAI_API_KEY as fallback;
    set DEEPGRAM_SUMMARY_MODEL to override`}
`);
