import type { AnalysisJob, SongProfile } from '../../../shared/songTypes';
import { ApiClient, ApiError, type Operation } from './client.ts';

export type Take = { takeId: string; songId: string; audioUrl: string; mimeType: string;
  displayName?: string; trackSlotId?: string; sentenceIds?: string[]; gain?: number; muted?: boolean };
export type Attempt = {
  takeId: string; attemptId?: string;
  status: 'processing' | 'analyzed' | 'failed' | 'insufficient_data';
  insufficientReason?: string | null;
  recommendations?: { headline: string; observation: string; action: string }[];
};
export type Memory = { totalAttempts: number; reliableAttempts: number;
  phenomena: { issueType: string; issueCount: number; recentIssueCount: number; trend: string }[] };
export type TaskRef = { kind: 'song' | 'practice'; id: string };
export type TakeUpload = {
  filePath: string; trackSlotId: string; selectionType: 'sentence' | 'segment';
  sentenceIds: string[]; selectionStartSeconds: number; selectionEndSeconds: number;
  timelineStartSeconds: number; saveMode: 'practice_replace' | 'overdub_append';
  purpose?: 'guided_practice' | 'free_overdub'; vocalPartId?: string;
  durationSeconds?: number; latencyCompensationMs?: number; manualOffsetMs?: number;
};
const id = (value: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new ApiError('configuration', '内容标识无效。');
  return value;
};
const HERO_IDS = new Set(['song_00000000000000000000000000000003',
  'song_00000000000000000000000000000004', 'song_00000000000000000000000000000005']);

function checked<T>(operation: Operation<T>, valid: (value: T) => boolean): Operation<T> {
  return { abort: () => operation.abort(), promise: operation.promise.then((value) => {
    if (!value || !valid(value)) throw new ApiError('invalid_response', '任务状态返回异常，请稍后重试。');
    return value;
  }) };
}
function validJob(value: AnalysisJob) {
  return typeof value.job_id === 'string' && typeof value.song_id === 'string'
    && ['queued', 'processing', 'completed', 'failed'].includes(value.status);
}

export class VerseVivaApi {
  constructor(private client: ApiClient) {}
  health() { return this.client.request<{ status: string }>('GET', '/api/v1/health', { access: 'public' }); }
  profile(songId: string) {
    return this.client.request<SongProfile>('GET', `/api/v1/songs/${id(songId)}`,
      { access: HERO_IDS.has(songId) ? 'public' : 'private' });
  }
  uploadSong(filePath: string, title: string, artist: string, lyrics?: string) {
    return checked(this.client.upload<AnalysisJob>('/api/v1/songs/analyze', { filePath,
      formData: { title, artist, ...(lyrics ? { lyrics } : {}) } }), validJob);
  }
  songJob(jobId: string) {
    return checked(this.client.request<AnalysisJob>('GET', `/api/v1/songs/jobs/${id(jobId)}`),
      (value) => validJob(value) && value.job_id === jobId);
  }
  retrySong(jobId: string) {
    return checked(this.client.request<AnalysisJob>('POST', `/api/v1/songs/jobs/${id(jobId)}/retry`), validJob);
  }
  // Cancel is a server operation; stopping local polling alone never cancels a job.
  cancelSong(jobId: string) {
    return this.client.request<void>('DELETE', `/api/v1/songs/jobs/${id(jobId)}`);
  }
  uploadTake(songId: string, input: TakeUpload, onProgress?: (percent: number) => void) {
    const formData: Record<string, string> = {
      // Compatibility-only field; backend must derive ownership from verified auth.
      session_id: 'miniprogram', track_slot_id: input.trackSlotId,
      selection_type: input.selectionType, sentence_ids: JSON.stringify(input.sentenceIds),
      selection_start_seconds: String(input.selectionStartSeconds),
      selection_end_seconds: String(input.selectionEndSeconds),
      timeline_start_seconds: String(input.timelineStartSeconds), save_mode: input.saveMode,
      purpose: input.purpose ?? 'guided_practice',
      latency_compensation_ms: String(input.latencyCompensationMs ?? 0),
      manual_offset_ms: String(input.manualOffsetMs ?? 0),
    };
    if (input.vocalPartId) formData.vocal_part_id = input.vocalPartId;
    if (input.durationSeconds !== undefined) formData.client_duration_seconds = String(input.durationSeconds);
    return this.client.upload<Take>(`/api/v1/songs/${id(songId)}/takes`,
      { filePath: input.filePath, formData, onProgress });
  }
  startPractice(takeId: string, force = false) {
    return checked(this.client.request<{ takeId: string; status: 'processing' | 'complete' }>('POST',
      `/api/v1/takes/${id(takeId)}/analysis-jobs?force=${force}`),
    (value) => value.takeId === takeId && ['processing', 'complete'].includes(value.status));
  }
  attempt(takeId: string) {
    return checked(this.client.request<Attempt>('GET', `/api/v1/takes/${id(takeId)}/attempt`),
      (value) => value.takeId === takeId && (value.status === 'processing'
        || (['analyzed', 'failed', 'insufficient_data'].includes(value.status)
          && typeof value.attemptId === 'string')));
  }
  poll(ref: TaskRef): Operation<AnalysisJob | Attempt> {
    return ref.kind === 'song' ? this.songJob(ref.id) : this.attempt(ref.id);
  }
  downloadTake(takeId: string, onProgress?: (percent: number) => void) {
    return this.client.download(`/api/v1/takes/${id(takeId)}/audio`, { onProgress });
  }
  deleteTake(takeId: string, preserveAttempt = false) {
    return this.client.request<void>('DELETE', `/api/v1/takes/${id(takeId)}?preserve_attempt=${preserveAttempt}`);
  }
  takes(songId: string) { return this.client.request<Take[]>('GET', `/api/v1/songs/${id(songId)}/takes`); }
  memory() { return this.client.request<Memory>('GET', '/api/v1/practice/memory?session_id=miniprogram'); }
}

export function taskFinished(value: AnalysisJob | Attempt): boolean {
  return value.status !== 'queued' && value.status !== 'processing';
}
