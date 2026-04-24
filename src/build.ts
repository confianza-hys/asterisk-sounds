/**
 * Builds the Confianza HYS "core-sounds-es-MX" pack for Asterisk —
 * one tarball-set per Gemini voice when SOUND_PACK_VOICE=all.
 *
 * Per-voice pipeline:
 *   1. Generate every TTS prompt in `catalog.ts` via Gemini 3.1 Flash
 *      TTS (preview), using the shared "CDMX IVR" director's notes
 *      from `prompt.ts`. Output is the model's native PCM-16 WAV
 *      (24 kHz mono).
 *   2. Cache each WAV under  `dist/sound-pack/<voice>/wav/<path>.wav`.
 *      Re-runs skip files that already exist AND validate as RIFF/WAVE
 *      so the build is resumable + idempotent — partial failures only
 *      cost the missing files.
 *   3. Pull the official `core-sounds-es-ulaw` tarball once and copy
 *      the language-neutral binaries listed in `passthrough.ts`
 *      (silences, beeps, monkeys) into the wav/ tree, transcoding
 *      them from mu-law to PCM-16 WAV via ffmpeg so the rest of the
 *      pipeline treats them identically.
 *   4. Transcode every WAV to all the codec subpacks Asterisk ships
 *      (ulaw, alaw, gsm, g722, sln16, wav). Each codec gets its own
 *      output directory so the resulting tarballs match the layout of
 *      `asterisk-core-sounds-es-<codec>-current.tar.gz` byte-for-byte
 *      (sans the actual byte content, obviously).
 *   5. Pack each codec tree into
 *      `asterisk-confianza-sounds-es-mx-<voice>-<codec>-<version>.tar.gz`,
 *      ready to be uploaded as a GitHub Release asset and referenced
 *      from the Asterisk Dockerfile via `ADD <url>`.
 *
 * Token usage and dollar cost are accumulated across every voice and
 * printed once at the end of the run.
 *
 * Concurrency: Gemini calls are parallelised at MAX_TTS_CONCURRENCY
 * (defaults to 30). ffmpeg invocations are parallelised at
 * MAX_FFMPEG_CONCURRENCY (defaults to 16).
 *
 * Run:  `npm run sound-pack:build`           (single voice — default Kore)
 *       `SOUND_PACK_VOICE=all npm run sound-pack:build`  (all 30)
 *
 * Required env: GEMINI_API_KEY  (loaded from .env via tsx --env-file).
 *
 * Optional env:
 *   SOUND_PACK_VOICE     -- single voice name OR "all" to iterate
 *                           every prebuilt voice (default: Kore)
 *   SOUND_PACK_VERSION   -- semver string baked into tarball names
 *                           (default: 1.0.0)
 *   SOUND_PACK_CODECS    -- comma-separated subset of
 *                           ulaw,alaw,gsm,g722,sln16,wav
 *                           (default: all of them)
 *   PRICE_INPUT_PER_M    -- USD per 1M input tokens (default 1)
 *   PRICE_OUTPUT_PER_M   -- USD per 1M output tokens (default 20)
 *   GEMINI_TTS_MODEL     -- model override (default: 3.1 preview)
 *   MAX_TTS_CONCURRENCY  -- default 30
 *   MAX_FFMPEG_CONCURRENCY -- default 16
 */

import { mkdir, writeFile, access, rm, stat, open, unlink } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import archiver from 'archiver';
import pLimit from 'p-limit';
import ffmpegStaticImport from 'ffmpeg-static';

import { generateSpeechNative, type TtsUsage } from './gemini-tts.js';
import { CATALOG, type CatalogItem } from './catalog.js';
import { PASSTHROUGH_FILES } from './passthrough.js';
import { buildSystemInstruction } from './prompt.js';

// ─────────────────────────── configuration ──────────────────────────────

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT_DIR = join(ROOT, 'dist', 'sound-pack');
const UPSTREAM_DIR = join(OUT_DIR, '.upstream');
const UPSTREAM_TARBALL = join(UPSTREAM_DIR, 'core-sounds-es-ulaw.tar.gz');
const UPSTREAM_URL =
  'https://downloads.asterisk.org/pub/telephony/sounds/asterisk-core-sounds-es-ulaw-current.tar.gz';

