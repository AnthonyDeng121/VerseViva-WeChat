import { useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import type { LanguageHint, SongProfile, SongSentence } from '../../../shared/songTypes';
import { confidenceLabel, hintTarget, projectLine, sourceLabel, type Lane } from './presentation';

function Line({ sentence, lane, original, exactText }: {
  sentence: SongSentence; lane: Lane; original?: string; exactText?: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const line = projectLine(sentence, lane, exactText);
  const originalText = original ?? projectLine({ ...sentence, pronunciation: null }, lane).text;
  const hint = line.hints.find((item) => item.id === selected);
  return <View>
    {sentence.pronunciation && <Text className='lyric-original'>{originalText}</Text>}
    <View className='lyric-text'>
      {line.text.trim() ? Array.from(line.text).map((character, index) => <Text key={index}>
        {character}{line.hints.flatMap((item) => item.marks.filter((mark) => mark.startCharIndex === index)
          .map((mark, markIndex) => <Text key={`${item.id}-${markIndex}`} className='lyric-mark'
            onClick={() => setSelected(item.id)}>{mark.symbol}</Text>))}
      </Text>) : <Text>{sentence.pronunciation ? '辅助读音尚未可靠定位' : originalText || '本句无对应声部'}</Text>}
    </View>
    {line.hints.length > 0 && <View className='hint-buttons'>{line.hints.map((item) => <Button key={item.id}
      className='hint-button' onClick={() => setSelected(selected === item.id ? null : item.id)}>
      {item.marks.map((mark) => mark.symbol).join(' ')} {hintTarget(line.text, item)} · 详情
    </Button>)}</View>}
    {hint && <HintDetail hint={hint} target={hintTarget(line.text, hint)} original={originalText} />}
  </View>;
}

function HintDetail({ hint, target, original }: { hint: LanguageHint; target: string; original: string }) {
  const detail = hint.details.find((item) => item.locale === 'zh-CN') ?? hint.details[0];
  return <View className='hint-detail'>
    <Text className='card-title'>{hint.marks.map((mark) => mark.symbol).join(' ')} {target}</Text>
    <Text className='muted'>原文：{original}</Text>
    {hint.canonicalPronunciation && <Text className='muted'>标准 / 辅助读音：{hint.canonicalPronunciation}</Text>}
    {hint.observedPronunciation && <Text className='muted'>演唱读音提示：{hint.observedPronunciation}</Text>}
    <Text className='description'>下一遍：{detail?.action || '建议待补充'}</Text>
    <Text className='muted'>{detail?.explanation || '解释待补充'}</Text>
    <Text className='muted'>{sourceLabel(hint.source)} · {confidenceLabel(hint.confidence)}</Text>
    <Text className='muted'>{hint.evidence.needsHumanReview === true ? '需要人工复核'
      : hint.evidence.needsHumanReview === false ? '未标记为待复核' : '复核状态未知'}</Text>
    <Text className='muted'>证据强度：{({ strong: '较强', moderate: '中等', medium: '中等', weak: '较弱' }[hint.evidence.evidenceStrength ?? ''] ?? '未标注')}</Text>
  </View>;
}

export function Lyrics({ profile, start, end, lane, time, onSeek }: {
  profile: SongProfile; start: number; end: number; lane: Lane; time: number | null; onSeek: (seconds: number) => void;
}) {
  return <View>
    <Text className='muted'>× 目标音未清楚出现或释放 · ‿ 跨词连续动作 · └─┘ 共享或融合。点击标记或详情查看练习动作。</Text>
    {profile.sentences.slice(start, end + 1).map((sentence, index) => {
      const parts = profile.vocalParts.filter((part) => part.lane === 'secondary' && part.sentenceIds.includes(sentence.id));
      const primary = projectLine(sentence, 'primary');
      const secondaryHints = parts.flatMap((part) => projectLine(sentence, 'secondary', part.lyrics).hints);
      const visible = new Set([...primary.hints, ...secondaryHints].map((hint) => hint.id));
      const hidden = sentence.languageHints.some((hint) => !visible.has(hint.id));
      return <View key={sentence.id} className={time !== null && time >= sentence.startSeconds && time < sentence.endSeconds ? 'lyric-row lyric-active' : 'lyric-row'}>
        <Button className='seek-button' onClick={() => onSeek(sentence.startSeconds)}>第 {start + index + 1} 句 · 跳到这里</Button>
        <View className={lane === 'primary' ? 'lyric-lane lane-primary lane-selected' : 'lyric-lane lane-primary'}>
          <Text className='lane-label'>主唱{lane === 'primary' ? ' · 当前练习' : ''}</Text>
          <Line sentence={sentence} lane='primary' />
        </View>
        {parts.map((part) => <View key={part.id} className={lane === 'secondary' ? 'lyric-lane lane-secondary lane-selected' : 'lyric-lane lane-secondary'}>
          <Text className='lane-label'>次声部{lane === 'secondary' ? ' · 当前练习' : ''}</Text>
          <Line sentence={sentence} lane='secondary' original={part.lyrics} exactText={part.lyrics} />
          <Text className='muted'>{sourceLabel(part.source)} · {confidenceLabel(part.confidence)}</Text>
          <Text className='muted'>{part.identityStatus === 'confirmed' ? '声部已确认' : '候选声部'} · {part.needsHumanReview ? '文本待复核' : '文本未标记为待复核'} · {part.timingNeedsHumanReview ? '时间待复核' : '时间未标记为待复核'}</Text>
        </View>)}
        {!parts.length && <Text className='muted'>本句无已标注次声部。</Text>}
        {hidden && <Text className='muted'>部分语言标记尚不能可靠定位到此声部，暂不绘制，需复核。</Text>}
      </View>;
    })}
  </View>;
}
