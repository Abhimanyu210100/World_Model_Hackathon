// All sound is synthesised with WebAudio, so the game has no audio assets.

let ctx: AudioContext;
let master: GainNode;

export function initAudio() {
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  ambience();
}

function noiseBuffer(seconds: number) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function ambience() {
  // Detuned low drone.
  const drone = ctx.createGain();
  drone.gain.value = 0.07;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 220;
  for (const f of [43.6, 44.1, 65.4]) {
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    o.connect(lp);
    o.start();
  }
  lp.connect(drone).connect(master);

  // Wind: band-passed noise with a slow wandering centre frequency.
  const wind = ctx.createBufferSource();
  wind.buffer = noiseBuffer(4);
  wind.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 3;
  bp.frequency.value = 400;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 250;
  lfo.connect(lfoGain).connect(bp.frequency);
  lfo.start();
  const wg = ctx.createGain();
  wg.gain.value = 0.05;
  wind.connect(bp).connect(wg).connect(master);
  wind.start();
}

export function heartbeat() {
  const t = ctx.currentTime;
  for (const [dt, f] of [[0, 60], [0.22, 52]] as const) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(f, t + dt);
    o.frequency.exponentialRampToValueAtTime(30, t + dt + 0.15);
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.5, t + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.18);
    o.connect(g).connect(master);
    o.start(t + dt);
    o.stop(t + dt + 0.2);
  }
}

export function scream() {
  const t = ctx.currentTime;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / curve.length) * 2 - 1;
    curve[i] = Math.tanh(x * 6);
  }
  shaper.curve = curve;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(1.2, t + 0.03);
  out.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
  shaper.connect(out).connect(master);

  // Shrieking glissando cluster.
  for (const base of [740, 1046, 1480]) {
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(base * 0.7, t);
    o.frequency.exponentialRampToValueAtTime(base * 1.3, t + 0.25);
    o.frequency.exponentialRampToValueAtTime(base * 0.5, t + 1.2);
    const vib = ctx.createOscillator();
    vib.frequency.value = 23;
    const vg = ctx.createGain();
    vg.gain.value = base * 0.04;
    vib.connect(vg).connect(o.frequency);
    vib.start(t);
    o.connect(shaper);
    o.start(t);
    o.stop(t + 1.3);
    vib.stop(t + 1.3);
  }
  // Noise burst for the impact.
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(1);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.8, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  n.connect(ng).connect(shaper);
  n.start(t);
}

export function creak() {
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(90, t);
  o.frequency.linearRampToValueAtTime(140, t + 0.6);
  o.frequency.linearRampToValueAtTime(70, t + 1.4);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 900;
  bp.Q.value = 8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.4, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
  o.connect(bp).connect(g).connect(master);
  o.start(t);
  o.stop(t + 1.5);
}

export function chime() {
  const t = ctx.currentTime;
  for (const [f, dt] of [[1318, 0], [1975, 0.08]] as const) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.3, t + dt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 1.2);
    o.connect(g).connect(master);
    o.start(t + dt);
    o.stop(t + dt + 1.3);
  }
}

