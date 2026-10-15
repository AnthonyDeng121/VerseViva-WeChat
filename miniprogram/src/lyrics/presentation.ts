import type { LanguageHint, SongSentence } from '../../../shared/songTypes';
import type { Attempt } from '../network/api';
export type Lane = 'primary' | 'secondary';
export const sourceLabel = (source: string) => ({ acoustic_observed: '声学观察', text_rule_candidate: '文本规则候选', llm_suggestion: 'AI 建议', human_curated: '人工校对', lyrics_provider: '歌词提供方', acoustic_candidate: '声学候选', audio_model_candidate: '音频模型候选', lyrics_structure_candidate: '歌词结构候选' }[source] ?? '来源待核对');
export function confidenceLabel(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? `置信度 ${Math.round(value * 100)}%（不是演唱得分）` : '置信度未知';
}
function positions(text: string) {
  let depth = 0;
  return Array.from(text).map((character) => {
    if (character === '(' || character === '（') { depth++; return null; }
    if (character === ')' || character === '）') { depth = Math.max(0, depth - 1); return null; }
    return depth ? 'secondary' : 'primary';
  });
}
export function projectLine(sentence: SongSentence, lane: Lane, exactText?: string) {
  const text = sentence.pronunciation?.text ?? sentence.lyrics;
  if (sentence.pronunciation && /[（(]/.test(sentence.lyrics) && !/[（(]/.test(text)) {
    return { text: '', hints: [] as LanguageHint[] };
  }
  const chars = Array.from(text); const lanes = positions(text);
  // No fuzzy matching: repeated words in another lane must never claim a mark.
  let indices = chars.map((_, index) => index).filter((index) => lanes[index] === lane);
  if (exactText !== undefined) {
    const wanted = Array.from(exactText.trim());
    const matches = indices.filter((index) => wanted.length > 0 && wanted.every((char, offset) =>
      chars[index + offset] === char && lanes[index + offset] === lane));
    indices = matches.length === 1 ? wanted.map((_, offset) => matches[0] + offset) : [];
  }
  const sourceToTarget = new Map(indices.map((index, target) => [index, target]));
  const words = Array.from(text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g));
  const wordLane = (index: number) => {
    const match = words[index];
    return match ? lanes[Array.from(text.slice(0, match.index)).length] : null;
  };
  const hints = sentence.languageHints.flatMap((hint) => {
    if (hint.startWordIndex !== undefined && hint.endWordIndex !== undefined) {
      if (!Number.isInteger(hint.startWordIndex) || !Number.isInteger(hint.endWordIndex)
        || hint.startWordIndex < 0 || hint.endWordIndex >= words.length || hint.endWordIndex < hint.startWordIndex) return [];
      for (let index = hint.startWordIndex; index <= hint.endWordIndex; index++) {
        if (wordLane(index) !== lane) return [];
      }
    }
    if (!hint.marks.length || hint.marks.some((mark) => {
      if (!['×', '‿', '└─┘'].includes(mark.symbol) || !Number.isInteger(mark.startCharIndex)
        || !Number.isInteger(mark.endCharIndex) || mark.startCharIndex < 0 || mark.endCharIndex >= chars.length
        || mark.endCharIndex < mark.startCharIndex) return true;
      for (let index = mark.startCharIndex; index <= mark.endCharIndex; index++) {
        if (!sourceToTarget.has(index)) return true;
      }
      return false;
    })) return [];
    return [{ ...hint, marks: hint.marks.map((mark) => ({ ...mark,
      startCharIndex: sourceToTarget.get(mark.startCharIndex)!, endCharIndex: sourceToTarget.get(mark.endCharIndex)! })) }];
  });
  return { text: indices.map((index) => chars[index]).join(''), hints };
}
export function hintTarget(text: string, hint: LanguageHint) {
  const chars = Array.from(text); const mark = hint.marks[0];
  if (!mark) return '目标待核对';
  let start = mark.startCharIndex; let end = mark.endCharIndex + 1;
  while (start > 0 && /[A-Za-z’']/.test(chars[start - 1])) start--;
  while (end < chars.length && /[A-Za-z’']/.test(chars[end])) end++;
  return chars.slice(start, end).join('').trim();
}
export const issueLabel = (value: string) => ({ expected_elision_realized: '省音处理', identical_consonants_separated: '相同辅音衔接', coalescent_assimilation_missing: '融合连读', target_phoneme_omitted: '目标音保留' }[value] ?? '语言练习');
export function comparisonLabel(status: string, result?: string) {
  if (status === 'failed') return '分析未完成，不生成逐句结论，不计入趋势。';
  if (status === 'insufficient_data') return '录音证据不足，暂不下结论，不计入趋势。';
  if (status !== 'analyzed') return '正在分析，暂不下结论。';
  return ({ first_attempt: '这是本句、本声部的第一遍可靠记录', improved: '与上一遍相同目标相比有改善', unchanged: '与上一遍相同目标相比暂未变化', regressed: '相同目标出现新的重点，可再试一遍', insufficient_data: '可比较的相同目标不足，暂不比较' }[result ?? ''] ?? '暂无可靠的同目标比较');
}
export function recommendationsForSentence(attempt: Attempt, sentenceId: string) {
  if (attempt.status !== 'analyzed') return [];
  const ids = new Set(attempt.issues?.filter((issue) => issue.sentenceId === sentenceId).map((issue) => issue.issueId));
  return attempt.recommendations?.filter((item) => item.issueId && ids.has(item.issueId)) ?? [];
}
