import Taro from '@tarojs/taro';
export type CachedSong = { songId: string; title: string; artist?: string };
const key = (owner: string | null) => `verseviva:library:v1:${encodeURIComponent(VERSEVIVA_API_ORIGIN)}:${owner ?? 'guest'}`;
export function readSongs(owner: string | null): CachedSong[] {
  try { const value = Taro.getStorageSync(key(owner));
    return Array.isArray(value) ? value.filter((item) => /^song_[a-f0-9]{32}$/.test(item?.songId) && typeof item.title === 'string') : [];
  } catch { return []; }
}
export function rememberSong(owner: string | null, song: CachedSong) {
  Taro.setStorageSync(key(owner), [...readSongs(owner).filter((item) => item.songId !== song.songId), song]);
}
export function forgetSong(owner: string | null, songId: string) {
  Taro.setStorageSync(key(owner), readSongs(owner).filter((item) => item.songId !== songId));
}
