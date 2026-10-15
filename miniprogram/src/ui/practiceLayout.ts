import type { SongProfile } from '../../../shared/songTypes';
export function practiceOptions(profile: SongProfile, lane: 'primary' | 'secondary') {
  const parts = profile.vocalParts.filter((part) => part.lane === lane
    && (lane === 'secondary' || part.lyrics.replace(/\s*[（(][^）)]*[）)]/g, '').trim()))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (parts.length) return parts.map((part) => ({ id: part.id,
    label: lane === 'primary' ? part.lyrics.replace(/\s*[（(][^）)]*[）)]/g, '').trim() : part.lyrics.replace(/^[（(]|[）)]$/g, ''),
    startSeconds: lane === 'secondary' ? profile.sentences.find((sentence) => part.sentenceIds.includes(sentence.id))?.startSeconds ?? part.startSeconds : part.startSeconds,
    endSeconds: part.endSeconds, sentenceIds: part.sentenceIds.length ? part.sentenceIds : profile.sentences
      .filter((sentence) => sentence.startSeconds < part.endSeconds && sentence.endSeconds > part.startSeconds).map((sentence) => sentence.id),
    vocalPartId: part.id,
  }));
  return lane === 'secondary' ? [] : profile.sentences.map((sentence) => ({ id: sentence.id, label: sentence.lyrics,
    startSeconds: sentence.startSeconds, endSeconds: sentence.endSeconds, sentenceIds: [sentence.id], vocalPartId: undefined }));
}
export function recordingMode(phase: string): 'technique' | 'sing' | null {
  if (['countdown', 'starting', 'recording'].includes(phase)) return 'technique';
  if (['preview', 'interrupted', 'error'].includes(phase)) return 'sing';
  return null;
}
export function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
export function touchClientX(event: unknown): number | null {
  const touch = (event as { touches?: { clientX?: unknown }[] })?.touches?.[0];
  return typeof touch?.clientX === 'number' && Number.isFinite(touch.clientX) ? touch.clientX : null;
}
