import { useEffect, useState } from 'react';
import { Button, ScrollView, Text, View } from '@tarojs/components';
import type { LanguageHint, SongProfile, SongSentence, VocalPart } from '../../../shared/songTypes';
import { alignVocalRows } from '../../../shared/audioTimeline';
import { confidenceLabel, projectLine, sourceLabel } from './presentation';

type Detail = { text: string; original: string; hints: LanguageHint[]; index: number };
type DisplayLine = { text: string; original: string; hints: LanguageHint[] };
function AnnotatedLine({ line, active, past, compact, onSeek, onSelect }: {
  line: DisplayLine; active: boolean; past: boolean; compact?: boolean; onSeek: () => void; onSelect: (detail: Detail) => void;
}) {
  return <View className={`lyric-line ${active ? 'active' : ''} ${past ? 'past' : ''} ${compact ? 'compact' : ''}`}
    onClick={() => { onSeek(); if (line.hints.length) onSelect({ ...line, index: 0 }); }}>
    {line.original !== line.text && <Text className='lyric-original'>{line.original}</Text>}
    <View className={line.original !== line.text ? 'lyric-pronunciation' : 'lyric-original'}>
      {Array.from(line.text || line.original).map((character, index) => <Text className='lyric-character' key={index}>
        {character}{line.hints.flatMap((hint, hintIndex) => hint.marks.filter((mark) => mark.startCharIndex === index)
          .map((mark, markIndex) => <Text key={`${hint.id}-${markIndex}`}
            className={`character-mark below ${mark.symbol === '×' ? 'elision' : mark.symbol === '‿' ? 'boundary link' : 'boundary merge'}`}
            onClick={(event) => { event.stopPropagation(); onSelect({ ...line, index: hintIndex }); }}>{mark.symbol === '└─┘' ? '└┘' : mark.symbol}</Text>))}
      </Text>)}
    </View>
  </View>;
}

export function Lyrics({ profile, time, onSeek }: { profile: SongProfile; time: number | null; onSeek: (seconds: number) => void }) {
  const [mode, setMode] = useState<'standard' | 'layers'>('standard');
  const [detail, setDetail] = useState<Detail | null>(null);
  useEffect(() => { setDetail(null); setMode(profile.sentences.length ? 'standard' : 'layers'); }, [profile.songId]);
  const current = time ?? 0;
  const activeSentence = profile.sentences.findIndex((sentence) => current >= sentence.startSeconds && current < sentence.endSeconds);
  const primary: VocalPart[] = profile.vocalParts.filter((part) => part.lane === 'primary')
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const anchors: VocalPart[] = primary.length ? primary : profile.sentences.map((sentence) => ({
    id: sentence.id, lane: 'primary', role: 'lead', lyrics: sentence.lyrics, sentenceIds: [sentence.id],
    startSeconds: sentence.startSeconds, endSeconds: sentence.endSeconds, source: 'lyrics_structure_candidate', confidence: 0,
    needsHumanReview: true, identityStatus: 'candidate', timingStatus: 'aligned_sentence_fallback', timingNeedsHumanReview: true, evidence: {},
  }));
  const rows = alignVocalRows(anchors, profile.vocalParts.filter((part) => part.lane === 'secondary').sort((a, b) => a.startSeconds - b.startSeconds));
  const activeRow = rows.findIndex((row) => [...row.primary, ...row.secondary].some((part) => current >= part.startSeconds && current < part.endSeconds));
  function partLine(part: VocalPart): DisplayLine {
    const sentence = profile.sentences.find((item) => part.sentenceIds.includes(item.id))
      ?? profile.sentences.find((item) => item.startSeconds < part.endSeconds && item.endSeconds > part.startSeconds);
    const original = part.lane === 'primary' ? part.lyrics.replace(/\s*[（(][^）)]*[）)]/g, '').trim() : part.lyrics;
    if (!sentence) return { text: original, original, hints: [] };
    const line = projectLine(sentence, part.lane, part.lane === 'secondary' ? original : undefined);
    return { ...line, original };
  }
  function standardLine(sentence: SongSentence): DisplayLine {
    const visible = new Set([...projectLine(sentence, 'primary').hints, ...projectLine(sentence, 'secondary').hints].map((hint) => hint.id));
    return { original: sentence.lyrics, text: sentence.pronunciation?.text ?? sentence.lyrics,
      hints: sentence.languageHints.filter((hint) => visible.has(hint.id)) };
  }
  return <View>
    <View className='legend'><Text><Text className='legend-symbol'>×</Text> 吞音(不发音)</Text><Text><Text className='legend-symbol'>‿</Text> 连读(改音)</Text><Text><Text className='legend-symbol'>└┘</Text> 连读(二合一)</Text></View>
    {!!profile.vocalParts.length && <View className='lyrics-stage-heading'><View className='lyrics-mode-switch'>
      <Button className={mode === 'standard' ? 'active' : ''} onClick={() => { setMode('standard'); setDetail(null); }}>普通歌词</Button>
      <Button className={mode === 'layers' ? 'active' : ''} onClick={() => { setMode('layers'); setDetail(null); }}>双轨歌词</Button>
    </View></View>}
    {profile.analysis.lyricsSource === 'asr' && <Text className='asr-lyrics-warning'>联网搜索歌词失败，使用自动识别，可能误差较大，请理解！</Text>}
    {mode === 'standard' ? <ScrollView className='lyrics-viewport' scrollY scrollWithAnimation scrollIntoView={activeSentence >= 0 ? `sentence-${activeSentence}` : undefined}>
      <View className='lyrics-list'>{profile.sentences.map((sentence, index) => <View id={`sentence-${index}`} key={sentence.id}>
        <AnnotatedLine line={standardLine(sentence)} active={index === activeSentence} past={current >= sentence.endSeconds}
          onSelect={setDetail} onSeek={() => onSeek(sentence.startSeconds)} />
      </View>)}</View>
      {!profile.sentences.length && <Text className='lyrics-empty'>当前缓存只包含 Vocal 分层信息；重新上传音频可生成语言标注歌词。</Text>}
    </ScrollView> : <View className='vocal-layers'>
      <View className='vocal-lane-heading'><View className='vocal-lane-title'><Text>主 Vocal</Text><Text>PRIMARY</Text></View>
        <View className='vocal-lane-title secondary'><Text>次 Vocal</Text><Text>SECONDARY</Text></View></View>
      <ScrollView className='vocal-lane-scroll' scrollY scrollWithAnimation scrollIntoView={activeRow >= 0 ? `vocal-row-${activeRow}` : undefined}>
        {rows.map((row, index) => <View className='vocal-lane-row' id={`vocal-row-${index}`} key={index}>
          {(['primary', 'secondary'] as const).map((lane) => <View className={`vocal-lane-cell ${lane}`} key={lane}>
            {row[lane].map((part) => <AnnotatedLine key={part.id} line={partLine(part)} compact
              active={current >= part.startSeconds && current < part.endSeconds} past={current >= part.endSeconds}
              onSelect={setDetail} onSeek={() => onSeek(part.startSeconds)} />)}
          </View>)}
        </View>)}
      </ScrollView>
    </View>}
    {detail && <HintDetail key={`${profile.songId}:${detail.original}:${detail.index}`} detail={detail} />}
  </View>;
}

