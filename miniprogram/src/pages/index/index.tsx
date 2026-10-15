import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { authSession, useAuth } from '../../auth';

export default function Index() {
  const auth = useAuth();
  const busy = auth.status === 'restoring' || auth.status === 'authenticating';
  return (
    <View className='page'>
      <Text className='eyebrow'>VerseViva · 声声不息</Text>
      <Text className='title'>听懂每一句，唱活每一首。</Text>
      <Text className='description'>看懂外语歌曲的发音处理，分别练习主唱与和声，记录每一次演唱的进步。</Text>
      <View className='card'>
        <Text className='card-title'>{auth.status === 'authenticated' ? '已登录' : '保存自己的练习进度'}</Text>
        <Text className='muted'>{auth.status === 'authenticated'
          ? '练习记录将保存到当前微信账号。' : '微信登录后，可保存和恢复自己的录音与练习记录。'}</Text>
        {auth.error && <Text className='muted'>{auth.error}</Text>}
        {auth.status === 'authenticated'
          ? <Button onClick={() => void authSession.signOut()}>退出登录</Button>
          : <Button disabled={busy} onClick={() => { void authSession.signIn().catch(() => {}); }}>
              {busy ? '正在登录…' : '微信登录'}
            </Button>}
      </View>
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