const VERSION = process.env.SOUND_PACK_VERSION || '1.0.0';
const PACK_NAME = 'asterisk-confianza-sounds-es-mx';
// Tier-2 / paid project Gemini 3.1 Flash TTS quota is 1,000 RPM and
// 1,000,000 input TPM with unlimited daily requests. Each TTS call
// takes ~3 seconds wall-clock, so 80 in-flight requests sustain
// ~26 req/sec ≈ 1,560 req/min — comfortably above the cap; the
// per-item retry/backoff absorbs any 429s that bubble up.
const TTS_CONCURRENCY = Number(process.env.MAX_TTS_CONCURRENCY ?? 80);
const FFMPEG_CONCURRENCY = Number(process.env.MAX_FFMPEG_CONCURRENCY ?? 16);

const PRICE_INPUT_PER_M = Number(process.env.PRICE_INPUT_PER_M ?? 1);
const PRICE_OUTPUT_PER_M = Number(process.env.PRICE_OUTPUT_PER_M ?? 20);

/**
 * Every prebuilt voice exposed by gemini-3.1-flash-tts-preview, as
 * listed in the official "Voice options" table of the Gemini TTS
 * docs. Order matches the docs so the build progress log reads
 * top-to-bottom of the table.
 */
const ALL_VOICES = [
  'Zephyr',     'Puck',         'Charon',
  'Kore',       'Fenrir',       'Leda',
  'Orus',       'Aoede',        'Callirrhoe',
  'Autonoe',    'Enceladus',    'Iapetus',
  'Umbriel',    'Algieba',      'Despina',
  'Erinome',    'Algenib',      'Rasalgethi',
  'Laomedeia',  'Achernar',     'Alnilam',
  'Schedar',    'Gacrux',       'Pulcherrima',
  'Achird',     'Zubenelgenubi', 'Vindemiatrix',
  'Sadachbia',  'Sadaltager',   'Sulafat',
] as const;

/**
 * Voices to actually generate this run. `SOUND_PACK_VOICE=all`
 * expands to every entry in `ALL_VOICES`; anything else is treated
 * as a single voice name (default: Kore — same as the previous
 * default and as voice-otp.ts).
 */
const VOICES_TO_BUILD: string[] = (() => {
  const v = process.env.SOUND_PACK_VOICE || 'Kore';
  if (v.toLowerCase() === 'all') return [...ALL_VOICES];
  return [v];
})();

const ALL_CODECS = ['ulaw', 'alaw', 'gsm', 'g722', 'sln16', 'wav'] as const;
type Codec = (typeof ALL_CODECS)[number];

/**
 * Showcase prompt rendered once per voice and dropped under
 * `dist/sound-pack/samples/<voice>.wav`. The README embeds these
 * with `<audio controls>` tags so anyone reading the repo on
 * github.com can A/B every voice in the browser before downloading
 * a tarball. Designed to exercise:
 *
 *   - common IVR opening
 *   - the digits/once bug we tracked down (eleven, must NOT sound
 *     like English "wuns")
 *   - day-of-week + month + numeric date + time-of-day
 *   - the "marque uno / dos / tres" enumeration
 *   - polite closing
 */
const SAMPLE_TEXT =
  'Bienvenido al sistema de citas de Confianza HYS. ' +
  'Su próxima cita es el lunes once de marzo a las nueve y media de la mañana. ' +
  'Para confirmar, marque uno. Para reagendar, marque dos. ' +
  'Para cancelar, marque tres. Gracias por su preferencia.';

/**
 * Short label used in the README next to each voice. Mirrors the
 * descriptors published in the official Gemini TTS docs.
 */
const VOICE_DESCRIPTIONS: Record<string, string> = {
  Zephyr: 'Bright', Puck: 'Upbeat', Charon: 'Informative',
  Kore: 'Firm', Fenrir: 'Excitable', Leda: 'Youthful',
  Orus: 'Firm', Aoede: 'Breezy', Callirrhoe: 'Easy-going',
  Autonoe: 'Bright', Enceladus: 'Breathy', Iapetus: 'Clear',
  Umbriel: 'Easy-going', Algieba: 'Smooth', Despina: 'Smooth',
  Erinome: 'Clear', Algenib: 'Gravelly', Rasalgethi: 'Informative',
  Laomedeia: 'Upbeat', Achernar: 'Soft', Alnilam: 'Firm',
  Schedar: 'Even', Gacrux: 'Mature', Pulcherrima: 'Forward',
  Achird: 'Friendly', Zubenelgenubi: 'Casual', Vindemiatrix: 'Gentle',
  Sadachbia: 'Lively', Sadaltager: 'Knowledgeable', Sulafat: 'Warm',
};

