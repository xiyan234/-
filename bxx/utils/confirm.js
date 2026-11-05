function confirmDelete({ title, name, count = 1, recoverable = false }) {
  const recovery = recoverable ? '可从备份恢复。' : '删除后无法恢复。';
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: `将删除“${name}”，影响 ${count} 条数据。${recovery}`,
      confirmText: '删除',
      confirmColor: '#ff3b30',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false)
    });
  });
}

function confirmReplace({ title, name, count = 1 }) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content: `将用“${name}”覆盖现有 ${count} 条课程及课表设置，操作无法恢复。`,
      confirmText: '继续',
      confirmColor: '#ff3b30',
      success: (result) => resolve(Boolean(result.confirm)),
      fail: () => resolve(false)
    });
  });
}

module.exports = { confirmDelete, confirmReplace };
