export type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "preview"
  | "uploading"
  | "uploaded";

export type TimelinePlacement = {
  delaySeconds: number;
  bufferOffsetSeconds: number;
  availableSeconds: number;
  clipStartSeconds: number;
};

export function calculateTimelinePlacement({
  timelineStartSeconds,
  latencyCompensationMs = 0,
  manualOffsetMs = 0,
  rangeStartSeconds,
  rangeDurationSeconds,
  bufferDurationSeconds,
}: {
  timelineStartSeconds: number;
  latencyCompensationMs?: number;
  manualOffsetMs?: number;
  rangeStartSeconds: number;
  rangeDurationSeconds: number;
  bufferDurationSeconds: number;
}): TimelinePlacement {
  const correctionSeconds = (latencyCompensationMs + manualOffsetMs) / 1000;
  const clipStartSeconds = timelineStartSeconds - correctionSeconds;
  const delaySeconds = Math.max(0, clipStartSeconds - rangeStartSeconds);
  const bufferOffsetSeconds = Math.max(0, rangeStartSeconds - clipStartSeconds);
  return {
    clipStartSeconds,
    delaySeconds,
    bufferOffsetSeconds,
    availableSeconds: Math.max(0, Math.min(
      bufferDurationSeconds - bufferOffsetSeconds,
      rangeDurationSeconds - delaySeconds,
    )),
  };
}

export function offsetFromDrag({
  originalOffsetMs,
  deltaPixels,
  laneWidthPixels,
  timelineDurationSeconds,
}: {
  originalOffsetMs: number;
  deltaPixels: number;
  laneWidthPixels: number;
  timelineDurationSeconds: number;
}) {
  if (laneWidthPixels <= 0) return clampOffset(originalOffsetMs);
  const deltaSeconds = (deltaPixels / laneWidthPixels) * timelineDurationSeconds;
  return clampOffset(Math.round((originalOffsetMs - deltaSeconds * 1000) / 10) * 10);
}

export function clampOffset(value: number) {
  return Math.max(-2000, Math.min(2000, value));
}

export function normalizeLoopTime(current: number, start: number, end: number) {
  if (end <= start) return start;
  if (current < start || current >= end) return start;
  return current;
}

export function estimatePracticeAnalysisSeconds(
  durationSeconds: number,
  lane: "primary" | "secondary",
) {
  const secondsPerAudioSecond = lane === "secondary" ? 5 : 3.5;
  return Math.max(30, Math.ceil(Math.max(0, durationSeconds) * secondsPerAudioSecond + 20));
}

export function estimateAnalysisProgress(elapsedSeconds: number, estimatedSeconds: number) {
  return Math.min(92, 8 + (Math.max(0, elapsedSeconds) / Math.max(1, estimatedSeconds)) * 84);
}

export function buildTrackSlotId(
  lane: "primary" | "secondary",
  sentenceIds: string[],
) {
  const uniqueIds = Array.from(new Set(sentenceIds));
  if (uniqueIds.length === 0) return `${lane}:range:none:none:0`;
  return `${lane}:range:${uniqueIds[0]}:${uniqueIds.at(-1)}:${uniqueIds.length}`;
}

export function lyricsForLane(lyrics: string, lane: "primary" | "secondary") {
  const parenthetical = Array.from(lyrics.matchAll(/\(([^)]*)\)/g), (match) => match[1].trim())
    .filter(Boolean);
  if (lane === "secondary") {
    return parenthetical.length > 0 ? parenthetical.join(" ") : lyrics.replace(/^\(|\)$/g, "").trim();
  }
  return lyrics.replace(/\s*\([^)]*\)/g, "").trim();
}

export function summarizeTakeLyrics(lyrics: string[], lane: "primary" | "secondary") {
  const text = lyrics.map((item) => lyricsForLane(item, lane)).filter(Boolean).join(" ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return words.join(" ");
  return `${words.slice(0, 2).join(" ")} … ${words.slice(-2).join(" ")}`;
}

export type VocalRowPart = {
  id: string;
  startSeconds: number;
  endSeconds: number;
};

export function alignVocalRows<T extends VocalRowPart>(
  primary: T[],
  secondary: T[],
  toleranceSeconds = 0.5,
) {
  const rows = primary.map((part) => ({ primary: [part], secondary: [] as T[] }));
  for (const candidate of secondary) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    rows.forEach((row, index) => {
      const anchor = row.primary[0];
      const gap = candidate.startSeconds > anchor.endSeconds
        ? candidate.startSeconds - anchor.endSeconds
        : anchor.startSeconds > candidate.endSeconds
          ? anchor.startSeconds - candidate.endSeconds
          : 0;
      if (gap <= toleranceSeconds && gap < bestDistance) {
        bestIndex = index;
        bestDistance = gap;
      }
    });
    if (bestIndex >= 0) rows[bestIndex].secondary.push(candidate);
    else rows.push({ primary: [], secondary: [candidate] });
  }
  return rows;
}

const RECORDER_TRANSITIONS: Record<RecorderState, readonly RecorderState[]> = {
  idle: ["requesting"],
  requesting: ["idle", "recording"],
  recording: ["idle", "preview"],
  preview: ["idle", "requesting", "uploading"],
  uploading: ["preview", "uploaded"],
  uploaded: ["idle", "requesting"],
};

export function canTransitionRecorder(from: RecorderState, to: RecorderState) {
  return RECORDER_TRANSITIONS[from].includes(to);
}