const REQUESTED_CODECS: Codec[] = (process.env.SOUND_PACK_CODECS
  ? process.env.SOUND_PACK_CODECS.split(',').map((s) => s.trim())
  : [...ALL_CODECS]
).filter((c): c is Codec => (ALL_CODECS as readonly string[]).includes(c));

const FFMPEG_BIN = (ffmpegStaticImport as unknown as string) || '';
if (!FFMPEG_BIN || !existsSync(FFMPEG_BIN)) {
  throw new Error(
    `ffmpeg-static binary not found (got "${FFMPEG_BIN}"). Reinstall the package.`,
  );
}

// ─────────────────────────── shared state ───────────────────────────────

/**
 * Aggregated usage across EVERY voice processed in this run. Lets us
 * print one consolidated invoice at the end of `main()` instead of
 * one per voice (which gets noisy with 30 voices).
 */
const totals: TtsUsage & { calls: number; cachedHits: number } = {
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  calls: 0,
  cachedHits: 0,
};

interface VoiceFailure {
  voice: string;
  path: string;
  lastError: string;
}
const ttsFailures: VoiceFailure[] = [];

// ─────────────────────────── helpers ────────────────────────────────────

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valid-cache check for an intermediate WAV: file must exist, contain
 * a sane RIFF/WAVE header, declare 16 bits/sample and a sane sample
 * rate (8 kHz to 48 kHz). Catches:
 *
 *   - half-written files left behind by a Ctrl+C during writeFile
 *   - the bitsPerSample=0 / blockAlign=0 corruption from the buggy
 *     WAV header builder shipped in the very first run of the pack
 *     (VLC reported "unidentified codec" on those files)
 *
 * Anything that doesn't pass is treated as missing and regenerated.
 */
async function isValidWav(p: string): Promise<boolean> {
  try {
    const fh = await open(p, 'r');
    try {
      const header = Buffer.alloc(44);
      const { bytesRead } = await fh.read(header, 0, 44, 0);
      if (bytesRead < 44) return false;
      if (header.toString('ascii', 0, 4) !== 'RIFF') return false;
      if (header.toString('ascii', 8, 12) !== 'WAVE') return false;
      const channels = header.readUInt16LE(22);
      const rate = header.readUInt32LE(24);
      const bits = header.readUInt16LE(34);
      return (
        channels >= 1 && channels <= 2 &&
        rate >= 8000 && rate <= 48000 &&
        bits === 16
      );
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
    child.on('error', rejectP);
  });
}

/**
 * ffmpeg argument matrix for every Asterisk codec we ship. Frequencies
 * and sample formats here mirror what `asterisk-core-sounds-*` ships
 * upstream so the tarballs are interchangeable.
 */
function ffmpegArgsFor(codec: Codec, src: string, dst: string): string[] {
  switch (codec) {
    case 'ulaw':
      return ['-y', '-i', src, '-ar', '8000', '-ac', '1', '-f', 'mulaw', dst];
    case 'alaw':
      return ['-y', '-i', src, '-ar', '8000', '-ac', '1', '-f', 'alaw', dst];
    case 'gsm':
      return ['-y', '-i', src, '-ar', '8000', '-ac', '1', '-c:a', 'gsm', '-f', 'gsm', dst];
    case 'g722':
      return [
        '-y', '-i', src, '-ar', '16000', '-ac', '1',
        '-c:a', 'g722', '-f', 'g722', dst,
      ];
    case 'sln16':
      return [
        '-y', '-i', src, '-ar', '16000', '-ac', '1',
        '-c:a', 'pcm_s16le', '-f', 's16le', dst,
      ];
    case 'wav':
      return [
        '-y', '-i', src, '-ar', '8000', '-ac', '1',
        '-c:a', 'pcm_s16le', '-f', 'wav', dst,
      ];
  }
}

function codecExtension(codec: Codec): string {
  switch (codec) {
    case 'sln16':
      return 'sln16';
    case 'wav':
      return 'wav';
    default:
      return codec;
  }
}

// ─────────────────────────── upstream ───────────────────────────────────

