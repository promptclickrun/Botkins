// Whether a recording is worth sending to the computer to be read. Pure (no React Native), so the tests run it.
//
// A speech model given silence or a tap does not answer with nothing: it invents a short word, often
// in another language ("Qué"), and that word would be sent on as what the person said.

/** A recording shorter than this (ms) is a tap, not speech. */
export const MIN_CLIP_MS = 250;
/** A recording's level (0 to 1, from its metering) that counts as speech; a quiet room sits well under it. */
export const CLIP_SPEECH_LEVEL = 0.3;

/** `ms` long, and `peak` the loudest metering level (0 to 1) heard in it. */
export const hasSpeech = (ms: number, peak: number) => ms >= MIN_CLIP_MS && peak >= CLIP_SPEECH_LEVEL;
