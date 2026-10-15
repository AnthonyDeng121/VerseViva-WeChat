import { useEffect, useState } from 'react';
import { useDidHide, useDidShow, useUnload } from '@tarojs/taro';
import Taro from '@tarojs/taro';
import { useAuth } from '../auth';
import type { AnalysisJob } from '../../../shared/songTypes';
import { apiClient, ApiError, friendlyError } from './index';
import { VerseVivaApi, taskFinished, type Attempt, type TaskRef } from './api';
import { SerialPoller } from './poller';
import { registerForegroundTask } from './lifecycle';
import { PendingTasks } from './taskStorage';

export const pendingTasks = new PendingTasks({
  read: (key) => Taro.getStorageSync(key),
  write: (key, value) => Taro.setStorageSync(key, value),
  remove: (key) => Taro.removeStorageSync(key),
}, VERSEVIVA_API_ORIGIN);
export const songApi = new VerseVivaApi(apiClient);

// Mount after authentication. Re-read pendingTasks for the verified owner on restore.
export function useTask(ref: TaskRef | null) {
  const [value, setValue] = useState<AnalysisJob | Attempt | null>(null);
  const [error, setError] = useState('');
  const [interrupted, setInterrupted] = useState(false);
  const [poller, setPoller] = useState<SerialPoller<AnalysisJob | Attempt> | null>(null);
  const [pageVisible, setPageVisible] = useState(true);
  useDidShow(() => setPageVisible(true));
  useDidHide(() => setPageVisible(false));
  useUnload(() => poller?.dispose());
  const owner = useAuth().ownerId;
  useEffect(() => {
    setValue(null); setError(''); setInterrupted(false);
    if (!ref || !owner) {
      if (ref) setError('请先登录后再查看分析进度。');
      setPoller(null); return;
    }
    const current = ref;
    try { pendingTasks.add(owner, current); }
    catch { setError('本地记录暂时无法保存，返回后可能需要重新打开任务。'); }
    const next = new SerialPoller({
      load: () => {
        if (apiClient.currentOwner() !== owner) {
          return { promise: Promise.reject(new ApiError('authentication', '登录状态已变化，请重新打开任务。')),
            abort() {} };
        }
        return songApi.poll(current);
      }, isDone: taskFinished,
      onValue: (result) => {
        setValue(result); setError(''); setInterrupted(false);
        if (taskFinished(result)) {
          try { pendingTasks.remove(owner, current); }
          catch { /* A stale local ID cannot authorize access on the server. */ }
        }
      },
      onError: (reason, willRetry) => {
        const missing = reason instanceof ApiError && reason.status === 404 && current.kind === 'practice';
        setInterrupted(missing);
        const message = missing
          ? '分析任务已中断或不可访问，请返回录音后重新分析。' : friendlyError(reason);
        setError(`${message}${willRetry ? '正在重试。' : ''}`);
      },
    });
    setPoller(next);
    return () => next.dispose();
  }, [ref?.kind, ref?.id, owner]);
  useEffect(() => {
    if (!poller || !pageVisible) { poller?.pause(); return; }
    return registerForegroundTask(poller);
  }, [poller, pageVisible]);
  return { value, error, interrupted, retry: () => { setError(''); setInterrupted(false); poller?.retry(); },
    pause: () => poller?.pause() };
}