async function downloadUpstreamIfNeeded(): Promise<void> {
  await ensureDir(UPSTREAM_DIR);
  // Sentinel: a known passthrough file. We check for an extracted
  // file (not just the tarball) because the user might have wiped
  // the extracted tree manually while keeping the .tar.gz to skip
  // the slow re-download. Without this, the build runs to
  // completion silently producing tarballs that are missing the 18
  // passthrough files (silences, beeps, dir-welcome, ...).
  const sentinel = join(UPSTREAM_DIR, 'beep.ulaw');
  if (await fileExists(sentinel)) return;
  if (!(await fileExists(UPSTREAM_TARBALL))) {
    console.log('[sound-pack] Downloading upstream pack for tone passthrough…');
    execSync(`curl.exe -sSL -o "${UPSTREAM_TARBALL}" "${UPSTREAM_URL}"`, {
      stdio: 'inherit',
    });
  }
  console.log('[sound-pack] Extracting upstream pack…');
  execSync(`tar -xzf "${UPSTREAM_TARBALL}" -C "${UPSTREAM_DIR}"`, {
    stdio: 'inherit',
  });
}

// ─────────────────────────── per-voice pipeline ─────────────────────────

interface VoicePaths {
  voice: string;
  voiceDir: string;
  wavDir: string;
}

function pathsFor(voice: string): VoicePaths {
  const voiceDir = join(OUT_DIR, voice);
  return { voice, voiceDir, wavDir: join(voiceDir, 'wav') };
}

async function generateOne(item: CatalogItem, paths: VoicePaths): Promise<void> {
  if (!item.text) return;
  const wavPath = join(paths.wavDir, `${item.path}.wav`);
  if (await isValidWav(wavPath)) {
    totals.cachedHits++;
    return;
  }
  if (await fileExists(wavPath)) {
    try { await unlink(wavPath); } catch {}
  }
  await ensureDir(dirname(wavPath));

  const transcript = item.tag ? `${item.tag} ${item.text}` : item.text;
  const { wav, usage } = await generateSpeechNative({
    text: transcript,
    voiceName: paths.voice,
    systemInstruction: buildSystemInstruction(),
  });
  await writeFile(wavPath, wav);
  totals.calls++;
  totals.promptTokens += usage.promptTokens;
  totals.outputTokens += usage.outputTokens;
  totals.totalTokens += usage.totalTokens;
}

/**
 * Last-ditch generation path for items that the prompt classifier
 * keeps rejecting with PROHIBITED_CONTENT. Drops the long director's-
 * notes preamble entirely and uses a plain, classifier-friendly
 * "Read aloud" wrapper plus a Mexican-Spanish style hint.
 *
 * Rescues short single-word prompts (phonetic alphabet entries like
 * "Nancy" / "Víctor", spy-h323's raw "h 323") where the model treats
 * a one-word transcript after a structured director's-notes block
 * as suspicious.
 */
async function generateOneFallback(item: CatalogItem, paths: VoicePaths): Promise<void> {
  const wavPath = join(paths.wavDir, `${item.path}.wav`);
  if (await fileExists(wavPath)) {
    try { await unlink(wavPath); } catch {}
  }
  await ensureDir(dirname(wavPath));

  const transcript = item.tag ? `${item.tag} ${item.text}` : item.text;
  const { wav, usage } = await generateSpeechNative({
    text: transcript,
    voiceName: paths.voice,
    style:
      'Speak in neutral Mexican Spanish with a calm, professional IVR tone. ' +
      'Slight falling intonation at the end so the clip works mid-sentence',
  });
  await writeFile(wavPath, wav);
  totals.calls++;
  totals.promptTokens += usage.promptTokens;
  totals.outputTokens += usage.outputTokens;
  totals.totalTokens += usage.totalTokens;
}

