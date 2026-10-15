import { Text, View } from '@tarojs/components';
import type { Attempt } from '../network/api';
import type { SongProfile } from '../../../shared/songTypes';
import { comparisonLabel, confidenceLabel, projectLine, recommendationsForSentence } from './presentation';

export function Feedback({ attempt, profile }: { attempt: Attempt; profile?: SongProfile }) {
  if (profile && attempt.songId !== profile.songId) return null;
  if (attempt.status !== 'analyzed') return <View className='hint-detail'>
    <Text className='card-title'>{comparisonLabel(attempt.status)}</Text>
    {attempt.status === 'insufficient_data' && <Text className='muted'>请确认麦克风清晰收音，佩戴耳机后重新录制所选范围。</Text>}
    {attempt.status === 'failed' && <Text className='muted'>请稍后重试分析；服务失败不代表演唱存在问题。</Text>}
  </View>;
  const lane = attempt.trackSlotId?.startsWith('secondary:') ? 'secondary' : 'primary';
  const ids = attempt.sentenceIds ?? [];
  return <View>
    <Text className='muted'>AI 练习反馈 · 根据本次录音与参考目标生成，不是音准评分。</Text>
    {ids.map((id, index) => {
      const sentence = profile?.sentences.find((item) => item.id === id);
      const text = sentence ? lane === 'secondary'
        ? profile?.vocalParts.filter((part) => part.lane === lane && part.sentenceIds.includes(id)).map((part) => part.lyrics).join(' / ')
        : projectLine({ ...sentence, pronunciation: null }, lane).text : '';
      const issues = attempt.issues?.filter((issue) => issue.sentenceId === id) ?? [];
      const recommendations = recommendationsForSentence(attempt, id);
      const comparison = attempt.sentenceComparisons?.[id];
      return <View className='hint-detail' key={id}>
        <Text className='card-title'>{lane === 'primary' ? '主唱' : '次声部'} · 所选第 {index + 1} 句</Text>
        <Text className='lyric-text'>{text || '所选句子'}</Text>
        <Text className='muted'>{comparisonLabel(attempt.status, comparison?.result)}</Text>
        {!!comparison?.lookbackAttemptCount && <Text className='muted'>历史回看 {comparison.lookbackAttemptCount} 次可靠记录；只比较同句、同声部的相同目标。</Text>}
        {issues.map((issue) => <View key={issue.issueId}>
          <Text className='card-title'>{issue.wordText}</Text>
          <Text className='muted'>AI 录音观察 · {confidenceLabel(issue.confidence)}</Text>
          {issue.audibleEvidence.map((evidence, i) => <Text className='muted' key={i}>{evidence}</Text>)}
        </View>)}
        {recommendations.map((item, i) => <View key={i}>
          <Text className='card-title'>{item.headline}</Text><Text className='muted'>{item.observation}</Text>
          <Text className='description'>下一遍：{item.action}</Text>
        </View>)}
        {!recommendations.length && <Text className='muted'>{comparison ? '本句没有新的练习建议。' : '本句暂无可靠反馈，暂不下结论。'}</Text>}
      </View>;
    })}
    {!ids.length && <Text className='muted'>逐句反馈暂不可用，请重新读取分析记录。</Text>}
  </View>;
}
