#!/usr/bin/env node
// phonecall: place phone calls with a Grok voice agent and answer its questions while it talks.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";

const HELP = `phonecall: have a voice agent make a phone call for you

  phonecall call <+number> --brief "<what to get done>"   start a call, print its job id
  phonecall ui                                          interactive menu: pick a provider, make a call, watch it, reply
  phonecall watch <job>                                  wait for the next question or the end of the call
  phonecall reply <job> <question-id> "<answer>"         answer a question while the call is live
  phonecall report <job>                                 summary, questions and transcript (JSON)
  phonecall transcript <job>                             transcript as plain text
  phonecall list                                         recent calls
  phonecall hangup <job>                                 end a call now

call options
  --brief <text> | --brief-file <path>   goal, facts it may share, limits, what counts as done
  --for <name>             who the call is for (default: the server's PRINCIPAL_NAME)
  --as <name>              name the caller gives (default: Sam)
  --voice <id>             voice for the provider in use (xai: eve, ara, rex, sal, leo; openai: marin, cedar, …; google: Kore, Puck, Charon, …; deepgram: flux-kit-en, …)
  --max-minutes <n>        hard limit on call length (default 10)
  --answer-timeout <sec>   how long the caller waits for a reply to a question (default 60)
  --simulate <persona>     test call: a second AI plays the person you're calling; nobody is dialed (xai only)
  --provider <name>        which voice provider runs the call: xai (default), openai, deepgram or google
  --watch                  start watching right away

Running bare phonecall with no arguments opens the interactive menu (same as "phonecall ui") when stdout is a terminal.

watch prints live progress to stderr and exits with one JSON line on stdout:
  {"type":"input_request","job_id":…,"question_id":"q1","question":"…"}  reply, then watch again
  {"type":"done","job_id":…,"report":{…}}                                  the call is over

Config: PHONECALL_URL and PHONECALL_TOKEN, or ~/.config/phonecall/config.json {"url","token"}.`;

function config() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".config/phonecall/config.json"), "utf8"));
  } catch {}
  const url = process.env.PHONECALL_URL ?? file.url;
  const token = process.env.PHONECALL_TOKEN ?? file.token;
  if (!url || !token) fail("phonecall is not configured: set PHONECALL_URL and PHONECALL_TOKEN or write ~/.config/phonecall/config.json");
  return { url: url.replace(/\/$/, ""), token };
}

function fail(message) {
  console.error(`phonecall: ${message}`);
  process.exit(1);
}

async function api(method, path, body) {
  const { url, token } = config();
  const res = await fetch(url + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) fail(data.error ?? `HTTP ${res.status}`);
  return data;
}

const out = (obj) => console.log(JSON.stringify(obj));
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function describe(e) {
  const d = e.data;
  switch (e.type) {
    case "status":
      return `· ${d.status}${d.reason ? ` (${d.reason})` : ""}${d.to ? ` ${d.to}` : ""}`;
    case "said":
      return `${d.who === "agent" ? "agent" : " them"}: ${d.text}`;
    case "input_request":
      return `? ${d.id}: ${d.question}`;
    case "answer":
      return `↳ ${d.id}: ${d.answer}${d.late ? " (late)" : ""}`;
    case "input_timeout":
      return `! ${d.id} timed out without an answer`;
    case "dtmf":
      return `# pressed ${JSON.stringify(d)}`;
    case "end_call":
      return `· agent hung up: ${d.outcome}${d.notes ? ` (${d.notes})` : ""}`;
    case "error":
      return `! ${d.message}`;
    default:
      return null;
  }
}

async function watch(jobId, verbose) {
  let after = 0;
  for (;;) {
    const r = await api("GET", `/jobs/${jobId}/watch?after=${after}&timeout=25`);
    for (const e of r.events) {
      const line = e.type === "debug" ? (verbose ? `  debug ${JSON.stringify(e.data)}` : null) : describe(e);
      if (line) console.error(`${time(e.at)} ${line}`);
    }
    after = r.cursor;
    if (r.pending.length) {
      const q = r.pending[0];
      return out({ type: "input_request", job_id: jobId, question_id: q.id, question: q.question, more_pending: r.pending.length - 1 });
    }
    if (r.status === "done") return out({ type: "done", job_id: jobId, report: r.report });
  }
}

// ---------- interactive terminal UI (phonecall ui) ----------
const color = process.stdout.isTTY ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_code, s) => s;
const dim = (s) => color(2, s);
const bold = (s) => color(1, s);
const cyan = (s) => color(36, s);
const green = (s) => color(32, s);

async function menu(rl, title, items) {
  console.error(`\n${bold(title)}`);
  items.forEach((item, i) => console.error(`  ${cyan(String(i + 1))}  ${item}`));
  console.error(`  ${dim("0  back")}`);
  for (;;) {
    const raw = (await rl.question(cyan("> "))).trim();
    const n = Number(raw);
    if (raw === "0" || raw === "") return null;
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    console.error(dim("  enter a number from the list (0 to go back)"));
  }
}

