import { useEffect, useSyncExternalStore } from 'react';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { ApiError } from '../network/client';

let pending: ((option: { event: 'agree' | 'disagree'; buttonId?: string }) => void) | null = null;
let registered = false;
const listeners = new Set<() => void>();
function publish() { listeners.forEach((fn) => fn()); }
function ensurePrivacyListener() {
  if (registered || !Taro.canIUse('onNeedPrivacyAuthorization')) return;
  registered = true;
  Taro.onNeedPrivacyAuthorization((resolve) => {
    pending?.({ event: 'disagree' }); pending = resolve; publish();
  });
}
export function cancelPrivacy() { pending?.({ event: 'disagree' }); pending = null; publish(); }
export async function authorizeRecording() {
  ensurePrivacyListener();
  if (!Taro.canIUse('requirePrivacyAuthorize')) throw new ApiError('configuration', '请升级微信后使用录音功能。');
  await new Promise<void>((resolve, reject) => Taro.requirePrivacyAuthorize({ success: () => resolve(),
    fail: () => reject(new ApiError('authentication', '请先同意录音用途和隐私指引。')) }));
  try { await Taro.authorize({ scope: 'scope.record' }); }
  catch { throw new ApiError('authentication', '麦克风权限未开启，请在权限设置中允许录音后重试。'); }
}
export function RecordingPrivacy() {
  useEffect(() => { ensurePrivacyListener(); return cancelPrivacy; }, []);
  const visible = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => pending !== null);
  if (!visible) return null;
  return <View className='privacy-mask'><View className='card'>
    <Text className='card-title'>录音用途与隐私</Text>
    <Text className='muted'>录音先保存在本机；点击分析后上传，由后端 Gemini 服务提供演唱反馈。仅分析不保留云端录音；选择保存后可手动删除。请勿录入敏感或他人隐私信息。</Text>
    <Button onClick={() => Taro.openPrivacyContract({})}>查看隐私保护指引</Button>
    <Button id='recording-privacy-agree' openType='agreePrivacyAuthorization'
      onAgreePrivacyAuthorization={() => { pending?.({ event: 'agree', buttonId: 'recording-privacy-agree' }); pending = null; publish(); }}>同意并继续</Button>
    <Button onClick={cancelPrivacy}>暂不录音</Button>
  </View></View>;
}
