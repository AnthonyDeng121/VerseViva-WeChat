import { useEffect, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import { useDidShow } from '@tarojs/taro';
import { useAuth } from '../../auth';
import { friendlyError } from '../../network';
import type { Memory as MemoryData } from '../../network/api';
import { practiceApi, useMemoryRevision } from '../../recording/submission';
import { issueLabel } from '../../lyrics/presentation';

export default function Memory() {
  const owner = useAuth().ownerId; const revision = useMemoryRevision();
  const [refresh, setRefresh] = useState(0); const [value, setValue] = useState<MemoryData | null>(null);
  const [error, setError] = useState('');
  useDidShow(() => setRefresh((n) => n + 1));
  useEffect(() => {
    setValue(null); setError(''); if (!owner) return;
    let live = true; const operation = practiceApi.memory();
    void operation.promise.then((result) => { if (live) setValue(result); })
      .catch((reason) => { if (live) setError(friendlyError(reason)); });
    return () => { live = false; operation.abort(); };
  }, [owner, revision, refresh]);
  return (
    <View className='page'>
      <Text className='title'>练习记忆</Text>
      <View className='card'>
        {!owner ? <Text>请回首页登录后查看自己的练习记忆。</Text> : value ? <View>
          <Text className='card-title'>累计练习 {value.totalAttempts} 次</Text>
          <Text className='muted'>可靠尝试 {value.reliableAttempts} 次；失败和证据不足不计入趋势。</Text>
          <Text className='muted'>最近窗口最多取 5 次可靠尝试。趋势为历史练习摘要，不代表每个语言目标都已改善。</Text>
          {value.phenomena.map((item) => <View className='hint-detail' key={item.issueType}>
            <Text className='card-title'>{issueLabel(item.issueType)}</Text>
            <Text className='muted'>累计出现 {item.issueCount} 次 · 最近窗口出现 {item.recentIssueCount} 次</Text>
            <Text>{item.trend === 'improving' ? '近期有改善迹象' : item.trend === 'stable' ? '近期暂未见明显变化' : '趋势待确认'}</Text>
          </View>)}
        </View> : <Text>{error || '正在读取练习记忆…'}</Text>}
        {owner && <Button onClick={() => setRefresh((n) => n + 1)}>刷新记录</Button>}
      </View>
    </View>
  );
}
