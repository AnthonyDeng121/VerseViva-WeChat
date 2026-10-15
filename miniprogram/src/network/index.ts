import { ApiClient } from './client';
import { taroTransport } from './taroTransport';

// Empty by default: never fall back to the original Web production service.
export const apiClient = new ApiClient(VERSEVIVA_API_ORIGIN, taroTransport);
export { ApiError, friendlyError } from './client';
export type { AuthProvider, Credentials, Operation } from './client';
