import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectLine, hintTarget, comparisonLabel, sourceLabel, recommendationsForSentence } from '../src/lyrics/presentation.ts';
import type { Attempt } from '../src/network/api';
import type { SongSentence, LanguageHint } from '../../shared/songTypes';
const hint = (start: number, end = start, symbol = '×'): LanguageHint => ({ id: `${start}`, phenomenon: 'elision', confidence: .9, source: 'human_curated', marks: [{ symbol, startCharIndex: start, endCharIndex: end, placement: 'below' }], details: [], evidence: {} });
const sentence = (lyrics: string, hints: LanguageHint[]): SongSentence => ({ id: 's1', lyrics, languageHints: hints, words: [], startSeconds: 0, endSeconds: 2 });
test('same words remain in their own lane and source positions survive removal', () => {
  const s = sentence('go (go) go', [hint(1), hint(5), hint(9)]);
  assert.deepEqual(projectLine(s, 'primary').hints.map((h) => h.marks[0].startCharIndex), [1, 5]);
  assert.deepEqual(projectLine(s, 'secondary', 'go').hints.map((h) => h.id), ['5']);
});
test('cross-lane ranges and cross-lane word targets are rejected', () => {
  const s = sentence('get (it) back', [{ ...hint(2), startWordIndex: 0, endWordIndex: 2 }, hint(2, 6, '‿')]);
  assert.equal(projectLine(s, 'primary').hints.length, 0);
  assert.equal(projectLine(s, 'secondary').hints.length, 0);
});
test('all symbols retain complete ranges and target text', () => {
  for (const symbol of ['×', '‿', '└─┘']) {
    const line = projectLine(sentence('get it', [hint(2, symbol === '×' ? 2 : 4, symbol)]), 'primary');
    assert.equal(line.hints[0].marks[0].symbol, symbol);
    assert.equal(hintTarget(line.text, line.hints[0]), symbol === '×' ? 'get' : 'get it');
  }
});
test('Japanese annotations index romanization, never original characters', () => {
  const s = { ...sentence('君と', [hint(3, 5, '‿')]), pronunciation: { text: 'kimi to', scheme: 'romaji', source: 'human_curated' } };
  assert.equal(projectLine(s, 'primary').text, 'kimi to');
  assert.equal(projectLine(s, 'primary').hints.length, 1);
  assert.equal(projectLine(s, 'secondary', '君と').hints.length, 0);
});
test('ambiguous repeated secondary text is not fuzzy matched', () => {
  assert.equal(projectLine(sentence('go (go go)', [hint(5)]), 'secondary', 'go').hints.length, 0);
});
test('Unicode code points, full width parentheses, and invalid bounds', () => {
  const s = sentence('😀a（a）b', [hint(1), hint(3), hint(9), hint(-1)]);
  assert.deepEqual(projectLine(s, 'primary').hints.map((h) => h.id), ['1']);
  assert.deepEqual(projectLine(s, 'secondary').hints.map((h) => h.id), ['3']);
});
test('failure and insufficient evidence override any improvement claim', () => {
  assert.match(comparisonLabel('failed', 'improved'), /分析未完成/);
  assert.match(comparisonLabel('insufficient_data', 'improved'), /证据不足/);
  assert.match(comparisonLabel('analyzed'), /暂无可靠/);
  assert.equal(sourceLabel('internal_unknown'), '来源待核对');
});
test('unmapped romanization with mixed original lanes stays unannotated', () => {
  const s = { ...sentence('君（君）', [hint(1)]), pronunciation: { text: 'kimi kimi', scheme: 'romaji', source: 'human_curated' } };
  assert.equal(projectLine(s, 'primary').text, '');
  assert.equal(projectLine(s, 'secondary').hints.length, 0);
});
test('feedback binds recommendations to sentence issue IDs and gates unreliable attempts', () => {
  const attempt: Attempt = { takeId: 't', status: 'analyzed', issues: [
    { issueId: 'i1', sentenceId: 's1', hintId: 'h1', wordText: 'get', confidence: .9, audibleEvidence: [] },
    { issueId: 'i2', sentenceId: 's2', hintId: 'h2', wordText: 'it', confidence: .9, audibleEvidence: [] },
  ], recommendations: [
    { issueId: 'i1', headline: 'one', observation: '', action: '' },
    { issueId: 'i2', headline: 'two', observation: '', action: '' },
  ] };
  assert.deepEqual(recommendationsForSentence(attempt, 's1').map((r) => r.headline), ['one']);
  assert.deepEqual(recommendationsForSentence({ ...attempt, status: 'failed' }, 's1'), []);
  assert.deepEqual(recommendationsForSentence({ ...attempt, status: 'insufficient_data' }, 's1'), []);
});
