import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alignVocalRows, buildTrackSlotId, calculateTimelinePlacement, canTransitionRecorder,
  lyricsForLane, normalizeLoopTime,
} from './audioTimeline.ts';

test('positive compensation moves the take earlier and trims the mix boundary', () => {
  const result = calculateTimelinePlacement({ timelineStartSeconds: 10,
    latencyCompensationMs: 100, manualOffsetMs: 200, rangeStartSeconds: 10,
    rangeDurationSeconds: 5, bufferDurationSeconds: 4 });
  assert.ok(Math.abs(result.clipStartSeconds - 9.7) < 1e-9);
  assert.ok(Math.abs(result.bufferOffsetSeconds - 0.3) < 1e-9);
  assert.equal(result.delaySeconds, 0);
});

test('lane projection and row alignment preserve secondary vocals', () => {
  assert.equal(lyricsForLane('Sing (reply)', 'primary'), 'Sing');
  assert.equal(lyricsForLane('Sing (reply)', 'secondary'), 'reply');
  const primary = [{ id: 'a', startSeconds: 1, endSeconds: 2 }];
  const secondary = [{ id: 'b', startSeconds: 2.3, endSeconds: 3 }];
  assert.deepEqual(alignVocalRows(primary, secondary), [{ primary, secondary }]);
});

test('loop boundary, recorder transitions and long selections retain Web semantics', () => {
  assert.equal(normalizeLoopTime(8, 5, 8), 5);
  assert.equal(canTransitionRecorder('recording', 'preview'), true);
  assert.equal(canTransitionRecorder('recording', 'uploaded'), false);
  assert.equal(buildTrackSlotId('primary', Array.from({ length: 200 }, (_, i) => `s${i}`)),
    'primary:range:s0:s199:200');
});
