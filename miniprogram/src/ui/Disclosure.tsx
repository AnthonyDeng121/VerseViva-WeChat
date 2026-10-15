import { useState, type ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
export function Disclosure({ title, children, initialOpen = false }: { title: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <View className='home-collapsible'>
    <View className='disclosure-summary' onClick={() => setOpen(!open)}><Text>{open ? '▾' : '▸'} {title}</Text></View>
    <View style={{ display: open ? 'block' : 'none' }}>{children}</View>
  </View>;
}
