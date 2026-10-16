import { authSession } from '../auth';
import { apiClient } from '../network';
import { taroTransport } from '../network/taroTransport';
import { AudioDownloads } from './downloads';
import { validateOrigin } from '../network/client';

export const audioResources = new AudioDownloads({
  download: (path, access) => apiClient.download(path, { access }),
  remove: (path) => taroTransport.removeTempFile(path),
  credentials: () => authSession.current(),
  publicUrl: (path) => validateOrigin(VERSEVIVA_API_ORIGIN) + path,
});
let lastOwner: string | null = null;
authSession.subscribe(() => {
  const owner = authSession.getSnapshot().ownerId;
  if (owner !== lastOwner || !owner) audioResources.reset();
  lastOwner = owner;
});
