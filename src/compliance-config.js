// 合规页面里"只有运营者才知道"的信息，集中放在这里。
// 值为 null 表示尚未确定：页面会显示"待补充"占位，而不是编造一个看起来像真的答案。
// 上线前必须由实际运营主体逐项填写，并同步更新《产品记录.md》的合规清单章节。

export const COMPLIANCE_CONFIG = {
  operatorName: null,        // 运营者/开发者法定主体名称
  contactEmail: null,        // 个人信息保护相关联系邮箱
  contactOther: null,        // 其它联系方式（可选）
  effectiveDate: null,       // 本说明生效日期，如 "2026-09-01"
  hostingProvider: null,     // 静态托管服务商，如 "GitHub Pages" / "自建 Nginx"
  icpFiling: null,           // 备案号（如适用）
  jurisdiction: null,        // 主要适用地区，如 "中国内地"
  policyVersion: "2026-08-20-identity-1"
};

export const PENDING_LABEL = "待运营者补充";

export function complianceValue(key) {
  const value = COMPLIANCE_CONFIG[key];
  if (value === null || value === undefined || value === "") return PENDING_LABEL;
  return String(value);
}

export function isPending(key) {
  const value = COMPLIANCE_CONFIG[key];
  return value === null || value === undefined || value === "";
}

export function pendingKeys() {
  return Object.keys(COMPLIANCE_CONFIG).filter(isPending);
}

// 个人信息收集清单。每一项都对应代码里真实存在的字段。
export const COLLECTION_INVENTORY = [
  {
    item: "学生姓名或昵称",
    field: "scornal.settings → studentName",
    source: "用户在首页或个人中心主动填写",
    purpose: "在成绩簿标题、资料卡与分享长图上显示",
    required: "非必需，留空也能正常记录成绩",
    handling: "明文保存在本机浏览器 localStorage，不做画像、不做分析",
    location: "本机浏览器 localStorage",
    retention: "保存到用户自行修改或清除为止",
    deletion: "个人中心 →「清除身份信息」或「清除全部本机数据」",
    shared: "否"
  },
  {
    item: "自定义头像（本机照片）",
    field: "IndexedDB scornal-records → customAvatars",
    source: "用户点击「从相册选择」后，由系统文件选择器交给网页的那一个文件",
    purpose: "作为头像显示在封面、首页、资料卡、成绩详情与分享长图上",
    required: "非必需，可只用内置插画头像或 emoji",
    handling: "在浏览器本机完成解码、裁切与重新编码；Canvas 重编码后不含 EXIF/GPS 等元数据；原始照片不保存",
    location: "本机浏览器 IndexedDB（最多 6 张）",
    retention: "保存到用户删除为止",
    deletion: "头像装扮面板内逐张删除，或「删除当前自定义头像」「清除身份信息」「清除全部本机数据」",
    shared: "否。仅当用户在导出时主动勾选「包含自定义头像」，才会写入用户自己保存的备份文件"
  },
  {
    item: "内置头像与边框选择",
    field: "scornal.settings → avatarId / frameId / avatarSource / avatar",
    source: "用户在头像装扮面板中选择",
    purpose: "记住装扮偏好，在各处一致显示",
    required: "非必需，有默认值",
    handling: "只保存选项标识符，不含图片本身",
    location: "本机浏览器 localStorage",
    retention: "保存到用户修改或清除为止",
    deletion: "「恢复默认」「清除身份信息」或「清除全部本机数据」",
    shared: "否"
  },
  {
    item: "选科设置",
    field: "scornal.settings → selectedSubjects",
    source: "用户在选科弹窗中勾选",
    purpose: "决定显示哪些科目、计算总分满分",
    required: "核心功能必需（未设置时使用默认小科）",
    handling: "只保存科目标识符数组",
    location: "本机浏览器 localStorage",
    retention: "保存到用户修改或清除为止",
    deletion: "「清除全部本机数据」",
    shared: "否"
  },
  {
    item: "考试分数与校排",
    field: "IndexedDB scornal-records → examRecords",
    source: "用户逐次手动录入",
    purpose: "生成成绩列表、详情、趋势图与分析页",
    required: "核心功能必需",
    handling: "原样保存在本机数据库，所有统计都在本机计算",
    location: "本机浏览器 IndexedDB",
    retention: "保存到用户删除记录或清除数据为止",
    deletion: "在列表中逐条删除，或「清除全部本机数据」",
    shared: "否"
  },
  {
    item: "分享寄语",
    field: "scornal.settings → shareMessage",
    source: "用户在生成分享长图时选填",
    purpose: "印在分享长图上",
    required: "非必需",
    handling: "明文保存在本机，供下次沿用",
    location: "本机浏览器 localStorage",
    retention: "保存到用户修改或清除为止",
    deletion: "「清除全部本机数据」",
    shared: "否。长图由用户自己决定是否发送给他人"
  },
  {
    item: "应用视图与本地设置",
    field: "sessionStorage：scornal.enteredThisSession / scornal.activeView / scornal.editRecordId",
    source: "由应用在使用过程中自动记录",
    purpose: "刷新后回到上次所在页面，属于界面状态",
    required: "非必需，缺失时回到首页",
    handling: "只保存页面名称与记录 id，不含成绩内容",
    location: "本机浏览器 sessionStorage，关闭标签页即失效",
    retention: "当前会话内",
    deletion: "关闭标签页，或「清除全部本机数据」",
    shared: "否"
  }
];
