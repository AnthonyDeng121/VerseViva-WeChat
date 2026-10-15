import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

export default function Index() {
  return (
    <View className='page'>
      <Text className='eyebrow'>VerseViva · 声声不息</Text>
      <Text className='title'>听懂每一句，唱活每一首。</Text>
      <Text className='description'>看懂外语歌曲的发音处理，分别练习主唱与和声，记录每一次演唱的进步。</Text>
      <View className='card'>
        <Text className='card-title'>逐句练习</Text>
        <Text className='muted'>从一句歌词开始，听参考、练发音，再录下自己的演唱。</Text>
        <Button onClick={() => Taro.navigateTo({ url: '/pages/practice/index' })}>进入练习</Button>
      </View>
      <View className='card'>
        <Text className='card-title'>练习记忆</Text>
        <Text className='muted'>回看可靠的练习反馈，找到下一次值得关注的发音动作。</Text>
        <Button onClick={() => Taro.navigateTo({ url: '/pages/memory/index' })}>查看练习记忆</Button>
      </View>
    </View>
  );
}
