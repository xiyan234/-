function answer(text, context = {}) {
  const input = String(text || '').trim();
  if (/课表|上课|课程/.test(input)) {
    return `当前是第 ${context.week || 1} 周。你可以在“课表”页切换周次、查看课程详情或添加课程。`;
  }
  if (/记事|待办|提醒/.test(input)) {
    return '你可以在“记事”页新建待办。小程序退出后定时提醒受微信能力限制，请以页面内记录为准。';
  }
  if (/历史/.test(input)) return '点击右上角“历史”即可查看本机保存的最近 100 条对话。';
  return '我可以帮你查询课表入口、记事用法和校园服务。当前小程序版使用本机规则回答，不会把课表或姓名发送给模型。';
}

module.exports = { answer };
