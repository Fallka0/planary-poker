/**
 * The table's sounds, generated live — no audio files.
 *
 * This is the Overprint engine the slot machines use, carried over with the
 * poker cues the handoff specifies. It stays a plain module on `window`
 * rather than a React hook because the mute setting is shared across every
 * Planary game through the same localStorage key: turn the sound off at the
 * slots and the poker table is quiet too.
 *
 * Browsers will not start an audio context until the player has done
 * something, so `unlock()` is called on the first click or key press and
 * every cue before that is dropped on the floor.
 */

type Cue = (t: number, o?: Options) => void;

export interface Options {
  delay?: number;
  n?: number;
  dur?: number;
  step?: number;
  v?: number;
}

export interface AudioEngine {
  unlock(): void;
  play(name: string, options?: Options): void;
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  subscribe(fn: (muted: boolean) => void): () => void;
}

const STORAGE_KEY = "overprint-muted";

declare global {
  interface Window {
    OPAudio?: AudioEngine;
  }
}

function build(): AudioEngine {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let muted = false;
  try {
    muted = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Storage blocked: start unmuted, and the setting lasts this page view.
  }
  const subs = new Set<(muted: boolean) => void>();

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.6;
    master.connect(comp);
    comp.connect(ctx.destination);
    const len = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /** MIDI note number to hertz. */
  const N = (n: number) => 440 * 2 ** ((n - 69) / 12);

  function env(g: GainNode, t: number, attack: number, peak: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(type: OscillatorType, f: number, t: number, a: number, peak: number, dec: number, f2?: number) {
    if (!ctx || !master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + a + dec);
    env(g, t, a, peak, dec);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + a + dec + 0.05);
  }

  function noise(t: number, dur: number, type: BiquadFilterType, f: number, q: number, peak: number, f2?: number, a?: number) {
    if (!ctx || !master || !noiseBuf) return;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    fl.Q.value = q;
    const g = ctx.createGain();
    env(g, t, a ?? 0.003, peak, dur);
    s.connect(fl);
    fl.connect(g);
    g.connect(master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.06);
  }

  function synth(notes: number[], t: number, step: number, dur: number, peak?: number, cutoff?: number, type?: OscillatorType) {
    if (!ctx || !master) return;
    notes.forEach((n, i) => {
      const at = t + i * step;
      for (const detune of [-6, 6]) {
        const o = ctx!.createOscillator();
        o.type = type ?? "sawtooth";
        o.frequency.value = N(n);
        o.detune.value = detune;
        const f = ctx!.createBiquadFilter();
        f.type = "lowpass";
        f.Q.value = 5;
        f.frequency.setValueAtTime(cutoff ?? 2600, at);
        f.frequency.exponentialRampToValueAtTime(380, at + dur);
        const g = ctx!.createGain();
        env(g, at, 0.01, peak ?? 0.06, dur);
        o.connect(f);
        f.connect(g);
        g.connect(master!);
        o.start(at);
        o.stop(at + dur + 0.1);
      }
    });
  }

  const S: Record<string, Cue> = {
    click: (t) => {
      noise(t, 0.03, "bandpass", 3200, 2, 0.22);
      tone("sine", 880, t, 0.002, 0.06, 0.04);
    },
    coin: (t, o) => {
      const p = 1 + (o?.v ?? Math.random()) * 0.22;
      tone("sine", 2650 * p, t, 0.001, 0.1, 0.18);
      tone("sine", 4120 * p, t, 0.001, 0.06, 0.12);
      tone("sine", 6230 * p, t, 0.001, 0.025, 0.06);
    },
    coins: (t, o) => {
      const n = o?.n ?? 14;
      const dur = o?.dur ?? 1.6;
      const sp = dur / n;
      for (let i = 0; i < n; i++) S.coin(t + i * sp + Math.random() * sp * 0.6, { v: Math.random() });
    },
    win: (t, o) => {
      const k = Math.min(8, o?.step ?? 1);
      const b = 70 + k * 2;
      [0, 4, 7, 12].forEach((s, i) => {
        tone("triangle", N(b + s), t + i * 0.055, 0.004, 0.2, 0.35);
        tone("sine", N(b + s + 12), t + i * 0.055, 0.004, 0.05, 0.25);
      });
    },
    deal: (t) => {
      noise(t, 0.07, "highpass", 2200, 0.8, 0.32, 5200, 0.004);
      noise(t + 0.012, 0.03, "bandpass", 900, 2, 0.14);
    },
    chip: (t, o) => {
      const p = 1 + (o?.v ?? Math.random()) * 0.15;
      [0, 0.045].forEach((d, i) => {
        tone("sine", 1900 * p * (i ? 1.07 : 1), t + d, 0.001, 0.09, 0.07);
        noise(t + d, 0.02, "bandpass", 4200, 3, 0.18);
      });
    },
    chips: (t) => {
      for (let i = 0; i < 6; i++) S.chip(t + i * 0.05 + Math.random() * 0.02, { v: Math.random() });
    },
    check: (t) => {
      [0, 0.11].forEach((d) => {
        tone("sine", 150, t + d, 0.002, 0.45, 0.08, 90);
        noise(t + d, 0.03, "lowpass", 700, 1, 0.3);
      });
    },
    fold: (t) => {
      noise(t, 0.16, "bandpass", 2400, 1.2, 0.22, 700, 0.01);
    },
    shuffle: (t) => {
      for (let i = 0; i < 16; i++) noise(t + i * 0.028, 0.02, "bandpass", 2600 + Math.random() * 1500, 2, 0.2);
    },
    turn: (t) => {
      tone("sine", N(81), t, 0.005, 0.12, 0.35);
      tone("sine", N(88), t + 0.09, 0.005, 0.1, 0.4);
    },
    allin: (t) => {
      synth([57, 64, 69], t, 0, 0.6, 0.05, 2600);
      tone("sine", 55, t, 0.01, 0.45, 0.5);
      S.chips(t);
    },
  };

  return {
    unlock() {
      init();
      if (ctx && ctx.state === "suspended") void ctx.resume();
    },
    play(name, options) {
      if (!ctx || muted || !S[name] || ctx.state !== "running") return;
      try {
        S[name](ctx.currentTime + 0.01 + (options?.delay ?? 0), options);
      } catch {
        // A cue that can't be scheduled is not worth interrupting a hand for.
      }
    },
    isMuted() {
      return muted;
    },
    setMuted(value) {
      muted = Boolean(value);
      try {
        window.localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
      } catch {
        // Storage blocked: the setting lasts this page view.
      }
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.6, ctx.currentTime, 0.02);
      subs.forEach((fn) => fn(muted));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** The one engine for this page. Built on first use, never on the server. */
export function audio(): AudioEngine | null {
  if (typeof window === "undefined") return null;
  if (!window.OPAudio) window.OPAudio = build();
  return window.OPAudio;
}

export function play(name: string, options?: Options) {
  audio()?.play(name, options);
}

export function unlockAudio() {
  audio()?.unlock();
}
