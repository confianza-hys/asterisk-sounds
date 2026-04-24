/**
 * One-off diagnostic for the sound-pack TTS pipeline. Helps decide
 * which Gemini TTS model is actually reachable from this API key
 * (the 3.1 preview is rolling out and may not be live for every
 * project) and prints a verbose dump of one full request so we can
 * see finishReason / promptFeedback / textFallback when audio is
 * missing.
 *
 * Run:  `npm run sound-pack:diagnose`
 */

import { GoogleGenAI } from '@google/genai';
import { generateSpeechNative } from './gemini-tts.js';
import { buildSystemInstruction } from './prompt.js';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('GEMINI_API_KEY not set');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: KEY });

async function listModels() {
  console.log('\n=== available models (filtered to *-tts*) ===');
  const pager = await ai.models.list();
  let count = 0;
  for await (const m of pager) {
    const name = (m as { name?: string }).name ?? '?';
    const supports = (m as { supportedActions?: string[] }).supportedActions ?? [];
    if (/tts|speech|audio/i.test(name)) {
      console.log(`  ${name}  [${supports.join(',')}]`);
      count++;
    }
  }
  if (count === 0) console.log('  (no TTS models found in this project)');
}

async function tryModel(
  model: string,
  text: string,
  opts: { useSystemPrompt: boolean },
) {
  console.log(`\n=== model=${model} systemPrompt=${opts.useSystemPrompt} text="${text}" ===`);
  try {
    const { wav, sampleRate } = await generateSpeechNative({
      text,
      voiceName: 'Kore',
      model,
      systemInstruction: opts.useSystemPrompt ? buildSystemInstruction() : undefined,
    });
    console.log(`  OK  ${wav.length} bytes, ${sampleRate} Hz`);
  } catch (err) {
    console.log(`  FAIL  ${(err as Error).message}`);
  }
}

async function main() {
  await listModels();
  // Sanity probes (known-good).
  await tryModel('gemini-2.5-flash-preview-tts', 'Hola, esta es una prueba.', { useSystemPrompt: false });
  await tryModel('gemini-3.1-flash-tts-preview', 'Hola, esta es una prueba.', { useSystemPrompt: false });

  // Regression probes for the strings that reproducibly hit
  // PROHIBITED_CONTENT in earlier runs of the build script.
  await tryModel('gemini-3.1-flash-tts-preview', 'Agente conectado.', { useSystemPrompt: true });
  await tryModel('gemini-3.1-flash-tts-preview', 'Agente desconectado.', { useSystemPrompt: true });
  // A longer transcript so we know the simplified system prompt still
  // produces consistent voice on multi-clause IVR lines.
  await tryModel(
    'gemini-3.1-flash-tts-preview',
    'Por favor ingrese su número de agente seguido por la tecla de almohadilla.',
    { useSystemPrompt: true },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
