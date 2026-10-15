import type { PropsWithChildren } from 'react';
import { useDidHide, useDidShow } from '@tarojs/taro';
import { setAppForeground } from './network/lifecycle';
import './app.css';

export default function App({ children }: PropsWithChildren) {
  useDidShow(() => setAppForeground(true));
  useDidHide(() => setAppForeground(false));
  return children;
}
