import { defineConfig } from '@tarojs/cli';

export default defineConfig<'webpack5'>({
  projectName: 'verseviva-wechat',
  date: '2026-10-14',
  designWidth: 750,
  deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2, 828: 1.81 / 2 },
  sourceRoot: 'src',
  outputRoot: 'dist',
  framework: 'react',
  compiler: { type: 'webpack5', prebundle: { enable: false } },
  cache: { enable: false },
  defineConstants: {
    VERSEVIVA_API_ORIGIN: JSON.stringify(process.env.TARO_APP_API_ORIGIN ?? ''),
  },
  mini: { postcss: { pxtransform: { enable: true }, cssModules: { enable: false } } },
});
