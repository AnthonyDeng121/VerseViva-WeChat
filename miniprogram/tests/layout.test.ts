import { test } from 'node:test';
import assert from 'node:assert/strict';
import { practiceOptions, recordingMode, touchClientX } from '../src/ui/practiceLayout.ts';
import type { SongProfile, VocalPart } from '../../shared/songTypes';
const profile: SongProfile = { songId: 'song_test', title: 'demo', audio: { sourceUrl: '' }, analysis: {},
  sentences: [{ id: 's1', startSeconds: 10, endSeconds: 15, lyrics: 'lead (echo)', words: [], languageHints: [] },
    { id: 's2', startSeconds: 16, endSeconds: 20, lyrics: 'next', words: [], languageHints: [] }], vocalParts: [] };
const part = (changes: Partial<VocalPart>): VocalPart => ({ id: 'echo', lane: 'secondary', role: 'response',
  startSeconds: 10.3, endSeconds: 14, lyrics: 'echo', sentenceIds: ['s1'], source: 'lyrics_provider', confidence: 1,
  needsHumanReview: false, identityStatus: 'confirmed', timingStatus: 'human_curated', timingNeedsHumanReview: false,
  evidence: {}, ...changes });
test('secondary range selectors show only available parts and retain primary sentence time anchor', () => {
  assert.deepEqual(practiceOptions(profile, 'secondary'), []);
  const options = practiceOptions({ ...profile, vocalParts: [part({})] }, 'secondary');
  assert.equal(options.length, 1); assert.equal(options[0].label, 'echo');
  assert.equal(options[0].startSeconds, 10); assert.equal(options[0].endSeconds, 14);
  assert.deepEqual(options[0].sentenceIds, ['s1']);
});
test('primary options retain H5 part ordering and exclude parenthetical secondary text', () => {
  const options = practiceOptions({ ...profile, vocalParts: [part({ id: 'second', lane: 'primary', startSeconds: 16, lyrics: 'next', sentenceIds: ['s2'] }),
    part({ id: 'first', lane: 'primary', lyrics: 'lead (echo)' })] }, 'primary');
  assert.deepEqual(options.map((option) => option.label), ['lead', 'next']);
  assert.deepEqual(practiceOptions(profile, 'primary').map((option) => option.id), ['s1', 's2']);
});
test('recording mode changes at countdown/start and returns to sing for preview or interruption', () => {
  for (const phase of ['countdown', 'starting', 'recording']) assert.equal(recordingMode(phase), 'technique');
  for (const phase of ['preview', 'interrupted', 'error']) assert.equal(recordingMode(phase), 'sing');
  for (const phase of ['idle', 'preloading', 'stopping']) assert.equal(recordingMode(phase), null);
});
test('native drag accepts finite touch positions and ignores missing or invalid events', () => {
  assert.equal(touchClientX({ touches: [{ clientX: 0 }] }), 0);
  assert.equal(touchClientX({ touches: [{ clientX: 150.5 }] }), 150.5);
  for (const value of [null, {}, { touches: [] }, { touches: [{ clientX: NaN }] }, { touches: [{ clientX: '12' }] }]) {
    assert.equal(touchClientX(value), null);
  }
});
