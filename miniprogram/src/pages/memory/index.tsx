import { Text, View } from '@tarojs/components';

export default function Memory() {
  return (
    <View className='page'>
      <Text className='title'>练习记忆</Text>
      <View className='card'>
        <Text className='card-title'>还没有练习记录</Text>
        <Text className='muted'>完成练唱分析后，在这里回看反馈与进步。分析失败或证据不足的尝试不会计入趋势。</Text>
      </View>
    </View>
  );
}
