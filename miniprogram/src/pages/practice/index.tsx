import { Text, View } from '@tarojs/components';

export default function Practice() {
  return (
    <View className='page'>
      <Text className='title'>逐句练习</Text>
      <View className='card'>
        <Text className='card-title'>还没有选择歌曲</Text>
        <Text className='muted'>选择歌曲后，在这里查看歌词、区分声部并练习演唱。</Text>
      </View>
    </View>
  );
}
