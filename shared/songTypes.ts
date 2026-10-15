export type AnalysisJob = {
  job_id: string; song_id: string; title: string; artist?: string | null;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string; progress: number; attempt_count?: number;
  error?: { stage: string; message: string; detail?: string } | null;
  warnings?: { stage: string; message: string; detail?: string }[];
  updated_at?: string; audio_duration_seconds?: number | null;
  estimated_total_seconds?: number | null; estimated_remaining_seconds?: number | null;
  api_call_count?: number;
  queue_position?: number | null;
  stage_runtimes?: {
    stage: string; started_at: string; completed_at?: string | null;
    elapsed_seconds?: number | null; estimated_seconds?: number | null;
    api_call_count: number; cache_hit: boolean; run_count: number;
  }[];
};

export type CharacterMark = {
  symbol: string; startCharIndex: number; endCharIndex: number;
  placement: "above" | "below" | "inline" | "bridge";
};

export type LanguageHint = {
  id: string; phenomenon: string; startWordIndex?: number; endWordIndex?: number;
  confidence: number; source: string; marks: CharacterMark[];
  details: { locale: string; explanation: string; action: string }[];
  canonicalPronunciation?: string | null; observedPronunciation?: string | null;
  evidence: { evidenceStrength?: string; needsHumanReview?: boolean; result?: string };
};

export type SongSentence = {
  id: string; startSeconds: number; endSeconds: number; lyrics: string;
  pronunciation?: { text: string; scheme: string; source: string } | null;
  words: { id: string; text: string; startSeconds: number; endSeconds: number }[];
  languageHints: LanguageHint[];
};

export type VocalPart = {
  id: string; lane: "primary" | "secondary";
  role: "lead" | "harmony" | "backing_vocal" | "response" | "ad_lib" | "double" | "overlap";
  startSeconds: number; endSeconds: number; lyrics: string; sentenceIds: string[];
  source: "acoustic_candidate" | "audio_model_candidate" | "lyrics_structure_candidate" | "lyrics_provider" | "human_curated";
  confidence: number; needsHumanReview: boolean; identityStatus: "confirmed" | "candidate";
  timingStatus: "aligned_sentence_fallback" | "audio_model_observed" | "human_curated";
  timingConfidence?: number | null; timingNeedsHumanReview: boolean;
  evidence: Record<string, unknown>;
};

export type SongProfile = {
  songId: string; title: string; language?: string | null;
  audio: { sourceUrl: string; vocalUrl?: string | null; accompanimentUrl?: string | null };
  sentences: SongSentence[]; vocalParts: VocalPart[];
  analysis: {
    lyricsSource?: string; lyricsProvider?: string | null; lyricsMatchConfidence?: number | null;
    languageAnalysisProvider?: string | null; languageAnalysisModel?: string | null;
    vocalArrangementMode?: "single_track" | "dual_track";
  };
};