function HintDetail({ detail }: { detail: Detail }) {
  const [index, setIndex] = useState(detail.index); const [metadata, setMetadata] = useState(false);
  const hint = detail.hints[index]; if (!hint) return null;
  const explanation = hint.details.find((item) => item.locale === 'zh-CN') ?? hint.details[0];
  return <View className='hint-detail'>
    <Button className='hint-arrow' disabled={detail.hints.length < 2} onClick={() => setIndex((index - 1 + detail.hints.length) % detail.hints.length)}>‹</Button>
    <View className='hint-content'>
      <View className='detail-heading'><TechniqueDisplay text={detail.text} hint={hint} /><Text>{index + 1}/{detail.hints.length}</Text></View>
      {detail.original !== detail.text && <View className='pronunciation-breakdown'>
        <Text><Text className='hint-label'>原文：</Text>{detail.original}</Text><Text><Text className='hint-label'>辅助读音：</Text>{hint.canonicalPronunciation ?? detail.text}</Text>
        {hint.observedPronunciation && <Text><Text className='hint-label'>演唱提示：</Text>{hint.observedPronunciation}</Text>}
      </View>}
      <Text className='action'><Text className='hint-label'>建议：</Text>{explanation?.action || '建议待补充'}</Text>
      <Text><Text className='hint-label'>专业分析：</Text>{explanation?.explanation || '解释待补充'}</Text>
      <Text className='text-button' onClick={() => setMetadata(!metadata)}>来源与复核 {metadata ? '▾' : '▸'}</Text>
      {metadata && <View className='review-note'>
        <Text>{sourceLabel(hint.source)} · {confidenceLabel(hint.confidence)}</Text>
        <Text>{hint.evidence.needsHumanReview === true ? '需要人工复核' : hint.evidence.needsHumanReview === false ? '未标记为待复核' : '复核状态未知'}</Text>
        <Text>证据强度：{({ strong: '较强', moderate: '中等', medium: '中等', weak: '较弱' }[hint.evidence.evidenceStrength ?? ''] ?? '未标注')}</Text>
      </View>}
    </View>
    <Button className='hint-arrow' disabled={detail.hints.length < 2} onClick={() => setIndex((index + 1) % detail.hints.length)}>›</Button>
  </View>;
}

// Match the H5 TechniqueDisplay: attach the mark beneath the final target
// character, with the following word retained as context.
function TechniqueDisplay({ text, hint }: { text: string; hint: LanguageHint }) {
  const mark = hint.marks[0];
  const symbol = mark?.symbol === '└─┘' ? '└┘' : mark?.symbol ?? '';
  const words = Array.from(text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g));
  const before = [...words].reverse().find((word) => (word.index ?? 0) <= (mark?.startCharIndex ?? 0));
  const after = words.find((word) => (word.index ?? 0) > (mark?.startCharIndex ?? 0));
  const left = Array.from(before?.[0] ?? (symbol === '×' ? '目标音' : ''));
  const markClass = symbol === '×' ? 'elision' : symbol === '‿' ? 'boundary link' : 'boundary merge';
  return <View className='technique-display'>
    {left.map((character, index) => <View className='lyric-character' key={index}>
      <Text>{character}</Text>{symbol && (index === left.length - 1 || (symbol === '×'
        && left[left.length - 1]?.toLowerCase() === 'e' && index === left.length - 2))
        && <Text className={`character-mark below ${markClass}`}>{symbol}</Text>}
    </View>)}
    {after && <Text className='technique-gap'> </Text>}
    {after && Array.from(after[0]).map((character, index) => <View className='lyric-character' key={`after-${index}`}><Text>{character}</Text></View>)}
  </View>;
}
