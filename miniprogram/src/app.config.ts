export default defineAppConfig({
  lazyCodeLoading: 'requiredComponents',
  pages: ['pages/index/index', 'pages/practice/index', 'pages/memory/index'],
  window: {
    navigationBarTitleText: '声声不息',
    navigationBarBackgroundColor: '#f2f5f1',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f2f5f1',
  },
});
