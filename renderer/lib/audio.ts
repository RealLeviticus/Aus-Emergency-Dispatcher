/**
 * Console audio cues, synthesised with the Web Audio API so no asset files are
 * needed in the packaged app. Muted state persists in localStorage.
 */

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

const MUTE_KEY = 'aed.audio.muted';

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * One soft tone. `t` is an offset (seconds) from now. Triangle wave through a
 * gentle low-pass with slow attack/release so nothing is piercing.
 */
function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain = 0.06,
  type: OscillatorType = 'triangle',
): void {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(2200, freq * 2.2);
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ac.currentTime + start;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.04);
  g.gain.setValueAtTime(gain, t0 + Math.max(0.05, dur - 0.12));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(lp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function play(fn: (ac: AudioContext) => void): void {
  if (isMuted()) return;
  const ac = audioCtx();
  if (ac) fn(ac);
}

/** Gentle rising two-note chime for a new job on the board. */
export function playNewCall(): void {
  play((ac) => {
    tone(ac, 523.25, 0, 0.22, 0.055); // C5
    tone(ac, 659.25, 0.16, 0.4, 0.05); // E5
  });
}

/** Slightly brighter three-note figure for a P1 — noticeable, still soft. */
export function playPriorityCall(): void {
  play((ac) => {
    tone(ac, 587.33, 0, 0.18, 0.06); // D5
    tone(ac, 739.99, 0.16, 0.18, 0.06); // F#5
    tone(ac, 880.0, 0.32, 0.45, 0.055); // A5
  });
}

/** Short confirmation blip when a job is claimed / started. */
export function playAccept(): void {
  play((ac) => {
    tone(ac, 523.25, 0, 0.1, 0.045);
    tone(ac, 783.99, 0.09, 0.16, 0.045);
  });
}

/** Soft descending pair when a job is closed. */
export function playComplete(): void {
  play((ac) => {
    tone(ac, 659.25, 0, 0.14, 0.045);
    tone(ac, 440.0, 0.13, 0.26, 0.045);
  });
}

/** Let a user gesture unlock audio (browsers block until first interaction). */
export function primeAudio(): void {
  audioCtx();
}