async function generateAllTtsForVoice(paths: VoicePaths): Promise<void> {
  await ensureDir(paths.wavDir);
  const limit = pLimit(TTS_CONCURRENCY);
  const items = CATALOG.filter((i) => i.text);
  let done = 0;
  await Promise.all(
    items.map((item) =>
      limit(async () => {
        const max = 4;
        let lastError = '';
        for (let attempt = 1; attempt <= max; attempt++) {
          try {
            await generateOne(item, paths);
            done++;
            if (done % 50 === 0 || done === items.length) {
              console.log(`[${paths.voice}] TTS ${done}/${items.length}`);
            }
            return;
          } catch (err: unknown) {
            lastError = (err as Error)?.message ?? String(err);
            if (attempt === max) break;
            const backoff = 500 * 2 ** (attempt - 1);
            console.warn(
              `[${paths.voice}] retry ${attempt}/${max - 1} ${item.path}: ${lastError} (sleeping ${backoff}ms)`,
            );
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
        if (lastError.includes('PROHIBITED_CONTENT')) {
          try {
            console.warn(`[${paths.voice}] fallback ${item.path}: dropping system prompt`);
            await generateOneFallback(item, paths);
            done++;
            return;
          } catch (err: unknown) {
            lastError = (err as Error)?.message ?? String(err);
          }
        }
        ttsFailures.push({ voice: paths.voice, path: item.path, lastError });
        console.error(`[${paths.voice}] FAILED ${item.path}: ${lastError}`);
      }),
    ),
  );
}

async function copyPassthroughs(paths: VoicePaths): Promise<void> {
  const limit = pLimit(FFMPEG_CONCURRENCY);
  await Promise.all(
    PASSTHROUGH_FILES.map((rel) =>
      limit(async () => {
        const src = join(UPSTREAM_DIR, `${rel}.ulaw`);
        const dst = join(paths.wavDir, `${rel}.wav`);
        if (await isValidWav(dst)) return;
        if (!(await fileExists(src))) {
          console.warn(`[${paths.voice}] passthrough source missing: ${src}`);
          return;
        }
        await ensureDir(dirname(dst));
        await runFfmpeg([
          '-y', '-f', 'mulaw', '-ar', '8000', '-ac', '1',
          '-i', src,
          '-c:a', 'pcm_s16le', '-f', 'wav', dst,
        ]);
      }),
    ),
  );
}

async function transcodeAllForVoice(paths: VoicePaths): Promise<void> {
  const limit = pLimit(FFMPEG_CONCURRENCY);
  for (const codec of REQUESTED_CODECS) {
    const codecRoot = join(paths.voiceDir, codec);
    await ensureDir(codecRoot);
    const ext = codecExtension(codec);
    const items = [
      ...CATALOG.filter((i) => i.text).map((i) => i.path),
      ...PASSTHROUGH_FILES,
    ];
    let done = 0;
    await Promise.all(
      items.map((rel) =>
        limit(async () => {
          const src = join(paths.wavDir, `${rel}.wav`);
          const dst = join(codecRoot, `${rel}.${ext}`);
          if (!(await fileExists(src))) return;
          if (await fileExists(dst)) {
            done++;
            return;
          }
          await ensureDir(dirname(dst));
          await runFfmpeg(ffmpegArgsFor(codec, src, dst));
          done++;
        }),
      ),
    );
    console.log(`[${paths.voice}] ${codec}  ${done}/${items.length} transcoded`);
  }
}

async function writeMetadataFiles(paths: VoicePaths): Promise<void> {
  const changes =
    `# CHANGES — ${PACK_NAME}-${paths.voice}-${VERSION}\n\n` +
    `Drop-in replacement for asterisk-core-sounds-es using neutral\n` +
    `Mexican Spanish (CDMX) generated with Gemini 3.1 Flash TTS.\n` +
    `Voice: ${paths.voice}.\n\n` +
    `Same filenames and directory layout as asterisk-core-sounds-es-1.6.1.\n`;
  const credits =
    `# CREDITS — ${PACK_NAME}-${paths.voice}-${VERSION}\n\n` +
    `Voice synthesis: Google Gemini 3.1 Flash TTS (preview), voice "${paths.voice}".\n` +
    `Catalog & build: Confianza HYS <https://github.com/confianza-hys/asterisk-sounds>.\n` +
    `Tone files (beep, ascending-2tone, descending-2tone, beeperr,\n` +
    `tt-monkeys, silence/*) are taken verbatim from\n` +
    `asterisk-core-sounds-es-1.6.1, licensed under CC-BY-SA-3.0 by\n` +
    `Digium, Inc. and contributors.\n`;
  const license =
    `# LICENSE\n\n` +
    `Generated audio © ${new Date().getFullYear()} Confianza HYS. Released\n` +
    `under the Creative Commons Attribution-ShareAlike 4.0 International\n` +
    `License (CC-BY-SA-4.0). See https://creativecommons.org/licenses/by-sa/4.0/\n`;
  const manifest =
    `; Core Asterisk Sounds in Mexican Spanish — ${PACK_NAME}-${paths.voice}-${VERSION}\n` +
    `; Generated with Gemini 3.1 Flash TTS, voice="${paths.voice}"\n\n` +
    CATALOG.filter((i) => i.text)
      .map((i) => `${i.path}: ${i.text}`)
      .join('\n') +
    '\n';
  await writeFile(
    join(paths.voiceDir, `CHANGES-${PACK_NAME}-${paths.voice}-${VERSION}`),
    changes,
  );
  await writeFile(
    join(paths.voiceDir, `CREDITS-${PACK_NAME}-${paths.voice}-${VERSION}`),
    credits,
  );
  await writeFile(
    join(paths.voiceDir, `LICENSE-${PACK_NAME}-${paths.voice}-${VERSION}`),
    license,
  );
  await writeFile(join(paths.voiceDir, `core-sounds-es-mx.txt`), manifest);
}

async function packTarball(paths: VoicePaths, codec: Codec): Promise<void> {
  const codecRoot = join(paths.voiceDir, codec);
  if (!existsSync(codecRoot)) return;
  const tarballPath = join(
    OUT_DIR,
    `${PACK_NAME}-${paths.voice}-${codec}-${VERSION}.tar.gz`,
  );
  await rm(tarballPath, { force: true });

  await new Promise<void>((resolveP, rejectP) => {
    const out = createWriteStream(tarballPath);
    const arch = archiver('tar', { gzip: true });
    out.on('close', () => resolveP());
    arch.on('warning', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`[${paths.voice}] tar warning:`, err);
      } else {
        rejectP(err);
      }
    });
    arch.on('error', rejectP);
    arch.pipe(out);
    arch.directory(codecRoot, false);
    for (const meta of [
      `CHANGES-${PACK_NAME}-${paths.voice}-${VERSION}`,
      `CREDITS-${PACK_NAME}-${paths.voice}-${VERSION}`,
      `LICENSE-${PACK_NAME}-${paths.voice}-${VERSION}`,
      'core-sounds-es-mx.txt',
    ]) {
      const p = join(paths.voiceDir, meta);
      if (existsSync(p)) arch.file(p, { name: meta });
    }
    arch.finalize();
  });

  const s = await stat(tarballPath);
  console.log(
    `[${paths.voice}] packed ${codec} → ${(s.size / 1_048_576).toFixed(2)} MiB`,
  );
}

