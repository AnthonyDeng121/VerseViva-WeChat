import type { RecordingClip } from './controller.ts';
import type { SyncEvidence } from '../../../shared/recordingTypes.ts';

export function syncEvidence(clip: RecordingClip): SyncEvidence {
  const started = clip.events.find((event) => event.kind === 'recorder_started');
  const playing = clip.events.find((event) => event.kind === 'reference_playing');
  if (!started || !playing) throw new Error('录音同步事件不完整，请重新录制。');
  return { schemaVersion: 'wechat-sync-v1', clock: 'client_wall_ms', playbackRate: 1,
    calibrationStatus: clip.selection.calibrationStatus ?? 'unverified',
    calibratedDeviceLatencyMs: clip.selection.latencyCompensationMs,
    observedStartGapMs: playing.atMs - started.atMs, events: clip.events.map((event) => ({ ...event })) };
}
