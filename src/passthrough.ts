/**
 * Files that ship in the official `core-sounds-es` pack but are NOT
 * TTS — pure DTMF tones, beeps, monkey screams, or N seconds of
 * silence. We copy them verbatim from the upstream tarball into our
 * own pack so the result is a complete drop-in replacement.
 *
 * The build script downloads
 * `asterisk-core-sounds-es-ulaw-current.tar.gz` once, extracts these
 * files (already in mu-law @ 8 kHz), and re-encodes them to every
 * other target codec via ffmpeg. Tones are language-neutral so this
 * is safe.
 */

export const PASSTHROUGH_FILES: string[] = [
  // Pure DTMF / signalling tones.
  'ascending-2tone',
  'descending-2tone',
  'beep',
  'beeperr',
  'confbridge-join',

  // Sound-effect Easter egg shipped in the upstream pack — kept for
  // 100% drop-in compatibility with dialplans that play `tt-monkeys`.
  'tt-monkeys',

  // Empty/silent placeholders shipped in the upstream pack with no
  // associated text in core-sounds-es.txt. Copied byte-for-byte so
  // dialplans that play them keep working (they're typically used
  // as a tail or spacer in directory IVRs).
  'dir-usingkeypad',
  'dir-welcome',

  // N-second silences used by Wait/Playback in dialplans.
  'silence/1',
  'silence/2',
  'silence/3',
  'silence/4',
  'silence/5',
  'silence/6',
  'silence/7',
  'silence/8',
  'silence/9',
  'silence/10',
];
