import { useState } from 'react';
import { Button, Input, Text, Textarea, View } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { authSession, useAuth } from '../../auth';
import { Shell, type PageMode } from '../../ui/Shell';
import { Disclosure } from '../../ui/Disclosure';
import { readSongs, forgetSong } from '../../ui/songLibrary';
import { songApi, pendingTasks } from '../../network/useTask';
import { friendlyError } from '../../network';

export default function Index() {
  const auth = useAuth(); const owner = auth.ownerId;
  const [, refreshLibrary] = useState(0); const songs = readSongs(owner);
  const [title, setTitle] = useState(''); const [artist, setArtist] = useState(''); const [lyrics, setLyrics] = useState('');
  const [file, setFile] = useState<{ path: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [reviewName, setReviewName] = useState(''); const [reviewPassword, setReviewPassword] = useState('');
  useDidShow(() => refreshLibrary((value) => value + 1));
  function open(songId: string, mode: PageMode = 'technique') {
    void Taro.navigateTo({ url: `/pages/practice/index?songId=${songId}&mode=${mode}` });
  }
  function mode(next: PageMode) {
    if (next === 'upload') return;
    const last = readSongs(owner).slice(-1)[0];
    if (last) open(last.songId, next);
    else void Taro.navigateTo({ url: `/pages/practice/index?mode=${next}` });
  }
  async function choose() {
    try { const result = await Taro.chooseMessageFile({ count: 1, type: 'file', extension: ['mp3', 'wav', 'flac'] });
      const selected = result.tempFiles[0]; if (selected) setFile({ path: selected.path, name: selected.name });
    } catch { /* Cancelling the native chooser keeps the current selection. */ }
  }
  async function upload() {
    if (!owner || !file) return; setBusy(true); setError('');
    try { const job = await songApi.uploadSong(file.path, title, artist, lyrics || undefined).promise;
      if (authSession.getSnapshot().ownerId !== owner) return;
      pendingTasks.add(owner, { kind: 'song', id: job.job_id });
      await Taro.navigateTo({ url: `/pages/practice/index?jobId=${job.job_id}` });
    } catch (reason) { setError(friendlyError(reason)); } finally { setBusy(false); }
  }
  async function manage(songId: string, remove: boolean) {
    setBusy(true); setError('');
    try {
      const confirm = await Taro.showModal({ title: remove ? '删除歌曲' : '重新分析歌曲',
        content: remove ? '将删除歌曲、录音和相关练习记录，是否继续？' : '将基于原始上传文件重新分析，是否继续？' });
      if (!confirm.confirm || authSession.getSnapshot().ownerId !== owner) return;
      if (remove) { await songApi.deleteSong(songId).promise;
        if (authSession.getSnapshot().ownerId === owner) { forgetSong(owner, songId); refreshLibrary((value) => value + 1); }
      } else { const job = await songApi.reanalyzeSong(songId).promise;
        if (owner && authSession.getSnapshot().ownerId === owner) { pendingTasks.add(owner, { kind: 'song', id: job.job_id });
          await Taro.navigateTo({ url: `/pages/practice/index?jobId=${job.job_id}` }); }
      }
    } catch (reason) { setError(friendlyError(reason)); } finally { setBusy(false); }
  }
  return <View className='page'>
    <Shell mode='upload' onModeChange={mode} />
    <Disclosure title='自行上传歌曲'>
      <Text className='upload-cost-note'>由于模型计算和服务器成本，建议上传 60 秒以内的音频，以减少等待时间。</Text>
      <View className='upload-card'>
        <Text>歌曲文件</Text><Button className='secondary-button' disabled={busy} onClick={() => void choose()}>{file?.name || '选择歌曲文件'}</Button>
        <Text>歌曲名<Text className='input-warning'>（请严格写出正确的歌名，区分大小写，不支持模糊匹配）</Text></Text>
        <Input value={title} placeholder='例如：Poker Face' onInput={(event) => setTitle(event.detail.value)} />
        <Text>歌手<Text className='input-warning'>（请严格写出正确的歌手名，区分大小写，不支持模糊匹配）</Text></Text>
        <Input value={artist} placeholder='例如：Lady Gaga' onInput={(event) => setArtist(event.detail.value)} />
        <Disclosure title='高级：手动提供歌词'><Text>歌词（会优先于 LRCLIB）</Text>
          <Textarea value={lyrics} placeholder='仅在自动查词不准时使用' onInput={(event) => setLyrics(event.detail.value)} /></Disclosure>
        {!owner && <Text className='muted'>微信登录后可上传并保存自己的歌曲。</Text>}
        <Button className='primary-button' disabled={busy || !owner || !file} onClick={() => void upload()}>{busy ? '正在上传…' : '上传并分析'}</Button>
      </View>
    </Disclosure>
    <Disclosure title='示例歌曲'><View className='hero-shortcut'>
      <Text className='hero-description'>可以直接选择官方示例歌曲片段展示功能</Text>
      {[['03', 'get him back!（英语）'], ['04', "AS IF IT'S YOUR LAST（韩语）"], ['05', '動物園は大変だ（日语）']].map(([suffix, label]) =>
        <Button className='secondary-button' key={suffix} onClick={() => open(`song_000000000000000000000000000000${suffix}`)}>{label}</Button>)}
    </View></Disclosure>
    <Disclosure title='已缓存歌曲'><View className='song-cache'>
      {songs.filter((song) => !/^song_0{31}[345]$/.test(song.songId)).map((song) => <View className='cached-song' key={song.songId}>
        <Button className='secondary-button' disabled={busy} onClick={() => open(song.songId)}>{song.title}{song.artist ? ` · ${song.artist}` : ''}</Button>
        <Button className='text-button' disabled={busy} onClick={() => void manage(song.songId, false)}>重新分析</Button>
        <Button className='danger-link' disabled={busy} onClick={() => void manage(song.songId, true)}>删除</Button>
      </View>)}
      {!songs.some((song) => !/^song_0{31}[345]$/.test(song.songId)) && <Text className='muted'>还没有这台设备上传过的歌曲片段。</Text>}
    </View></Disclosure>
    {error && <Text className='error-card'>{error}</Text>}
    <View className='account-tools'>
      {auth.status === 'authenticated' ? <Button className='text-button' onClick={() => void authSession.signOut()}>退出微信登录</Button>
        : <Button className='text-button' disabled={['restoring', 'authenticating'].includes(auth.status)} onClick={() => void authSession.signIn().then(() => refreshLibrary((value) => value + 1)).catch(() => {})}>微信登录</Button>}
      <Button className='text-button' onClick={() => Taro.navigateTo({ url: '/pages/memory/index' })}>练习记忆</Button>
      <Button className='text-button' onClick={() => Taro.navigateTo({ url: '/pages/practice/index?tasks=1' })}>恢复分析任务</Button>
    </View>
    {auth.status !== 'authenticated' && <Disclosure title='测试账号登录'>
      <View className='song-cache'>
        <Text>账号</Text><Input value={reviewName} maxlength={64} onInput={(event) => setReviewName(event.detail.value)} />
        <Text>密码</Text><Input password value={reviewPassword} maxlength={128} onInput={(event) => setReviewPassword(event.detail.value)} />
        <Button className='secondary-button' disabled={!reviewName || !reviewPassword || auth.status === 'authenticating'} onClick={() => {
          const password = reviewPassword; setReviewPassword(''); setError('');
          void authSession.signInReview(reviewName.trim(), password).then(() => refreshLibrary((value) => value + 1))
            .catch((reason) => setError(friendlyError(reason)));
        }}>测试账号登录</Button>
      </View>
    </Disclosure>}
    {auth.error && <Text className='muted'>{auth.error}</Text>}
  </View>;
}
