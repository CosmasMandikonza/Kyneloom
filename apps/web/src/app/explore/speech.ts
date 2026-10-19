/**
 * KYN-11 accessible narration — BROWSER speech synthesis only, honestly
 * labeled. This is the device's local SpeechSynthesis engine (when
 * present), NOT the Azure audio/narration pipeline (that belongs to a
 * later milestone and is disclosed as unavailable in the UI).
 *
 * Feature detection is explicit; every operation is defensive; the
 * controller cancels cleanly on teardown so no voice outlives the panel.
 */

export interface SpeechController {
  /** True only when the browser exposes a working speechSynthesis engine. */
  readonly supported: boolean;
  /** Speak text (cancels anything in flight). Resolves when done/failed. */
  speak(text: string): void;
  /** Stop any current utterance immediately. */
  stop(): void;
  /** Re-speak the most recent text at the current rate. */
  repeat(): void;
  /** Pause/resume the current utterance, if the engine supports it. */
  pause(): void;
  resume(): void;
  /** Speaking rate multiplier (0.5–2). */
  setRate(rate: number): void;
  readonly rate: number;
  /** Teardown: cancel everything. Call on unmount/lens exit. */
  destroy(): void;
}

export function createSpeechController(global: {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
}): SpeechController {
  const synth = global.speechSynthesis;
  const Ctor = global.SpeechSynthesisUtterance;
  const supported = synth !== undefined && Ctor !== undefined;
  let rate = 1;
  let lastText: string | null = null;

  const utter = (text: string): void => {
    if (!supported || text.trim() === '') return;
    synth.cancel();
    const message = new Ctor(text);
    message.rate = rate;
    synth.speak(message);
  };

  return {
    supported,
    speak(text) {
      lastText = text;
      utter(text);
    },
    stop() {
      if (supported) synth.cancel();
    },
    repeat() {
      if (lastText !== null) utter(lastText);
    },
    pause() {
      if (supported && synth.speaking) synth.pause();
    },
    resume() {
      if (supported && synth.paused) synth.resume();
    },
    setRate(next) {
      rate = Math.min(2, Math.max(0.5, Number.isFinite(next) ? next : 1));
    },
    get rate() {
      return rate;
    },
    destroy() {
      if (supported) synth.cancel();
    },
  };
}
