import { useSyncExternalStore } from 'react';
import Taro from '@tarojs/taro';
import { apiClient } from '../network';
import { ApiClient, ApiError, validateOrigin } from '../network/client';
import { taroTransport } from '../network/taroTransport';
import { SessionManager } from './session';

const key = `verseviva:login-hint:v1:${encodeURIComponent(VERSEVIVA_API_ORIGIN)}`;

export const authSession = new SessionManager({
  async loginCode() {
    validateOrigin(VERSEVIVA_API_ORIGIN);
    try {
      const value = await Taro.login({ timeout: 10_000 });
      if (!value.code) throw new Error('missing code');
      return value.code;
    } catch { throw new ApiError('authentication', '微信登录未完成，请重新尝试。'); }
  },
  exchange: (code) => apiClient.request('POST', '/api/v1/auth/wechat/login',
    { access: 'public', data: { code } }).promise,
  async revoke(credentials) {
    // Revoke the captured token, never trigger a fresh login just to log out.
    const client = new ApiClient(VERSEVIVA_API_ORIGIN, taroTransport);
    client.configureAuth({
      current: () => ({ ...credentials, expiresAtMs: Number.MAX_SAFE_INTEGER }),
      refresh: async () => { throw new ApiError('authentication', '登录已失效。'); },
    });
    try { await client.request('POST', '/api/v1/auth/logout').promise; }
    catch (error) { if (!(error instanceof ApiError && error.code === 'authentication')) throw error; }
  },
  readHint: () => Taro.getStorageSync(key),
  writeHint: (ownerId) => Taro.setStorageSync(key, ownerId),
  removeHint: () => Taro.removeStorageSync(key),
  invalidateRequests: () => apiClient.configureAuth(authSession),
});
apiClient.configureAuth(authSession);

export function useAuth() {
  return useSyncExternalStore(authSession.subscribe, authSession.getSnapshot, authSession.getSnapshot);
}
