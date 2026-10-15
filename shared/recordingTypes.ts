export type SyncEventKind = 'recorder_start_requested' | 'recorder_started' | 'recorder_stop_requested'
  | 'recorder_stopped' | 'reference_play_requested' | 'reference_playing' | 'reference_pause'
  | 'reference_stop' | 'reference_ended' | 'reference_waiting' | 'reference_seek' | 'reference_error' | 'interrupted';
export type SyncEvent = { kind: SyncEventKind; atMs: number; positionSeconds?: number };
export type SyncEvidence = { schemaVersion: 'wechat-sync-v1'; clock: 'client_wall_ms'; playbackRate: 1;
  calibrationStatus: 'unverified' | 'user_calibrated'; calibratedDeviceLatencyMs: number;
  observedStartGapMs: number; events: SyncEvent[] };
