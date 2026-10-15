import type { PropsWithChildren } from 'react';
import { useDidHide, useDidShow, useLaunch } from '@tarojs/taro';
import { authSession } from './auth';
import { setAppForeground } from './network/lifecycle';
import './app.css';
import './audio/resources';

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => { void authSession.restore(); });
  useDidShow(() => setAppForeground(true));
  useDidHide(() => setAppForeground(false));
  return children;
}