export function whisperSting() {
  const t = ctx.currentTime;
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(2);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 3000;
  const pan = ctx.createStereoPanner();
  pan.pan.setValueAtTime(Math.random() < 0.5 ? -1 : 1, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
  n.connect(hp).connect(g).connect(pan).connect(master);
  n.start(t);
}

// ---------- Gemini TTS voice clips (public/voice, see scripts/voice.mjs)

const clips = new Map<string, AudioBuffer>();
let voiceBus: GainNode;
let bedBus: GainNode;
let currentVoice: AudioBufferSourceNode | null = null;
let activeBeds: { names: string; stop: () => void } | null = null;

export async function loadVoices() {
  voiceBus = ctx.createGain();
  voiceBus.gain.value = 1.4;
  voiceBus.connect(master);

  // Beds sound like they come from inside the walls: muffled and quiet.
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 1800;
  bedBus = ctx.createGain();
  bedBus.gain.value = 0.35;
  bedBus.connect(lp).connect(master);

  let manifest: Record<string, string>;
  try {
    const r = await fetch("/voice/manifest.json");
    if (!r.ok) return;
    manifest = await r.json();
  } catch {
    return;
  }
  await Promise.all(
    Object.entries(manifest).map(async ([id, file]) => {
      try {
        const data = await (await fetch(`/voice/${file}`)).arrayBuffer();
        clips.set(id, await ctx.decodeAudioData(data));
      } catch (e) {
        console.warn("[voice] could not load", file, e);
      }
    }),
  );
}

export const hasClip = (id: string) => clips.has(id);

/** Plays a narrated clip, cutting off any previous line and ducking the beds. */
export function speak(id: string) {
  const buf = clips.get(id);
  if (!buf) return;
  currentVoice?.stop();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(voiceBus);
  const t = ctx.currentTime;
  bedBus.gain.setTargetAtTime(0.12, t, 0.2);
  src.onended = () => {
    if (currentVoice === src) {
      currentVoice = null;
      bedBus.gain.setTargetAtTime(0.35, ctx.currentTime, 0.6);
    }
  };
  src.start();
  currentVoice = src;
}

/** Plays a clip on top of everything (scare stingers). */
export function sting(id: string) {
  const buf = clips.get(id);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 2.2;
  src.connect(g).connect(master);
  src.start();
}

/** Crossfades to a set of looping ambience beds, each panned to its own side. */
export function setBeds(ids: string[]) {
  const key = ids.join(",");
  if (activeBeds?.names === key) return;
  activeBeds?.stop();
  const t = ctx.currentTime;
  const nodes = ids
    .filter((id) => clips.has(id))
    .map((id, i, all) => {
      const src = ctx.createBufferSource();
      src.buffer = clips.get(id)!;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 2.5);
      const pan = ctx.createStereoPanner();
      pan.pan.value = all.length > 1 ? (i % 2 ? 0.7 : -0.7) : Math.random() * 1.2 - 0.6;
      src.connect(g).connect(pan).connect(bedBus);
      // Random offset so loops don't always start the same way.
      src.start(t, Math.random() * src.buffer.duration);
      return { src, g };
    });
  activeBeds = {
    names: key,
    stop: () => {
      const now = ctx.currentTime;
      for (const { src, g } of nodes) {
        g.gain.setTargetAtTime(0.0001, now, 0.5);
        src.stop(now + 3);
      }
    },
  };
}

/** Seconds into a clip where it first gets close to its loudest. */
function onsetOf(buf: AudioBuffer) {
  const d = buf.getChannelData(0);
  const win = Math.floor(buf.sampleRate / 50);
  const rms: number[] = [];
  for (let i = 0; i < d.length; i += win) {
    let s = 0;
    for (let j = i; j < Math.min(d.length, i + win); j++) s += d[j] * d[j];
    rms.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...rms);
  const first = rms.findIndex((v) => v > peak * 0.45);
  return Math.max(0, first - 2) * (win / buf.sampleRate);
}

/** The jump-scare hit: Gemini shriek (from its peak, distorted) + synth scream + sub-bass impact. */
export function scareHit(shriekId: string) {
  const t = ctx.currentTime;
  scream();

  // Sub-bass impact you feel more than hear.
  const boom = ctx.createOscillator();
  boom.frequency.setValueAtTime(110, t);
  boom.frequency.exponentialRampToValueAtTime(28, t + 0.7);
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(1.6, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  boom.connect(bg).connect(master);
  boom.start(t);
  boom.stop(t + 1.2);

  const buf = clips.get(shriekId);
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.9; // a touch lower: less human
  const drive = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / curve.length) * 2 - 1) * 4);
  drive.curve = curve;
  const g = ctx.createGain();
  const len = 2.4;
  g.gain.setValueAtTime(2.4, t);
  g.gain.setValueAtTime(2.4, t + len - 0.4);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(drive).connect(g).connect(master);
  src.start(t, onsetOf(buf), len);
}

/** Silences the room beds (pre-scare hush); setBeds() brings them back. */
export function hushBeds() {
  currentVoice?.stop();
  currentVoice = null;
  activeBeds?.stop();
  activeBeds = null;
}
