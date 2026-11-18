import { test } from "node:test";
import assert from "node:assert/strict";
import { mulawToPcm16, pcm16ToMulaw, pcm16ToBytes, bytesToPcm16, Downsampler3x1 } from "../src/audio.ts";

test("mulaw decode: known reference points", () => {
  assert.equal(mulawToPcm16(new Uint8Array([0xff]))[0], 0); // +0
  assert.equal(mulawToPcm16(new Uint8Array([0x7f]))[0], 0); // −0
  assert.equal(mulawToPcm16(new Uint8Array([0x80]))[0], 32124); // max positive
  assert.equal(mulawToPcm16(new Uint8Array([0x00]))[0], -32124); // max negative
});

test("mulaw encode/decode roundtrip stays within quantization error", () => {
  const pcm = new Int16Array([0, 1000, 5000, 10000, -500, -100, 32000, -32000]);
  const dec = mulawToPcm16(pcm16ToMulaw(pcm));
  for (let i = 0; i < pcm.length; i++) {
    const clipped = Math.max(-8159, Math.min(8159, pcm[i])); // G.711 is a 14-bit codec
    assert.ok(Math.abs(dec[i] - clipped) <= 400, `sample ${i}: ${pcm[i]} -> ${dec[i]}`);
  }
});

test("mulaw encode is monotonic in the positive direction", () => {
  const samples = new Int16Array(100).map((_, i) => i * 300);
  const enc = pcm16ToMulaw(samples);
  for (let i = 1; i < enc.length; i++) {
    assert.ok(enc[i] <= enc[i - 1], `code must increase (or stay) as amplitude grows (inverted scale) at i=${i}`);
  }
});

test("PCM16 <-> bytes roundtrip, little-endian", () => {
  const pcm = new Int16Array([0x0102, -2, 32767, -32768]);
  const bytes = pcm16ToBytes(pcm);
  assert.deepEqual([...bytes], [0x02, 0x01, 0xfe, 0xff, 0xff, 0x7f, 0x00, 0x80]);
  assert.deepEqual([...bytesToPcm16(bytes)], [...pcm]);
});

test("Downsampler3x1: 24kHz -> 8kHz with carry across calls", () => {
  const d = new Downsampler3x1();
  const input = new Int16Array(24).map((_, i) => i * 100);
  const out = d.process(input);
  assert.equal(out.length, 8);
  assert.equal(out[0], Math.round((0 + 100 + 200) / 3));
  assert.equal(out[7], Math.round((2100 + 2200 + 2300) / 3));

  const carried = new Downsampler3x1();
  const a = carried.process(new Int16Array(5).fill(100));
  const b = carried.process(new Int16Array(4).fill(200));
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
});