async function askJob(rl, message = "Job id") {
  let def = "";
  try {
    const recent = await api("GET", "/jobs?limit=1");
    if (Array.isArray(recent) && recent[0]) def = recent[0].id;
  } catch {}
  const job = (await rl.question(`${message}${def ? dim(` (enter for ${def})`) : ""}: `)).trim() || def;
  return job || null;
}

const PROVIDERS = [
  { label: "google  — Gemini Live API, free tier", value: "google" },
  { label: "deepgram — Flux STT/TTS + your own LLM (BYO endpoint/local model)", value: "deepgram" },
  { label: "openai  — GPT Realtime (your OpenAI key)", value: "openai" },
  { label: "xai     — Grok Voice (default)", value: "xai" },
  { label: "server default — whatever VOICE_PROVIDER is set to", value: undefined },
];

async function uiCall(rl) {
  const pick = await menu(rl, "Which provider runs the call?", PROVIDERS.map((p) => p.label));
  if (pick === null) return;
  const provider = PROVIDERS[pick].value;

  let to, simulatePersona;
  if (provider === "xai") {
    const s = (await rl.question("Simulate a test call (a second AI plays the other side; nobody is dialed)? [y/N] ")).trim().toLowerCase();
    if (s === "y") {
      simulatePersona = (await rl.question("Persona for the other side (e.g. the counter at a busy pizza place): ")).trim();
    }
  }
  if (!simulatePersona) {
    to = (await rl.question("Number to call (E.164, like +14155550100): ")).trim();
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      console.error(dim("  not E.164 — cancelled"));
      return;
    }
  }
  const brief = (await rl.question(`Brief — the goal, facts it may share, limits, what counts as done:\n${cyan("> ")}`)).trim();
  if (!brief) {
    console.error(dim("  empty brief — cancelled"));
    return;
  }
  const forWhom = (await rl.question("Who is the call for? (enter to use the server default): ")).trim();
  const minutesRaw = (await rl.question("Hard limit on minutes? (enter=10): ")).trim();
  console.error(dim("  dialing…"));
  let r;
  try {
    r = await api("POST", "/jobs", {
      to,
      brief,
      principal: forWhom || undefined,
      max_minutes: minutesRaw ? Number(minutesRaw) : undefined,
      simulate: simulatePersona,
      provider,
    });
  } catch (err) {
    console.error(dim("  could not start the call (see the error above)."));
    return;
  }
  console.error(`${green("✓")} started ${r.job_id}`);
  out({ job_id: r.job_id, next: `phonecall watch ${r.job_id}` });
  const go = (await rl.question("Watch it now? [Y/n] ")).trim().toLowerCase();
  if (go !== "n") await watch(r.job_id, false);
}

async function uiWatch(rl) {
  const job = await askJob(rl, "Job to watch");
  if (job) await watch(job, false);
}

async function uiReply(rl) {
  const job = await askJob(rl, "Job id");
  if (!job) return;
  let r;
  try {
    r = await api("GET", `/jobs/${job}`);
  } catch {
    console.error(dim("  unknown job"));
    return;
  }
  const pending = (r.questions ?? []).filter((q) => q.status === "pending");
  if (!pending.length) {
    console.error(dim("  no pending questions right now"));
    return;
  }
  pending.forEach((q, i) => console.error(`  ${cyan(String(i + 1))}  ${q.question}`));
  const raw = (await rl.question(cyan("> "))).trim();
  const idx = Number(raw);
  if (!Number.isInteger(idx) || idx < 1 || idx > pending.length) {
    console.error(dim("  cancelled"));
    return;
  }
  const answer = (await rl.question(`Your answer to "${pending[idx - 1].question}":\n${cyan("> ")}`)).trim();
  if (!answer) {
    console.error(dim("  empty answer — cancelled"));
    return;
  }
  out(await api("POST", `/jobs/${job}/reply`, { question_id: pending[idx - 1].id, answer }));
}

async function uiReport(rl) {
  const job = await askJob(rl, "Job id");
  if (!job) return;
  let r;
  try {
    r = await api("GET", `/jobs/${job}`);
  } catch {
    console.error(dim("  unknown job"));
    return;
  }
  const { job: j, questions, transcript } = r;
  if (j?.report) {
    console.error(`\n${bold("Outcome:")} ${j.report.outcome}`);
    console.error(`${bold("Summary:")} ${j.report.summary}`);
    for (const [k, v] of Object.entries(j.report.details ?? {})) console.error(`  ${k}: ${v}`);
    for (const c of j.report.commitments ?? []) console.error(`  commitment: ${c}`);
    for (const f of j.report.follow_ups ?? []) console.error(`  follow-up: ${f}`);
  } else {
    console.error(`${bold("Status:")} ${j?.status ?? "?"} — no report yet (call not finished)`);
  }
  if (questions?.length) {
    console.error(`\n${bold("Questions")}`);
    for (const q of questions) console.error(`  ${q.id} [${q.status}] ${q.question}${q.answer ? `\n      → ${q.answer}` : ""}`);
  }
  if (transcript?.length) {
    console.error(`\n${bold("Transcript")}`);
    for (const t of transcript) console.error(`  [${time(t.at)}] ${t.who === "agent" ? j.agentName ?? "agent" : "Them"}: ${t.text}`);
  }
}

