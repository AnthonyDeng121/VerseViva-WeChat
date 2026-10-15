import type { PropsWithChildren } from 'react';
import { useDidHide, useDidShow, useLaunch } from '@tarojs/taro';
import { authSession } from './auth';
import { setAppForeground } from './network/lifecycle';
import './app.css';
import './audio/resources';
import { interruptRecording, player } from './recording/runtime';

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => { void authSession.restore(); });
  useDidShow(() => { player.setForeground(true); setAppForeground(true); });
  useDidHide(() => { setAppForeground(false); interruptRecording('切到后台后录音已中断，请重新录制。'); player.setForeground(false); });
  return children;
}
