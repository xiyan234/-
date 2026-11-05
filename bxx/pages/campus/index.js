const SERVICES = [
  { key: 'online', mark: '书', name: '北化在线', desc: '在线课程与作业', url: 'https://online.buct.edu.cn/' },
  { key: 'jw', mark: '教', name: '教务系统', desc: '课表 · 成绩 · 选课', url: 'https://jwglxt.buct.edu.cn/' },
  { key: 'exam', mark: '考', name: '考试查询', desc: '考试安排与记事提醒', url: '' },
  { key: 'health', mark: '健', name: '健康云', desc: '体质测试与健康数据', url: '' },
  { key: 'library', mark: '藏', name: '图书馆', desc: '馆藏检索与数据库', url: 'https://lib.buct.edu.cn/' },
  { key: 'resource', mark: '钥', name: '电子资源', desc: '统一身份认证入口', url: '' },
  { key: 'portal', mark: '门', name: '信息门户', desc: '校园信息服务', url: '' },
  { key: 'school', mark: '校', name: '学校主页', desc: '通知公告与数字校园', url: 'https://www.buct.edu.cn/' },
  { key: 'network', mark: '链', name: '校园网平台', desc: '网络认证与校园网服务', url: '' }
];

Page({
  data: { services: SERVICES },
  open(event) {
    const item = SERVICES.find((service) => service.key === event.currentTarget.dataset.key);
    if (!item) return;
    if (!item.url) return wx.showToast({ title: '该入口正在适配小程序版', icon: 'none' });
    wx.setClipboardData({ data: item.url, success: () => wx.showToast({ title: '网址已复制', icon: 'success' }) });
  }
});