async function uiList() {
  for (const j of await api("GET", "/jobs?limit=10")) {
    console.log(`${j.id}  ${new Date(j.created_at).toLocaleString()}  ${j.status.padEnd(9)} ${j.to}  ${j.brief.split("\n")[0].slice(0, 60)}`);
  }
}

async function uiHangup(rl) {
  const job = await askJob(rl, "Job to hang up");
  if (job) out(await api("POST", `/jobs/${job}/hangup`));
}

async function ui() {
  if (!process.stdout.isTTY) fail("phonecall ui needs a terminal (stdout is not a TTY)");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.error(`\n${bold("phonecall")} ${dim("— place a phone call from your terminal")}`);
  try {
    for (;;) {
      const pick = await menu(rl, "What would you like to do?", [
        "make a call",
        "watch a live call",
        "answer a pending question (reply)",
        "report / transcript",
        "recent calls",
        "hang up a call",
      ]);
      if (pick === null) break;
      if (pick === 0) await uiCall(rl);
      else if (pick === 1) await uiWatch(rl);
      else if (pick === 2) await uiReply(rl);
      else if (pick === 3) await uiReport(rl);
      else if (pick === 4) await uiList();
      else if (pick === 5) await uiHangup(rl);
    }
  } catch (err) {
    // stdin closed mid-question (Ctrl-D or piped input ran out): leave quietly, don't crash.
    if (err?.code !== "ABORT_ERR") throw err;
  } finally {
    rl.close();
    console.error(dim("bye.\n"));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const { values: opt, positionals: pos } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    brief: { type: "string" },
    "brief-file": { type: "string" },
    for: { type: "string" },
    as: { type: "string" },
    voice: { type: "string" },
    "max-minutes": { type: "string" },
    "answer-timeout": { type: "string" },
    simulate: { type: "string" },
    provider: { type: "string" },
    watch: { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
    limit: { type: "string" },
  },
});

switch (cmd) {
  case "call": {
    const brief = opt["brief-file"] ? readFileSync(opt["brief-file"], "utf8") : opt.brief;
    if (!brief) fail("--brief or --brief-file is required");
    if (!pos[0] && !opt.simulate) fail("give the number to call, like +14155550100");
    const r = await api("POST", "/jobs", {
      to: pos[0],
      brief,
      principal: opt.for,
      agent_name: opt.as,
      voice: opt.voice,
      max_minutes: opt["max-minutes"] ? Number(opt["max-minutes"]) : undefined,
      answer_timeout: opt["answer-timeout"] ? Number(opt["answer-timeout"]) : undefined,
      simulate: opt.simulate,
      provider: opt.provider,
    });
    if (opt.watch) {
      console.error(`job ${r.job_id}`);
      await watch(r.job_id, opt.verbose);
    } else out({ job_id: r.job_id, next: `phonecall watch ${r.job_id}` });
    break;
  }
  case "ui":
    await ui();
    break;
  case "watch":
    if (!pos[0]) fail("usage: phonecall watch <job>");
    await watch(pos[0], opt.verbose);
    break;
  case "reply":
    if (pos.length < 3) fail('usage: phonecall reply <job> <question-id> "<answer>"');
    out(await api("POST", `/jobs/${pos[0]}/reply`, { question_id: pos[1], answer: pos.slice(2).join(" ") }));
    break;
  case "report":
    if (!pos[0]) fail("usage: phonecall report <job>");
    console.log(JSON.stringify(await api("GET", `/jobs/${pos[0]}`), null, 2));
    break;
  case "transcript": {
    if (!pos[0]) fail("usage: phonecall transcript <job>");
    const r = await api("GET", `/jobs/${pos[0]}`);
    for (const t of r.transcript) console.log(`[${time(t.at)}] ${t.who === "agent" ? r.job.agentName : "Them"}: ${t.text}`);
    break;
  }
  case "list":
    for (const j of await api("GET", `/jobs?limit=${opt.limit ?? 20}`)) console.log(`${j.id}  ${new Date(j.created_at).toLocaleString()}  ${j.status.padEnd(9)} ${j.to}  ${j.brief.split("\n")[0].slice(0, 60)}`);
    break;
  case "hangup":
    if (!pos[0]) fail("usage: phonecall hangup <job>");
    out(await api("POST", `/jobs/${pos[0]}/hangup`));
    break;
  default:
    if (!cmd && process.stdout.isTTY) {
      await ui();
      break;
    }
    console.log(HELP);
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}
