// Phone audio is mulaw/8kHz; Gemini Live wants raw 16-bit PCM (little-endian):
// 16kHz in, 24kHz out. These codecs run inside the Durable Object, no dependencies.

// ---- mulaw decode (G.711) ----
const MULAW_DECODE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80 ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    t[i] = sign * ((((mantissa << 3) + 0x84) << exponent) - 0x84);
  }
  return t;
})();

export function mulawToPcm16(input: Uint8Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = MULAW_DECODE[input[i]];
  return out;
}

// ---- mulaw encode (G.711) ----
const BIAS = 0x84;
const CLIP = 8159; // canonical 14-bit clip
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

export function pcm16ToMulaw(input: Int16Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let sample = input[i];
    let sign = 0;
    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let s = 0; s < 8; s++) {
      if (sample <= SEG_END[s]) {
        exponent = s;
        break;
      }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

// ---- 24kHz -> 8kHz downsampler with a 3-tap boxcar pre-filter ----
// Carries leftover samples between calls (server chunks don't align to 3).
export class Downsampler3x1 {
  private tail = new Int16Array(0);

  process(input: Int16Array): Int16Array {
    const merged = new Int16Array(this.tail.length + input.length);
    merged.set(this.tail);
    merged.set(input, this.tail.length);
    const n = Math.floor(merged.length / 3);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = Math.round((merged[i * 3] + merged[i * 3 + 1] + merged[i * 3 + 2]) / 3);
    }
    this.tail = merged.slice(n * 3);
    return out;
  }
}

// ---- byte helpers (little-endian 16-bit) ----
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = samples[i] & 0xff;
    out[i * 2 + 1] = (samples[i] >> 8) & 0xff;
  }
  return out;
}

export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16 >> 16;
  return out;
}
