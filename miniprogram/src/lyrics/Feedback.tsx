import { useEffect, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import type { Attempt, Memory } from '../network/api';
import type { SongProfile } from '../../../shared/songTypes';
import { comparisonLabel, projectLine, recommendationsForSentence } from './presentation';

export function Feedback({ attempt, profile, memory }: { attempt: Attempt; profile?: SongProfile; memory?: Memory | null }) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [attempt.attemptId]);
  if (profile && attempt.songId !== profile.songId) return null;
  if (attempt.status === 'failed' || attempt.status === 'processing') return <View className='practice-feedback'>
    <Text className='eyebrow'>{attempt.status === 'failed' ? '本次分析未完成' : '正在分析'}</Text>
    <Text className='feedback-comparison'>{comparisonLabel(attempt.status)}</Text>
  </View>;
  const lane = attempt.trackSlotId?.startsWith('secondary:') ? 'secondary' : 'primary';
  const ids = (attempt.sentenceIds ?? []).filter((id) => attempt.status !== 'analyzed' || attempt.sentenceComparisons?.[id]);
  const sentenceId = ids[Math.min(index, Math.max(0, ids.length - 1))];
  if (!sentenceId) return <View className='practice-feedback'><Text>本次暂无可靠的逐句反馈。</Text></View>;
  const sentence = profile?.sentences.find((item) => item.id === sentenceId);
  const text = sentence ? lane === 'secondary'
    ? profile?.vocalParts.filter((part) => part.lane === lane && part.sentenceIds.includes(sentenceId)).map((part) => part.lyrics).join(' / ')
    : projectLine({ ...sentence, pronunciation: null }, lane).text : '';
  const recommendations = recommendationsForSentence(attempt, sentenceId);
  const comparison = attempt.sentenceComparisons?.[sentenceId];
  return <View className='practice-feedback'>
    <View className='practice-feedback-heading'>
      <Button className='hint-arrow' disabled={index === 0} onClick={() => setIndex(Math.max(0, index - 1))}>‹</Button>
      <View className='practice-feedback-card'>
        <Text className='eyebrow'>本次建议 · {index + 1}/{ids.length}</Text>
        <Text className='feedback-lyrics'>{text || '所选句子'}</Text>
        <Text className='feedback-comparison'>{comparisonLabel(attempt.status, comparison?.result)}</Text>
        {attempt.status === 'insufficient_data' ? <Text className='recording-warning'>本次录音不足以可靠判断，请重录。</Text>
          : recommendations.length ? <View className='practice-recommendations'>{recommendations.map((item, i) => <View key={i}>
            <Text className='card-title'>{item.headline}</Text><Text>{item.observation}</Text><Text className='practice-action'>下一遍：{item.action}</Text>
          </View>)}</View> : <Text className='practice-success'>本句暂无新的练习建议。</Text>}
      </View>
      <Button className='hint-arrow' disabled={index >= ids.length - 1} onClick={() => setIndex(Math.min(ids.length - 1, index + 1))}>›</Button>
    </View>
    {memory && <Text className='feedback-memory-count'>本账号累计 {memory.totalAttempts} 次分析，其中 {memory.reliableAttempts} 次可靠</Text>}
  </View>;
}