/**
 * Generates the README showcase clip for one voice. Stored under
 * `dist/sound-pack/samples/<voice>.wav` as a small 8 kHz mono PCM
 * WAV (~150 KB each) so the whole "30 voices" gallery weighs
 * ~5 MB, which renders fine on github.com.
 *
 * 8 kHz on purpose: callers will hear the pack transcoded down to
 * 8 kHz mu-law/a-law over a phone line anyway, so the sample
 * matches reality. If you want HD samples for a website, override
 * SAMPLE_RATE_HZ via env.
 */
async function generateSample(paths: VoicePaths): Promise<void> {
  const samplesDir = join(OUT_DIR, 'samples');
  await ensureDir(samplesDir);
  const dst = join(samplesDir, `${paths.voice}.wav`);
  if (await isValidWav(dst)) return;

  const { wav, usage } = await generateSpeechNative({
    text: SAMPLE_TEXT,
    voiceName: paths.voice,
    systemInstruction: buildSystemInstruction(),
  });
  totals.calls++;
  totals.promptTokens += usage.promptTokens;
  totals.outputTokens += usage.outputTokens;
  totals.totalTokens += usage.totalTokens;

  // Write the native 24 kHz WAV to a temp path then transcode to
  // 8 kHz mono PCM via ffmpeg so the README sample matches the
  // codec quality callers will actually hear over PSTN.
  const native = join(samplesDir, `.${paths.voice}.native.wav`);
  await writeFile(native, wav);
  await runFfmpeg(['-y', '-i', native, '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', dst]);
  try { await unlink(native); } catch {}
  console.log(`[${paths.voice}] sample → ${dst}`);
}

async function buildOneVoice(voice: string): Promise<void> {
  const paths = pathsFor(voice);
  console.log(`\n──── voice: ${voice} ────`);
  await generateAllTtsForVoice(paths);
  await copyPassthroughs(paths);
  await transcodeAllForVoice(paths);
  await writeMetadataFiles(paths);
  for (const codec of REQUESTED_CODECS) {
    await packTarball(paths, codec);
  }
  await generateSample(paths);
}

