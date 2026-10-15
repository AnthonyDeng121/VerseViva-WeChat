import Taro from '@tarojs/taro';
import { ApiError, type Transport, type WireRequest, type WireResponse } from './client';

export const taroTransport: Transport = {
  send(input: WireRequest) {
    const common = { url: input.url, header: input.headers, timeout: input.timeoutMs };
    const failure = (error: unknown): never => {
      const message = typeof error === 'object' && error !== null && 'errMsg' in error
        ? String(error.errMsg) : '';
      if (/timeout/i.test(message)) throw new ApiError('timeout', '连接超时，请检查网络后重试。');
      throw new ApiError('network', '网络连接失败，请检查网络后重试。');
    };
    if (input.kind === 'upload') {
      const task = Taro.uploadFile({ ...common, filePath: input.filePath!, name: 'audio',
        formData: input.formData });
      if (input.onProgress) task.onProgressUpdate((value) => input.onProgress!(value.progress));
      return { promise: task.then((value): WireResponse => ({ status: value.statusCode, data: value.data }))
        .catch(failure), abort: () => task.abort() };
    }
    if (input.kind === 'download') {
      const task = Taro.downloadFile(common);
      if (input.onProgress) task.onProgressUpdate((value) => input.onProgress!(value.progress));
      return { promise: task.then((value): WireResponse => ({ status: value.statusCode,
        tempFilePath: value.tempFilePath })).catch(failure), abort: () => task.abort() };
    }
    const task = Taro.request({ ...common, method: input.method,
      data: input.data as Record<string, unknown> | undefined, dataType: 'json' });
    return { promise: task.then((value): WireResponse => ({ status: value.statusCode, data: value.data }))
      .catch(failure), abort: () => task.abort() };
  },
  removeTempFile(path: string) {
    return new Promise<void>((resolve) => {
      Taro.getFileSystemManager().unlink({ filePath: path, complete: () => resolve() });
    });
  },
};
