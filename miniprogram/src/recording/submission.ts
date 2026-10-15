import { useSyncExternalStore } from 'react';
import Taro from '@tarojs/taro';
import { authSession } from '../auth';
import { VerseVivaApi } from '../network/api';
import { apiClient } from '../network';
import { registerForegroundTask } from '../network/lifecycle';
import { recorder } from './runtime';
import { PracticeWorkflow } from './workflow';
import { syncEvidence } from './sync';

export const practiceApi = new VerseVivaApi(apiClient);
let memoryRevision = 0;
const memoryListeners = new Set<() => void>();
export function invalidateMemory() { memoryRevision += 1; memoryListeners.forEach((fn) => fn()); }
export function useMemoryRevision() { return useSyncExternalStore((fn) => { memoryListeners.add(fn);
  return () => { memoryListeners.delete(fn); }; }, () => memoryRevision); }
const key = (owner: string) => `verseviva:submission:v1:${encodeURIComponent(VERSEVIVA_API_ORIGIN)}:${owner}`;
export const submission = new PracticeWorkflow({
  currentOwner: () => authSession.getSnapshot().ownerId,
  upload: (clip) => practiceApi.uploadTake(clip.selection.songId, { ...clip.selection,
    filePath: clip.filePath, durationSeconds: clip.durationSeconds, saveMode: 'overdub_append', syncEvidence: syncEvidence(clip) }),
  start: (takeId, force) => practiceApi.startPractice(takeId, force),
  attempt: (takeId) => practiceApi.attempt(takeId), remove: (takeId, preserve) => practiceApi.deleteTake(takeId, preserve),
  read: (owner) => Taro.getStorageSync(key(owner)),
  remember: (owner, value) => value ? Taro.setStorageSync(key(owner), value) : Taro.removeStorageSync(key(owner)),
  watch: (poller) => registerForegroundTask(poller),
  async refreshMemory() { await practiceApi.memory().promise; invalidateMemory(); },
  releaseClip: () => recorder.discard(),
});
let owner: string | null = null;
authSession.subscribe(() => {
  const current = authSession.getSnapshot().ownerId;
  if (current !== owner || !current) submission.reset();
  owner = current;
  if (current) void submission.restore().catch(() => {});
});
export function useSubmission() { return useSyncExternalStore(submission.subscribe, submission.getSnapshot, submission.getSnapshot); }
