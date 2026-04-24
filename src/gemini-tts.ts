import { GoogleGenAI } from '@google/genai';
import { uploadRecording, getPresignedUrl } from './s3.js';

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set');
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

/**
 * Default TTS model. We use Gemini 3.1 Flash TTS (preview), which
 * supports inline audio tags (`[whispers]`, `[serious]`, ...), the
 * advanced "director's notes" prompt structure, and produces noticeably
 * more natural Spanish than the 2.5 preview. Override per-deployment
 * with the `GEMINI_TTS_MODEL` env var if Google retires the preview
 * channel before the GA model lands.
 */
const DEFAULT_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL ?? 'gemini-3.1-flash-tts-preview';

interface TTSRequest {
  text: string;
  voiceName?: string;
  /**
   * Optional natural-language style instruction prepended to the
   * transcript. Kept for backwards compatibility with the old
   * `Read aloud the following text. <style>` shape used by voice-otp.
   * For richer control prefer `systemInstruction` + audio tags inside
   * the `text` itself (Gemini 3.1 syntax).
   */
  style?: string;
  /**
   * Raw system-style preamble passed verbatim before the transcript.
   * Use this to ship the full "Audio Profile / Scene / Director's
   * Notes" block documented in the Gemini 3.1 TTS guide. When set, it
   * fully replaces the default `Read aloud...` directive.
   */
  systemInstruction?: string;
  model?: string;
}

interface WavConversionOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/**
 * Parses the inline-data mimeType returned by Gemini TTS, which looks
 * like one of (depending on the model variant and the SDK version):
 *
 *   audio/L16;codec=pcm;rate=24000
 *   audio/L16;rate=24000
 *   audio/pcm;rate=24000
 *   audio/wav
 *
 * The model always emits 16-bit signed little-endian mono PCM, so any
 * field we can't read from the mimeType falls back to that. Without
 * these defaults the resulting WAV header would carry bitsPerSample=0
 * / blockAlign=0 / byteRate=0 (a known bug in the original Google
 * sample code copy-pasted from AI Studio) and VLC/FFmpeg refuse to
 * play it with "unidentified codec".
 */
function parseMimeType(mimeType: string): WavConversionOptions {
  const [fileType, ...params] = (mimeType || '').split(';').map((s) => s.trim());
  const [, format] = (fileType || '').split('/');

  const options: WavConversionOptions = {
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
  };

  if (format) {
    const upper = format.toUpperCase();
    if (upper.startsWith('L')) {
      const bits = parseInt(upper.slice(1), 10);
      if (!Number.isNaN(bits) && bits > 0) options.bitsPerSample = bits;
    }
  }

  for (const param of params) {
    const [key, value] = param.split('=').map((s) => s.trim());
    const lower = key?.toLowerCase();
    if (lower === 'rate') {
      const r = parseInt(value, 10);
      if (!Number.isNaN(r) && r > 0) options.sampleRate = r;
    } else if (lower === 'channels') {
      const c = parseInt(value, 10);
      if (!Number.isNaN(c) && c > 0) options.numChannels = c;
    } else if (lower === 'bits' || lower === 'bitspersample') {
      const b = parseInt(value, 10);
      if (!Number.isNaN(b) && b > 0) options.bitsPerSample = b;
    }
  }

  return options;
}

function isRiffWave(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  );
}

