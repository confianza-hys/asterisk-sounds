/**
 * System-instruction builder used by every TTS call in the sound-pack
 * generator.
 *
 * Why this prompt is short:
 *
 * The 3.1 Flash TTS preview ships an over-eager prompt classifier
 * that rejects long, scene-y "Audio Profile + Scene + Director's
 * Notes + Sample Context" preambles with `PROHIBITED_CONTENT`, even
 * on trivially benign transcripts like "Agente desconectado." (we hit
 * this in v1 of this file). The official limitations doc warns about
 * exactly this footgun:
 *
 *   "Vague instructions may not trigger the speech-synthesis
 *    classifier, leading to a rejected request (PROHIBITED_CONTENT)
 *    or causing the model to read your style instructions aloud.
 *    Validate your prompt by adding a clear preamble telling the
 *    model to synthesize speech, and explicitly labelling where the
 *    spoken transcript actually starts."
 *
 * The shape below mirrors the prompt that works in AI Studio for the
 * same model: a one-line "Read the following transcript..." preamble
 * (added in `gemini-tts.ts`), a tiny `# Audio Profile` block, a tiny
 * `# Director's note` block, then `## Transcript:` immediately before
 * the line to read.
 *
 * The `Pronunciation` line is critical for the digits/* prompts:
 * Spanish words that are ALSO valid English words (e.g. `once` =
 * Spanish for "eleven", but also English for "one time") are read in
 * English by default — the model heard "once" and pronounced it
 * /wʌns/ instead of /'on.se/. The explicit "never English" rule plus
 * a couple of worked examples fixes it without us having to tag
 * every individual digit in the catalog.
 */

export const SOUND_PACK_SYSTEM_PROMPT = `# Audio Profile
Mexicana, profesional, voz de IVR de centro de atención telefónica.

# Director's note
Style: Neutral, claro, ligero "vocal smile". Slight falling intonation at the end of every line, so the clip works mid-sentence too. No filler words, no breaths.
Pace: Natural, pausada. Same tempo on every line.
Accent: Neutral Mexican Spanish from Mexico City. Yeísmo. No regional slang.
Pronunciation: Every word in the transcript is Mexican Spanish, even single-word lines. NEVER pronounce a word as English just because it shares the same spelling. Examples: "once" → /'on.se/ (eleven, not /wʌns/), "no" → /no/ (not /noʊ/), "es" → /es/, "as" → /as/, "ve" → /be/, "de" → /de/, "se" → /se/. Numbers are always read as Spanish numerals.`;

/** Convenience wrapper used by build.ts. */
export function buildSystemInstruction(): string {
  return SOUND_PACK_SYSTEM_PROMPT;
}