// ─────────────────────────── reporting ──────────────────────────────────

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(5)}`;
}

function printUsageReport(): void {
  const inputCost = (totals.promptTokens / 1_000_000) * PRICE_INPUT_PER_M;
  const outputCost = (totals.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  const total = inputCost + outputCost;
  const expectedCalls = VOICES_TO_BUILD.length * CATALOG.filter((i) => i.text).length;

  const lines = [
    '',
    '─────────── usage & cost (Gemini TTS) ───────────',
    `model:           ${process.env.GEMINI_TTS_MODEL ?? 'gemini-3.1-flash-tts-preview'}`,
    `voices built:    ${VOICES_TO_BUILD.length}  (${VOICES_TO_BUILD.join(', ')})`,
    `prompts/voice:   ${CATALOG.filter((i) => i.text).length}`,
    `expected calls:  ${fmtNumber(expectedCalls)}`,
    `prompts cached:  ${fmtNumber(totals.cachedHits)}  (skipped — already on disk)`,
    `prompts called:  ${fmtNumber(totals.calls)}  (newly generated this run)`,
    '',
    `input tokens:    ${fmtNumber(totals.promptTokens).padStart(12)}    @ $${PRICE_INPUT_PER_M}/M  =  ${fmtCost(inputCost)}`,
    `output tokens:   ${fmtNumber(totals.outputTokens).padStart(12)}    @ $${PRICE_OUTPUT_PER_M}/M  =  ${fmtCost(outputCost)}`,
    `total tokens:    ${fmtNumber(totals.totalTokens).padStart(12)}`,
    '',
    `estimated cost:  ${fmtCost(total)}`,
    '─────────────────────────────────────────────────',
  ];
  console.log(lines.join('\n'));
}

// ─────────────────────────── main ───────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[sound-pack] ${PACK_NAME} v${VERSION}`);
  console.log(`[sound-pack] voices=${VOICES_TO_BUILD.join(',')}`);
  console.log(`[sound-pack] codecs=${REQUESTED_CODECS.join(',')}`);
  console.log(`[sound-pack] output=${OUT_DIR}`);
  console.log(
    `[sound-pack] estimated cost @ $${PRICE_INPUT_PER_M}/M input, ` +
    `$${PRICE_OUTPUT_PER_M}/M output\n`,
  );

  await ensureDir(OUT_DIR);
  await downloadUpstreamIfNeeded();

  for (const voice of VOICES_TO_BUILD) {
    await buildOneVoice(voice);
  }

  console.log('\n[sound-pack] done.');
  printUsageReport();

  if (ttsFailures.length > 0) {
    console.log(`\n${ttsFailures.length} prompt(s) could not be generated:`);
    const byVoice = new Map<string, VoiceFailure[]>();
    for (const f of ttsFailures) {
      const arr = byVoice.get(f.voice) ?? [];
      arr.push(f);
      byVoice.set(f.voice, arr);
    }
    for (const [voice, items] of byVoice) {
      console.log(`  [${voice}]  ${items.length} failure(s):`);
      for (const it of items) {
        console.log(`     - ${it.path}  (${it.lastError})`);
      }
    }
    console.log('\nRe-run the script to retry only these — successful files are cached.');
  }

  console.log('\nUpload these tarballs as GitHub Release assets:\n');
  const tarballs = await import('node:fs').then((fs) =>
    fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.tar.gz')).sort(),
  );
  for (const f of tarballs) console.log(`  ${join(OUT_DIR, f)}`);

  await writeReadme();
  console.log(`\nREADME.md written to ${join(OUT_DIR, 'README.md')}`);
  console.log('Commit `samples/`, `README.md`, `LICENSE`, and the catalog files to');
  console.log('https://github.com/confianza-hys/asterisk-sounds, then attach the');
  console.log('tarballs above as assets to the v' + VERSION + ' Release.');

  process.exit(ttsFailures.length === 0 ? 0 : 1);
}

// ─────────────────────────── README generator ───────────────────────────

/**
 * Writes the public-facing README at `dist/sound-pack/README.md`.
 * Embeds an `<audio controls>` widget per voice (GitHub renders
 * these inline in markdown since 2022) so anyone visiting the repo
 * can A/B every voice without downloading anything. Keeps the
 * download instructions and catalog stats in one place.
 */