function createWavHeader(dataLength: number, options: WavConversionOptions): Buffer {
  const { numChannels, sampleRate, bitsPerSample } = options;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

function resample16bit(input: Buffer, fromRate: number, toRate: number): Buffer {
  const ratio = fromRate / toRate;
  const inSamples = input.length / 2;
  const outSamples = Math.floor(inSamples / ratio);
  const output = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = input.readInt16LE(Math.min(idx, inSamples - 1) * 2);
    const s1 = input.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return output;
}

function wrapAsWav(pcmBuffer: Buffer, mimeType: string, targetRate?: number): Buffer {
  // Idempotent: if the API already returned a complete RIFF/WAVE
  // stream (some 2.5 variants do this), pass it through untouched.
  // Wrapping a WAV inside another WAV header would produce the
  // corrupt 0-bps output we hit when this code first shipped.
  if (isRiffWave(pcmBuffer)) return pcmBuffer;
  const options = parseMimeType(mimeType);
  if (!targetRate || targetRate === options.sampleRate) {
    const header = createWavHeader(pcmBuffer.length, options);
    return Buffer.concat([header, pcmBuffer]);
  }
  const resampled = resample16bit(pcmBuffer, options.sampleRate, targetRate);
  const header = createWavHeader(resampled.length, { ...options, sampleRate: targetRate });
  return Buffer.concat([header, resampled]);
}

function buildPrompt(
  text: string,
  style?: string,
  systemInstruction?: string,
): string {
  if (systemInstruction) {
    // Mirror the exact prompt shape that AI Studio emits for the 3.1
    // Flash TTS preview model. The leading "Read the following
    // transcript..." line is what tells the prompt classifier this is
    // a speech-synthesis request — without it the API returns
    // PROHIBITED_CONTENT on perfectly benign IVR phrases like
    // "Agente desconectado".
    return [
      "Read the following transcript based on the audio profile and director's note.",
      '',
      systemInstruction.trim(),
      '',
      '## Transcript:',
      text,
    ].join('\n');
  }
  if (style) return `Read aloud the following text. ${style}:\n\n${text}`;
  return `Read aloud the following text in a warm and natural tone:\n\n${text}`;
}

export interface TtsUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface RawTtsResult {
  data: Buffer;
  mimeType: string;
  usage: TtsUsage;
}

async function callGemini(params: TTSRequest): Promise<RawTtsResult> {
  const prompt = buildPrompt(params.text, params.style, params.systemInstruction);
  const voiceName = params.voiceName || 'Kore';
  const model = params.model || DEFAULT_TTS_MODEL;

  const response = await getAI().models.generateContentStream({
    model,
    config: {
      // Both 'audio' and 'AUDIO' are accepted by the API; we use the
      // canonical uppercase form documented in the Gemini 3.1 guide.
      responseModalities: ['AUDIO'],
      // Mirrors AI Studio's default for the TTS model; explicit so
      // we don't drift if the SDK changes it.
      temperature: 1,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
      },
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const audioChunks: Buffer[] = [];
  let audioMimeType = '';
  // Capture text fallbacks and finish reasons so we can surface a
  // useful error instead of the generic "No audio data" message —
  // e.g. PROHIBITED_CONTENT (false-positive prompt classifier),
  // RECITATION, MAX_TOKENS, or the model just dumping the system
  // prompt back as text (a known 3.1-preview footgun).
  const textChunks: string[] = [];
  let finishReason: string | undefined;
  let promptFeedback: unknown;
  // Usage metadata is only fully populated on the LAST chunk of the
  // stream; intermediate chunks ship partial counts. Track the latest
  // numbers we see and return whatever the model committed at end.
  const usage: TtsUsage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };

  for await (const chunk of response) {
    promptFeedback = (chunk as unknown as { promptFeedback?: unknown }).promptFeedback ?? promptFeedback;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = String(candidate.finishReason);
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        audioMimeType = part.inlineData.mimeType || audioMimeType;
        audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
      } else if (typeof part.text === 'string' && part.text.length > 0) {
        textChunks.push(part.text);
      }
    }
    const meta = (chunk as unknown as { usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      // 3.1 Flash TTS reports audio output under a separate field.
      // When present we treat it as the "output" billable count.
      audioTokenCount?: number;
    } }).usageMetadata;
    if (meta) {
      if (typeof meta.promptTokenCount === 'number') {
        usage.promptTokens = meta.promptTokenCount;
      }
      const out =
        meta.audioTokenCount ?? meta.candidatesTokenCount ?? 0;
      if (typeof out === 'number') usage.outputTokens = out;
      if (typeof meta.totalTokenCount === 'number') {
        usage.totalTokens = meta.totalTokenCount;
      }
    }
  }
  if (usage.totalTokens === 0) {
    usage.totalTokens = usage.promptTokens + usage.outputTokens;
  }

  if (audioChunks.length === 0) {
    const detail: string[] = [`model=${model}`];
    if (finishReason) detail.push(`finishReason=${finishReason}`);
    if (textChunks.length > 0) {
      const preview = textChunks.join(' ').slice(0, 160).replace(/\s+/g, ' ');
      detail.push(`textFallback="${preview}"`);
    }
    if (promptFeedback) {
      try { detail.push(`promptFeedback=${JSON.stringify(promptFeedback)}`); } catch {}
    }
    throw new Error(`No audio data returned from Gemini TTS (${detail.join(', ')})`);
  }

  return { data: Buffer.concat(audioChunks), mimeType: audioMimeType, usage };
}

/**
 * Generates speech and returns a 16-bit mono WAV resampled to 8 kHz.
 * Convenient for code paths that hand the WAV straight to Asterisk
 * (mu-law/a-law channels) without a separate transcoding step.
 *
 * Backwards-compatible with the previous signature used by voice-otp
 * and the blaster engine.
 */
export async function generateSpeech(params: TTSRequest): Promise<Buffer> {
  const { data, mimeType } = await callGemini(params);
  return wrapAsWav(data, mimeType, 8000);
}

/**
 * Generates speech and returns the model's NATIVE PCM-16 WAV (24 kHz
 * for the 3.1 family) without any in-process resampling. Use this when
 * you plan to feed the audio into ffmpeg/sox for higher-quality
 * downsampling and multi-format transcoding (e.g. when building a
 * sound pack distributed as alaw/ulaw/gsm/g722/sln16 tarballs).
 */
export async function generateSpeechNative(
  params: TTSRequest,
): Promise<{ wav: Buffer; sampleRate: number; usage: TtsUsage }> {
  const { data, mimeType, usage } = await callGemini(params);
  const opts = parseMimeType(mimeType);
  const wav = wrapAsWav(data, mimeType);
  return { wav, sampleRate: opts.sampleRate, usage };
}

export async function generateAndUpload(
  params: TTSRequest & { name: string },
): Promise<{ fileUrl: string; duration: number }> {
  const wavBuffer = await generateSpeech(params);

  const headerOffset = 44;
  const pcmLength = Math.max(0, wavBuffer.length - headerOffset);
  const durationSeconds = Math.round(pcmLength / (8000 * 2));

  let fileUrl: string;
  try {
    const key = `blaster-recordings/${Date.now()}-${params.name.replace(/\s+/g, '_')}.wav`;
    await uploadRecording(key, wavBuffer);
    fileUrl = await getPresignedUrl(key, 60 * 60 * 24 * 7);
  } catch (err) {
    console.warn('[GeminiTTS] S3 upload failed, using data URL fallback:', (err as Error).message);
    fileUrl = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
  }

  return { fileUrl, duration: durationSeconds };
}
