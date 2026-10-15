import { authSession } from '../auth';
import { apiClient } from '../network';
import { taroTransport } from '../network/taroTransport';
import { AudioDownloads } from './downloads';

export const audioResources = new AudioDownloads({
  download: (path, access) => apiClient.download(path, { access }),
  remove: (path) => taroTransport.removeTempFile(path),
  credentials: () => authSession.current(),
});
let lastOwner: string | null = null;
authSession.subscribe(() => {
  const owner = authSession.getSnapshot().ownerId;
  if (owner !== lastOwner || !owner) audioResources.reset();
  lastOwner = owner;
});
