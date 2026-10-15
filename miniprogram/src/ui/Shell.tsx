import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
export type PageMode = 'upload' | 'technique' | 'sing';
export function Shell({ mode, onModeChange, disabled = false }: {
  mode: PageMode; onModeChange?: (mode: PageMode) => void; disabled?: boolean;
}) {
  return <View className='hero'>
    <Text className='eyebrow'>VERSEVIVA · 声声不息</Text>
    <Text className='hero-title'>教你学唱外语歌，并支持叠唱音轨</Text>
    <Text className='intro'>点击上传歌曲文件，输入歌曲名 + 人名，系统自动解析歌词教学并支持多轨叠唱</Text>
    <View className='page-mode-switch'>
      {([['upload', '选择歌曲'], ['technique', '技巧分析'], ['sing', '演唱']] as const).map(([value, label]) =>
        <Button key={value} className={mode === value ? 'active' : ''} disabled={disabled}
          onClick={() => onModeChange ? onModeChange(value) : void Taro.redirectTo({ url: value === 'upload'
            ? '/pages/index/index' : `/pages/practice/index?mode=${value}` })}>{label}</Button>)}
    </View>
  </View>;
}