async function writeReadme(): Promise<void> {
  const releaseBase =
    `https://github.com/confianza-hys/asterisk-sounds/releases/download/v${VERSION}`;

  const sampleSections = VOICES_TO_BUILD
    .map((voice) => {
      const desc = VOICE_DESCRIPTIONS[voice] ?? '';
      const downloads = REQUESTED_CODECS
        .map((codec) => {
          const name = `${PACK_NAME}-${voice}-${codec}-${VERSION}.tar.gz`;
          return `[${codec}](${releaseBase}/${name})`;
        })
        .join(' · ');
      return [
        `### ${voice}${desc ? ` _— ${desc}_` : ''}`,
        '',
        `<audio controls preload="none" src="samples/${voice}.wav"></audio>`,
        '',
        `**Download v${VERSION}:** ${downloads}`,
        '',
      ].join('\n');
    })
    .join('\n');

  const promptCount = CATALOG.filter((i) => i.text).length;
  const totalFiles = promptCount + PASSTHROUGH_FILES.length;

  const readme = `# Confianza HYS — Asterisk Sounds (es-MX)

Drop-in replacement for the official \`asterisk-core-sounds-es\` pack,
voiced in **neutral Mexican Spanish (CDMX register)** by Google's
Gemini 3.1 Flash TTS instead of the upstream Allison Smith English-
accented recordings.

- ✅ Same filenames and directory layout as \`asterisk-core-sounds-es-1.6.1\`
- ✅ Same six codecs (\`ulaw\`, \`alaw\`, \`gsm\`, \`g722\`, \`sln16\`, \`wav\`)
- ✅ ${totalFiles} files per pack (${promptCount} TTS prompts + ${PASSTHROUGH_FILES.length} upstream tones/silences)
- ✅ ${VOICES_TO_BUILD.length} different voices to choose from
- ✅ \`SayDigits\`, \`SayNumber\`, \`SayDate\`, \`vm-*\`, \`queue-*\` work unchanged

## 🎧 Pick your voice

Each clip below is the same script in every available voice. Listen,
pick the one you like, and download the matching codec tarball below.

> _"Bienvenido al sistema de citas de Confianza HYS. Su próxima cita
> es el lunes once de marzo a las nueve y media de la mañana. Para
> confirmar, marque uno. Para reagendar, marque dos. Para cancelar,
> marque tres. Gracias por su preferencia."_

${sampleSections}

## Installation

In your Asterisk Dockerfile, after \`make install && make samples\`:

\`\`\`dockerfile
ARG CONFIANZA_VOICE=Kore
ARG CONFIANZA_VERSION=${VERSION}
RUN set -eux; \\
  mkdir -p /var/lib/asterisk/sounds/es; \\
  for codec in ulaw alaw; do \\
    url="https://github.com/confianza-hys/asterisk-sounds/releases/download/v\${CONFIANZA_VERSION}/${PACK_NAME}-\${CONFIANZA_VOICE}-\${codec}-\${CONFIANZA_VERSION}.tar.gz"; \\
    wget -q -O "/tmp/\${codec}.tar.gz" "\$url"; \\
    tar -xzf "/tmp/\${codec}.tar.gz" -C /var/lib/asterisk/sounds/es; \\
    rm -f "/tmp/\${codec}.tar.gz"; \\
  done
\`\`\`

Then just use the standard playback URIs — nothing else changes:

\`\`\`
exten => s,1,Playback(vm-intro)
exten => s,n,SayNumber(${promptCount})
exten => s,n,SayDate(\${EPOCH})
\`\`\`

## How the pack is built

The catalog (\`scripts/catalog.ts\`) lists every prompt with its
Spanish-MX text. \`scripts/build.ts\` runs each entry through
Gemini 3.1 Flash TTS using the director's-notes preamble in
\`scripts/prompt.ts\`, transcodes the resulting 24 kHz mono WAVs
through ffmpeg into all six Asterisk codecs, and packs each codec
tree as a tarball with the same layout as the upstream pack.

To rebuild from scratch:

\`\`\`bash
export GEMINI_API_KEY=...           # from aistudio.google.com
npm install
npm run sound-pack:build            # default: voice=Kore
SOUND_PACK_VOICE=all npm run sound-pack:build   # all ${ALL_VOICES.length} voices
\`\`\`

The build is resumable — already-generated WAVs are validated by RIFF
header and skipped on re-runs.

## License

Generated audio © ${new Date().getFullYear()} Confianza HYS. Released
under [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The bundled tone files (\`beep\`, \`ascending-2tone\`, \`tt-monkeys\`,
\`silence/*\`) are taken verbatim from \`asterisk-core-sounds-es-1.6.1\`,
licensed under CC-BY-SA-3.0 by Digium, Inc. and contributors.
`;

  await writeFile(join(OUT_DIR, 'README.md'), readme);
}

main().catch((err) => {
  console.error('[sound-pack] fatal:', err);
  printUsageReport();
  process.exit(1);
});
