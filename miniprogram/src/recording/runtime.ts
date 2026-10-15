import { useSyncExternalStore } from 'react';
import Taro from '@tarojs/taro';
import { authSession } from '../auth';
import { audioResources } from '../audio/resources';
import { LocalPlayer } from '../audio/player';
import { taroTransport } from '../network/taroTransport';
import { RecorderController } from './controller';
import { authorizeRecording, cancelPrivacy } from './privacy';
import type { Operation } from '../network/client';
import type { AudioLease } from '../audio/downloads';

export const player = new LocalPlayer(() => Taro.createInnerAudioContext());
let preparing: Operation<AudioLease> | null = null;
export const recorder = new RecorderController({
  owner: () => authSession.getSnapshot().ownerId,
  authorize: authorizeRecording,
  driver() {
    const manager = Taro.getRecorderManager();
    return {
      start: (duration) => manager.start({ duration, format: 'mp3', sampleRate: 16000,
        numberOfChannels: 1, encodeBitRate: 64000, audioSource: 'auto' }),
      stop: () => manager.stop(), onStart: (fn) => manager.onStart(fn), onStop: (fn) => manager.onStop(fn),
      onError: (fn) => manager.onError(fn),
      onInterruption(fn) { manager.onInterruptionBegin(fn); manager.onPause(fn); },
    };
  },
  async prepare(selection) {
    player.lock('recording');
    const operation = audioResources.acquire({ kind: 'reference', songId: selection.songId, asset: 'accompaniment' });
    preparing = operation;
    const lease = await operation.promise;
    if (preparing === operation) preparing = null;
    try { await player.load(lease, selection.selectionStartSeconds, 'recording', 0); }
    catch (error) { lease.release(); player.unlock('recording'); throw error; }
    await player.seek(selection.selectionStartSeconds, 'recording');
  },
  playReference: () => player.play('recording'),
  stopReference() { preparing?.abort(); preparing = null; player.unlock('recording'); player.reset(); },
  remove: (path) => taroTransport.removeTempFile(path),
});
player.onEvent((event) => {
  if (recorder.getSnapshot().phase !== 'recording') return;
  if (event.kind === 'playing') recorder.referenceStarted(event.positionSeconds);
  else if (event.kind === 'ended') recorder.referenceEnded(event.positionSeconds);
  else {
    recorder.evidence(`reference_${event.kind}`, event.positionSeconds);
    if (['waiting', 'error', 'pause', 'stop', 'seek'].includes(event.kind)) {
      recorder.interrupt('录音期间参考播放发生中断，请重新录制。');
    }
  }
});
let owner: string | null = null;
authSession.subscribe(() => {
  const next = authSession.getSnapshot().ownerId;
  if (owner !== next || !next) { recorder.discard(); player.unlock('recording'); player.reset(); cancelPrivacy(); }
  owner = next;
});
export function interruptRecording(message?: string) { recorder.interrupt(message); cancelPrivacy(); }
export function useRecording() { return useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot); }
export function usePlayer() { return useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot); }
