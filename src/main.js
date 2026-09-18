const RECENT_LIMIT = 10;
const SETTINGS_STORAGE_KEY = "scornal.settings";
import { createAvatarSystem } from "./avatar-system.js";
import {
  isCustomAvatarId,
  upgradeCustomAvatarStore,
  validateCustomAvatarBackup
} from "./avatar-storage.js";
import {
  COLLECTION_INVENTORY,
  PENDING_LABEL,
  complianceValue,
  isPending
} from "./compliance-config.js";

const SESSION_ENTERED_KEY = "scornal.enteredThisSession";
const SESSION_VIEW_KEY = "scornal.activeView";
const SESSION_EDIT_RECORD_KEY = "scornal.editRecordId";
const DB_NAME = "scornal-records";
// v3：新增 customAvatars store 存放裁切后的头像 Blob，examRecords 原样保留
const DB_VERSION = 3;
const RECORD_STORE = "examRecords";
const BACKUP_MIME_TYPE = "application/json";
const SERVICE_WORKER_VERSION = "2026-08-20-identity-1";
const MODAL_OPEN_CLASS = "modal-open";
function runtimeErrorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error.message === "string") return error.message;
  return String(error || "Unknown runtime error");
}

function showRuntimeError(error, source = "") {
  const text = runtimeErrorText(error);
  const sourceText = source ? `\n${source}` : "";
  const detail = `${text}${sourceText}`;
  if (!document.body) {
    console.error(detail);
    return null;
  }

  let panel = document.querySelector("[data-runtime-error-panel]");
  if (!panel) {
    panel = document.createElement("button");
    panel.type = "button";
    panel.setAttribute("data-runtime-error-panel", "");
    panel.setAttribute("aria-label", "关闭运行时错误提示");
    panel.style.cssText = [
      "position:fixed",
      "left:12px",
      "right:12px",
      "top:12px",
      "z-index:99999",
      "padding:12px 14px",
      "border:2px solid #ffb3b3",
      "border-radius:12px",
      "background:#a40000",
      "color:#fff",
      "font:13px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace",
      "white-space:pre-wrap",
      "text-align:left",
      "box-shadow:0 12px 28px rgba(0,0,0,0.24)",
      "cursor:pointer"
    ].join(";");
    panel.addEventListener("click", () => panel.remove());
    document.body.appendChild(panel);
  }
  panel.textContent = detail;
  panel.hidden = false;
  return panel;
}

window.addEventListener("error", (event) => {
  const location = [event.filename, event.lineno, event.colno].filter(Boolean).join(":");
  showRuntimeError(event.error || event.message, location);
});

window.addEventListener("unhandledrejection", (event) => {
  showRuntimeError(event.reason, "unhandledrejection");
});

const activeViews = {
  dashboard: "dashboard",
  add: "add-record",
  list: "grade-list",
  detail: "exam-detail",
  analysis: "analysis",
  edit: "edit",
  profile: "profile"
};

const scorePlaceholders = {
  chinese: "118.5",
  math: "142",
  english: "136.5",
  physics: "93",
  chemistry: "92.5",
  biology: "94",
  history: "88",
  politics: "90",
  geography: "86",
  total: "621.5"
};

// 赋分输入框占位（6门小科+总分）
const assignedPlaceholders = {
  physics: "赋分 92", chemistry: "赋分 88", biology: "赋分 90",
  history: "赋分 87", politics: "赋分 91", geography: "赋分 89",
  total: "赋分总分 638"
};

// —— 科目体系：语数英必选固定 + 小科池(6选N) + 总分 ——
const CORE_SUBJECTS = [
  { id: "chinese", name: "语文", fullMark: 150, color: "#d56f59" },
  { id: "math", name: "数学", fullMark: 150, color: "#386a59" },
  { id: "english", name: "英语", fullMark: 150, color: "#4b76a8" }
];

// 小科池：物化生史政地，各满分 100，按此固定顺序显示与勾选
const ELECTIVE_POOL = [
  { id: "physics", name: "物理", fullMark: 100, color: "#7463a5" },
  { id: "chemistry", name: "化学", fullMark: 100, color: "#c58b2a" },
  { id: "biology", name: "生物", fullMark: 100, color: "#5e8c50" },
  { id: "history", name: "历史", fullMark: 100, color: "#a75d67" },
  { id: "politics", name: "政治", fullMark: 100, color: "#835b8d" },
  { id: "geography", name: "地理", fullMark: 100, color: "#3f8584" }
];

const TOTAL_SUBJECT = { id: "total", name: "总分", color: "#203c33" };
const DEFAULT_SUBJECT_COLOR = TOTAL_SUBJECT.color;
const CORE_FULL_MARK_SUM = CORE_SUBJECTS.reduce((sum, subject) => sum + subject.fullMark, 0); // 450
const ELECTIVE_FULL_MARK = 100;
const DEFAULT_ELECTIVE_IDS = ["physics", "chemistry", "biology"];

const CORE_SUBJECT_IDS = CORE_SUBJECTS.map((subject) => subject.id);
const ELECTIVE_POOL_IDS = ELECTIVE_POOL.map((subject) => subject.id);
const subjectDefById = new Map(
  [...CORE_SUBJECTS, ...ELECTIVE_POOL, TOTAL_SUBJECT].map((subject) => [subject.id, subject])
);

// 用户已选的小科 id 数组（按小科池固定顺序返回）；未配置时回退默认小科
function getSelectedElectiveIds() {
  const settings = readSettings();
  const stored = Array.isArray(settings.selectedSubjects) ? settings.selectedSubjects : DEFAULT_ELECTIVE_IDS;
  const unique = Array.from(new Set(stored.filter((id) => ELECTIVE_POOL_IDS.includes(id))));
  return ELECTIVE_POOL_IDS.filter((id) => unique.includes(id));
}

// settings 里没有选科字段时视为首次（触发选科引导）
function hasChosenSubjects() {
  return Array.isArray(readSettings().selectedSubjects);
}

function setSelectedElectiveIds(ids) {
  const settings = readSettings();
  const allowed = Array.isArray(ids) ? ids.filter((id) => ELECTIVE_POOL_IDS.includes(id)) : [];
  settings.selectedSubjects = ELECTIVE_POOL_IDS.filter((id) => allowed.includes(id));
  writeSettings(settings);
  return settings.selectedSubjects;
}

// 总分满分 = 语数英(450) + 选中小科数 × 100
function getTotalFullMark() {
  return CORE_FULL_MARK_SUM + getSelectedElectiveIds().length * ELECTIVE_FULL_MARK;
}

// 当前生效科目列表：语文、数学、英语 + 选中小科(池序) + 总分(末位)
function getActiveSubjects() {
  const selectedIds = getSelectedElectiveIds();
  const electives = ELECTIVE_POOL.filter((subject) => selectedIds.includes(subject.id));
  return [...CORE_SUBJECTS, ...electives, { ...TOTAL_SUBJECT, fullMark: getTotalFullMark() }];
}

// 取某科定义；总分的 fullMark 按当前选科动态计算
function getSubject(subjectId) {
  if (subjectId === "total") return { ...TOTAL_SUBJECT, fullMark: getTotalFullMark() };
  return subjectDefById.get(subjectId);
}

function getTrendSubject(subjectId) {
  const subject = getSubject(subjectId);
  if (!subject) throw new Error(`未找到趋势科目：${subjectId || "空"}`);

  const subjectFullMark = Number(subject.fullMark);
  const fullMark = Number.isFinite(subjectFullMark) && subjectFullMark > 0
    ? subjectFullMark
    : subject.id === "total"
      ? getTotalFullMark()
      : ELECTIVE_FULL_MARK;
  const color = typeof subject.color === "string" && subject.color.trim()
    ? subject.color
    : DEFAULT_SUBJECT_COLOR;

  return {
    ...subject,
    id: subject.id || subjectId,
    name: subject.name || "未知科目",
    fullMark,
    color
  };
}

// 只有有限数字才算有效填写；0 分是有效成绩，不能用 if(value) 判断
function hasValidScore(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// 安全读取某记录的赋分对象；旧记录没有 assignedScores 时返回空对象，绝不报错
function getAssignedScores(record) {
  return (record && record.assignedScores) ? record.assignedScores : {};
}

function sumScoreValues(subjects, valueForSubject) {
  let total = 0;
  let hasAny = false;
  subjects.forEach((subject) => {
    if (subject.id === "total") return;
    const value = valueForSubject(subject);
    if (!hasValidScore(value)) return;
    total += value;
    hasAny = true;
  });
  return hasAny ? total : null;
}

function computeRawTotal(record) {
  return sumScoreValues(getActiveSubjects(), (subject) => record?.scores?.[subject.id]);
}

function computeAssignedTotal(record) {
  const assignedScores = getAssignedScores(record);
  const anyElectiveAssigned = getSelectedElectiveIds().some((id) => hasValidScore(assignedScores[id]));
  if (!anyElectiveAssigned) return null;
  return sumScoreValues(getActiveSubjects(), (subject) => {
    if (CORE_SUBJECT_IDS.includes(subject.id)) return record?.scores?.[subject.id];
    return assignedScores[subject.id];
  });
}

function writeComputedTotals(scores, assignedScores) {
  const totalRecord = { scores, assignedScores };
  scores.total = computeRawTotal(totalRecord);
  assignedScores.total = computeAssignedTotal(totalRecord);
}

// 返回该科在某记录里应显示的分数结构；语数英只显示原始分，6 小科与总分显示原始分/赋分双轨
function getSubjectScoreDisplay(record, subjectId) {
  const isTotal = subjectId === "total";
  const rawValue = isTotal ? computeRawTotal(record) : record?.scores?.[subjectId];
  const assignedValue = isTotal ? computeAssignedTotal(record) : getAssignedScores(record)[subjectId];
  const isCore = CORE_SUBJECT_IDS.includes(subjectId);
  const hasRaw = hasValidScore(rawValue);
  const hasAssigned = !isCore && hasValidScore(assignedValue);

  return {
    hasAny: hasRaw || hasAssigned,
    hasRaw,
    hasAssigned,
    rawValue,
    assignedValue,
    rawText: hasRaw ? formatNumber(rawValue) : "",
    assignedText: hasAssigned ? formatNumber(assignedValue) : "",
    isCore
  };
}

function getSubjectScoreComparison(record, previous, subjectId) {
  const current = getSubjectScoreDisplay(record, subjectId);
  const last = previous ? getSubjectScoreDisplay(previous, subjectId) : null;
  const hasDifferentSingleTrack = Boolean(last) && !current.isCore && (
    (current.hasRaw && !current.hasAssigned && !last.hasRaw && last.hasAssigned) ||
    (current.hasAssigned && !current.hasRaw && last.hasRaw && !last.hasAssigned)
  );

  return {
    rawDelta: current.hasRaw && last?.hasRaw ? scoreDeltaText(current.rawValue, last.rawValue) : null,
    assignedDelta: current.hasAssigned && last?.hasAssigned ? scoreDeltaText(current.assignedValue, last.assignedValue) : null,
    mismatchText: hasDifferentSingleTrack ? "口径不同，暂不比较" : ""
  };
}

const seedExams = [
  {
    date: "2025-09-18", shortName: "一上入学测",
    scores: { chinese: 116, math: 124, english: 121.5, physics: 74, chemistry: 76, biology: 75, history: 78, politics: 72, geography: 77, total: 587.5 },
    ranks: { chinese: 78, math: 55, english: 63, physics: 98, chemistry: 92, biology: 94, history: 86, politics: 105, geography: 90, total: 76 }
  },
  {
    date: "2025-10-12", shortName: "一上月考1",
    scores: { chinese: 118.5, math: 128, english: 124, physics: 78, chemistry: 79, biology: 80, history: 81, politics: 75, geography: 80, total: 607.5 },
    ranks: { chinese: 70, math: 48, english: 57, physics: 84, chemistry: 80, biology: 76, history: 72, politics: 94, geography: 78, total: 62 }
  },
  {
    date: "2025-11-07", shortName: "一上期中",
    scores: { chinese: 122, math: 132, english: 126, physics: 82, chemistry: 84, biology: 83, history: 84, politics: 79, geography: 83, total: 629 },
    ranks: { chinese: 54, math: 39, english: 49, physics: 70, chemistry: 58, biology: 62, history: 61, politics: 79, geography: 64, total: 46 }
  },
  {
    date: "2025-12-02", shortName: "一上月考2",
    scores: { chinese: 119, math: 126.5, english: 129, physics: 84, chemistry: 82, biology: 85, history: 86, geography: 84, total: 630.5 },
    assignedScores: { physics: 88, chemistry: 86, biology: 89, history: 90, geography: 88, total: 649.5 },
    ranks: { chinese: 66, math: 58, english: 43, physics: 58, chemistry: 67, biology: 52, history: 49, geography: 57, total: 50 }
  },
  {
    date: "2026-01-16", shortName: "一上期末",
    scores: { chinese: 125, math: 135, english: 130, physics: 87, chemistry: 86, biology: 86, history: 88, politics: 84, geography: 87, total: 653 },
    assignedScores: { physics: 91, chemistry: 90, biology: 90, history: 92, politics: 88, geography: 91, total: 670 },
    ranks: { chinese: 39, math: 31, english: 36, physics: 44, chemistry: 48, biology: 50, history: 41, politics: 55, geography: 44, total: 34 }
  },
  {
    date: "2026-03-08", shortName: "一下开学测",
    scores: { chinese: 121.5, math: 130, english: 128, physics: 83, biology: 88, history: 86, politics: 82, geography: 85, total: 636.5 },
    assignedScores: { physics: 87, chemistry: 89, biology: 92, history: 90, politics: 86, geography: 89, total: 656.5 },
    ranks: { chinese: 52, math: 44, english: 45, physics: 68, chemistry: 53, biology: 42, history: 50, politics: 62, geography: 54, total: 49 }
  },
  {
    date: "2026-03-29", shortName: "一下月考1",
    scores: { chinese: 124, math: 137, english: 132.5, physics: 89, chemistry: 88, biology: 90, history: 90, politics: 87, total: 663.5 },
    assignedScores: { physics: 93, chemistry: 92, biology: 94, history: 94, politics: 91, total: 681.5 },
    ranks: { chinese: 41, math: 26, english: 31, physics: 36, chemistry: 40, biology: 33, history: 35, politics: 39, total: 29 }
  },
  {
    date: "2026-04-23", shortName: "一下期中",
    scores: { chinese: 126.5, math: 141, english: 134, physics: 91, chemistry: 90, biology: 91, history: 92, politics: 90, geography: 91 },
    assignedScores: { physics: 95, chemistry: 94, biology: 95, history: 96, politics: 94, geography: 95, total: 696.5 },
    ranks: { chinese: 33, math: 19, english: 24, physics: 28, chemistry: 31, biology: 29, history: 27, politics: 30, geography: 29, total: 21 }
  },
  {
    date: "2026-05-20", shortName: "一下月考2",
    scores: { chinese: 123, math: 138.5, english: 131, physics: 90, chemistry: 91, biology: 89, history: 91, politics: 88, geography: 90, total: 668.5 },
    assignedScores: { physics: 94, chemistry: 95, biology: 93, history: 95, politics: 92, geography: 94, total: 686.5 },
    ranks: { chinese: 46, math: 24, english: 35, physics: 31, chemistry: 27, biology: 38, history: 32, politics: 37, geography: 34, total: 27 }
  },
  {
    date: "2026-06-10", shortName: "二上月考1",
    scores: { chinese: 128, math: 142, english: 136, physics: 93, chemistry: 92, biology: 93, history: 94, politics: 92, geography: 93, total: 691 },
    assignedScores: { physics: 97, chemistry: 96, biology: 97, history: 98, politics: 96, geography: 97, total: 708 },
    ranks: { chinese: 27, math: 16, english: 19, physics: 21, chemistry: 23, biology: 20, history: 18, politics: 21, geography: 19, total: 15 }
  },
  {
    date: "2026-06-29", shortName: "二上月考2",
    scores: { chinese: 130, math: 139, english: 137.5, physics: 92, chemistry: 94, biology: 92, history: 95, politics: 93, geography: 94, total: 693.5 },
    assignedScores: { physics: 96, chemistry: 98, biology: 96, history: 99, politics: 97, geography: 98, total: 710.5 },
    ranks: { chinese: 20, math: 25, english: 17, physics: 24, chemistry: 18, biology: 26, history: 15, politics: 18, geography: 16, total: 16 }
  },
  {
    date: "2026-07-09", shortName: "期末模拟",
    scores: { chinese: 132.5, math: 145, english: 139, physics: 95, chemistry: 93, biology: 94, history: 96, politics: 94, geography: 95, total: 704.5 },
    assignedScores: { physics: 99, chemistry: 97, biology: 98, history: 100, politics: 98, geography: 99, total: 721.5 },
    ranks: { chinese: 16, math: 11, english: 14, physics: 12, chemistry: 19, biology: 15, history: 10, politics: 14, geography: 12, total: 9 }
  }
];
let recordsDatabase;
let sortedExams = [];
let pendingDeleteId = "";
let editingRecordId = "";
let viewingRecordId = "";

let avatarSystem = null;
const app = document.querySelector("#app");
const homeScreen = document.querySelector(".home-screen");
const enterButton = document.querySelector("[data-enter]");
const replayCoverButton = document.querySelector("[data-replay-cover]");
const showAddButton = document.querySelector("[data-show-add]");
const showListButton = document.querySelector("[data-show-list]");
const showAnalysisButton = document.querySelector("[data-show-analysis]");
const showDashboardButton = document.querySelector("[data-show-dashboard]");
const showAddFromListButton = document.querySelector("[data-show-add-from-list]");
const showDashboardFromListButton = document.querySelector("[data-show-dashboard-from-list]");
const subjectGrid = document.querySelector("[data-subject-grid]");
const modalLayer = document.querySelector("[data-modal]");
const modalTitle = document.querySelector("[data-modal-title]");
const modalSubtitle = document.querySelector("[data-modal-subtitle]");
const chart = document.querySelector("[data-chart]");
const chartScroll = document.querySelector("[data-chart-scroll]");
const chartHelp = document.querySelector("[data-chart-help]");
const showAllInput = document.querySelector("[data-show-all]");
const pointSummary = document.querySelector("[data-point-summary]");
const metricTabs = document.querySelector("[data-metric-tabs]");
let metricButtons = Array.from(document.querySelectorAll("[data-metric]"));
const studentNameElements = Array.from(document.querySelectorAll("[data-student-name]"));
const addPage = document.querySelector("[data-add-page]");
const listPage = document.querySelector("[data-list-page]");
const recordForm = document.querySelector("[data-record-form]");
const recordStatus = document.querySelector("[data-record-status]");
const analysisPage = document.querySelector("[data-analysis-page]");
const showDashboardFromAnalysisButton = document.querySelector("[data-show-dashboard-from-analysis]");
const analysisSummary = document.querySelector("[data-analysis-summary]");
const progressBoard = document.querySelector("[data-progress-board]");
const regressionBoard = document.querySelector("[data-regression-board]");
const analysisCompare = document.querySelector("[data-analysis-compare]");
const gradeList = document.querySelector("[data-grade-list]");
const gradeListScroll = document.querySelector("[data-grade-list-scroll]");
const listSummary = document.querySelector("[data-list-summary]");
const listShowAllInput = document.querySelector("[data-list-show-all]");
const editPanel = document.querySelector("[data-edit-panel]");
const detailPage = document.querySelector("[data-detail-page]");
const detailTitle = document.querySelector("[data-detail-title]");
const detailDate = document.querySelector("[data-detail-date]");
const detailMeta = document.querySelector("[data-detail-meta]");
const detailSubjects = document.querySelector("[data-detail-subjects]");
const detailEditButton = document.querySelector("[data-detail-edit]");
const detailBackButton = document.querySelector("[data-detail-back]");
const shareExamButton = document.querySelector("[data-share-exam]");
const shareAnalysisButton = document.querySelector("[data-share-analysis]");
const exportRecordsButton = document.querySelector("[data-export-records]");
const importRecordsButton = document.querySelector("[data-import-records]");
const importFileInput = document.querySelector("[data-import-file]");
const importReplaceInput = document.querySelector("[data-import-replace]");
const backupPanel = document.querySelector("[data-backup-panel]");
const backupStatus = document.querySelector("[data-backup-status]");
const includeAvatarsInput = document.querySelector("[data-include-avatars]");
const privacyStatus = document.querySelector("[data-privacy-status]");

function setPrivacyStatus(message, tone = "info") {
  if (!privacyStatus) return;
  privacyStatus.textContent = message || "";
  privacyStatus.dataset.tone = tone;
}
const shareModal = document.querySelector("[data-share-modal]");
const shareTitle = document.querySelector("[data-share-title]");
const shareSubtitle = document.querySelector("[data-share-subtitle]");
const sharePreview = document.querySelector("[data-share-preview]");
const shareDownload = document.querySelector("[data-share-download]");
const shareStatus = document.querySelector("[data-share-status]");
const shareMessageInput = document.querySelector("[data-share-message]");
let activeShareKind = null;
let activeShareRecord = null;
let shareMessageTimer = 0;
const profilePage = document.querySelector("[data-profile-page]");
const avatarStudio = document.querySelector("[data-avatar-studio]");
const showProfileButton = document.querySelector("[data-show-profile]");
const showDashboardFromProfileButton = document.querySelector("[data-show-dashboard-from-profile]");
const editNameProfileButton = document.querySelector("[data-edit-name-profile]");
const openPrivacyButton = document.querySelector("[data-open-privacy]");
const exportFromProfileButton = document.querySelector("[data-export-from-profile]");
const appVersionLabel = document.querySelector("[data-app-version]");
const privacyModal = document.querySelector("[data-privacy-modal]");
const scoreRowsContainer = document.querySelector("[data-score-rows]");
const subjectsModal = document.querySelector("[data-subjects-modal]");
const subjectsCoreGrid = document.querySelector("[data-subjects-core]");
const subjectsElectivesGrid = document.querySelector("[data-subjects-electives]");
const subjectsTotalPreview = document.querySelector("[data-subjects-total]");
const subjectsConfirmButton = document.querySelector("[data-subjects-confirm]");
const subjectsCloseButton = document.querySelector("[data-subjects-close]");
const subjectsScrim = document.querySelector("[data-subjects-scrim]");
const subjectsKicker = document.querySelector("[data-subjects-kicker]");
const subjectsTitleEl = document.querySelector("[data-subjects-title]");
const openSubjectsButton = document.querySelector("[data-open-subjects]");
const openSubjectsHeroButton = document.querySelector("[data-open-subjects-hero]");
const subjectsSummaryLabel = document.querySelector("[data-subjects-summary]");
let subjectsModalMode = "onboarding";

const lockableModals = [modalLayer, shareModal, subjectsModal, avatarStudio].filter(Boolean);

function syncModalScrollLock() {
  const hasOpenModal = lockableModals.some((modal) => !modal.hidden);
  document.body.classList.toggle(MODAL_OPEN_CLASS, hasOpenModal);
  document.body.style.overflow = "";
}

function showLockingModal(modal) {
  modal.hidden = false;
  syncModalScrollLock();
}

function hideLockingModal(modal) {
  modal.hidden = true;
  syncModalScrollLock();
}

function unlockTrendModalAfterError() {
  try {
    if (modalLayer) {
      hideLockingModal(modalLayer);
    } else {
      syncModalScrollLock();
    }
  } finally {
    document.body.classList.remove(MODAL_OPEN_CLASS);
    document.body.style.overflow = "";
  }
}

function handleTrendRenderError(error, source) {
  unlockTrendModalAfterError();
  showRuntimeError(error, source);
  console.error(source, error);
}

if (typeof MutationObserver === "function") {
  lockableModals.forEach((modal) => {
    new MutationObserver(syncModalScrollLock).observe(modal, { attributes: true, attributeFilter: ["hidden"] });
  });
}

const modalState = {
  subjectId: "chinese",
  metric: "score",
  showAll: false
};

const trendMetrics = {
  score: { label: "原始分", coreLabel: "分数", emptyText: "还没有记录原始分" },
  assigned: { label: "赋分", emptyText: "还没有记录赋分" },
  rank: { label: "排名", emptyText: "还没有记录校排" }
};

function getTrendMetrics(subjectId) {
  return CORE_SUBJECT_IDS.includes(subjectId) ? ["score", "rank"] : ["score", "assigned", "rank"];
}

function getTrendMetricLabel(subjectId, metric) {
  const config = trendMetrics[metric] || trendMetrics.score;
  return metric === "score" && CORE_SUBJECT_IDS.includes(subjectId) ? config.coreLabel : config.label;
}

function getTrendMetricValue(exam, subjectId, metric) {
  if (!exam) return undefined;
  if (metric === "rank") return exam.ranks?.[subjectId];
  if (subjectId === "total") return metric === "assigned" ? computeAssignedTotal(exam) : computeRawTotal(exam);
  if (metric === "assigned") return getAssignedScores(exam)[subjectId];
  return exam.scores?.[subjectId];
}

function hasTrendData(subjectId, metric, exams = sortedExams) {
  return exams.some((exam) => hasValidScore(getTrendMetricValue(exam, subjectId, metric)));
}

function renderMetricButtons(subjectId, activeMetric) {
  const metrics = getTrendMetrics(subjectId);
  if (metricTabs) {
    metricTabs.innerHTML = metrics.map((metric) => `
      <button type="button" class="${metric === activeMetric ? "is-active" : ""}" data-metric="${metric}">${getTrendMetricLabel(subjectId, metric)}</button>
    `).join("");
  }
  metricButtons = Array.from(document.querySelectorAll("[data-metric]"));
  metricButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.metric === activeMetric));
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  })[character]);
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function parseDisplayDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const compactDate = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  const dateParts = compactDate
    ? [compactDate[1], compactDate[2], compactDate[3]]
    : text
      .replace(/[年月.]/g, "/")
      .replace(/日/g, "")
      .replace(/-/g, "/")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

  if (dateParts.length !== 3) return "";

  const [yearText, monthText, dayText] = dateParts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return "";
  }

  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

function formatDateForDisplay(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}年${match[2]}月${match[3]}日` : "";
}

function syncDateField(displayInput, formatWhenValid = false) {
  const hiddenInput = displayInput.closest(".field-block")?.querySelector("[data-date-value]");
  if (!hiddenInput) return;

  const isoDate = parseDisplayDate(displayInput.value);
  hiddenInput.value = isoDate;
  if (formatWhenValid && isoDate) displayInput.value = formatDateForDisplay(isoDate);
}

function syncDateFields(container, options = {}) {
  const { format = false } = options;
  container.querySelectorAll("[data-date-display]").forEach((input) => syncDateField(input, format));
}

function updateDateHint(displayInput) {
  const wrap = displayInput.closest(".field-block");
  const hint = wrap ? wrap.querySelector("[data-date-hint]") : null;
  if (!hint) return;
  const raw = String(displayInput.value || "").trim();
  if (!raw) { hint.textContent = ""; hint.className = "date-hint"; return; }
  const iso = parseDisplayDate(raw);
  if (iso) {
    hint.textContent = `已识别：${formatDateForDisplay(iso)}`;
    hint.className = "date-hint is-ok";
  } else {
    hint.textContent = "看不懂这个日期，请按 年/月/日 填，例：2026/7/16";
    hint.className = "date-hint is-warn";
  }
}

function markEnteredThisSession() {
  sessionStorage.setItem(SESSION_ENTERED_KEY, "true");
}

function hasEnteredThisSession() {
  return sessionStorage.getItem(SESSION_ENTERED_KEY) === "true";
}

function rememberActiveView(viewId, recordId = "") {
  sessionStorage.setItem(SESSION_VIEW_KEY, viewId);
  if (recordId) {
    sessionStorage.setItem(SESSION_EDIT_RECORD_KEY, recordId);
  } else {
    sessionStorage.removeItem(SESSION_EDIT_RECORD_KEY);
  }
}

function sortRecords(records) {
  return records.slice().sort((a, b) => {
    const dateOrder = new Date(a.date) - new Date(b.date);
    if (dateOrder !== 0) return dateOrder;
    return a.shortName.localeCompare(b.shortName, "zh-CN");
  });
}

function writeSeedRecords(store) {
  const seededAt = new Date().toISOString();
  seedExams.forEach((exam, index) => {
    const scores = { ...exam.scores };
    const assignedScores = { ...(exam.assignedScores || {}) };
    writeComputedTotals(scores, assignedScores);
    store.add({
      id: `seed-${index + 1}`,
      shortName: exam.shortName,
      date: exam.date,
      scores,
      assignedScores,
      ranks: { ...exam.ranks },
      createdAt: seededAt,
      updatedAt: seededAt
    });
  });
}

function replaceSeedRecords(store) {
  const keysRequest = store.getAllKeys();
  keysRequest.onsuccess = () => {
    keysRequest.result
      .filter((key) => String(key).startsWith("seed-"))
      .forEach((key) => store.delete(key));
    writeSeedRecords(store);
  };
}

function openRecordsDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = event.oldVersion || 0;
      const hasRecordStore = database.objectStoreNames.contains(RECORD_STORE);
      const store = hasRecordStore
        ? request.transaction.objectStore(RECORD_STORE)
        : database.createObjectStore(RECORD_STORE, { keyPath: "id" });

      if (!store.indexNames.contains("date")) {
        store.createIndex("date", "date", { unique: false });
      }

      // v3 只新增 object store，不触碰 examRecords 里已有的成绩数据
      upgradeCustomAvatarStore(database);

      if (oldVersion < 1) {
        writeSeedRecords(store);
        return;
      }

      if (oldVersion < 2) {
        replaceSeedRecords(store);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readRecords() {
  const transaction = recordsDatabase.transaction(RECORD_STORE, "readonly");
  const done = transactionDone(transaction);
  const records = await requestToPromise(transaction.objectStore(RECORD_STORE).getAll());
  await done;
  return sortRecords(records.map((record) => {
    const scores = { ...(record.scores || {}) };
    const assignedScores = { ...getAssignedScores(record) };
    writeComputedTotals(scores, assignedScores);
    return { ...record, scores, assignedScores };
  }));
}

async function putRecord(record) {
  const transaction = recordsDatabase.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(RECORD_STORE).put(record);
  await done;
}

async function removeRecord(recordId) {
  const transaction = recordsDatabase.transaction(RECORD_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(RECORD_STORE).delete(recordId);
  await done;
}

function writeImportedRecords(records, replaceExisting) {
  return new Promise((resolve, reject) => {
    const transaction = recordsDatabase.transaction(RECORD_STORE, "readwrite");
    const store = transaction.objectStore(RECORD_STORE);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    if (replaceExisting) store.clear();
    records.forEach((record) => store.put(record));
  });
}

async function refreshRecords() {
  sortedExams = await readRecords();
  renderLatestSnapshot();
  renderSubjectCards();
  renderAnalysisPage();
  renderGradeList();
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function getStudentName() {
  const settings = readSettings();
  return typeof settings.studentName === "string" ? settings.studentName.trim() : "";
}

function renderStudentName() {
  const studentName = getStudentName();
  studentNameElements.forEach((element) => {
    element.textContent = studentName;
    element.classList.toggle("is-empty", !studentName);
    element.setAttribute("aria-label", studentName ? `学生姓名：${studentName}` : "待填写学生姓名");
  });
  const editText = document.querySelector("[data-name-edit-text]");
  if (editText) editText.textContent = studentName ? "改名" : "填写姓名";
  const heading = document.querySelector(".dashboard-hero h2");
  if (heading) heading.classList.toggle("has-name", Boolean(studentName));
  if (typeof renderProfile === "function") renderProfile();
}

window.scornalSetStudentName = (studentName) => {
  const settings = readSettings();
  settings.studentName = String(studentName || "").trim();
  writeSettings(settings);
  renderStudentName();
  return settings.studentName;
};

// —— 学生姓名/昵称 就地编辑(仪表盘标题）——
function renderProfile() {
  avatarSystem?.renderSlots();
  if (appVersionLabel) appVersionLabel.textContent = `成绩留声机 · ${SERVICE_WORKER_VERSION}`;
}

function celebrateStudentName() {
  studentNameElements.forEach((element) => {
    element.classList.remove("is-celebrating");
    void element.offsetWidth;
    element.classList.add("is-celebrating");
    window.setTimeout(() => element.classList.remove("is-celebrating"), 950);
  });
}

function openStudentNameEditor(anchorEl) {
  const maybeEl = (typeof Element !== "undefined" && anchorEl instanceof Element) ? anchorEl : null;
  const heading = maybeEl || document.querySelector(".dashboard-hero h2");
  if (!heading || heading.querySelector(".name-edit-box")) return;
  const box = document.createElement("span");
  box.className = "name-edit-box";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "name-edit-field";
  input.maxLength = 12;
  input.value = getStudentName();
  input.placeholder = "输入姓名或昵称";
  input.setAttribute("aria-label", "学生姓名或昵称");
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "name-edit-ok";
  okBtn.textContent = "✓";
  okBtn.setAttribute("aria-label", "确认保存");
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "name-edit-cancel";
  cancelBtn.textContent = "✕";
  cancelBtn.setAttribute("aria-label", "取消");
  box.appendChild(input);
  box.appendChild(okBtn);
  box.appendChild(cancelBtn);
  heading.classList.add("is-editing-name");
  heading.appendChild(box);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const settings = readSettings();
      settings.studentName = input.value.trim().slice(0, 12);
      writeSettings(settings);
      renderStudentName();
      if (settings.studentName) celebrateStudentName();
    }
    heading.classList.remove("is-editing-name");
    box.remove();
  };
  okBtn.addEventListener("click", () => commit(true));
  cancelBtn.addEventListener("click", () => commit(false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commit(true); }
    else if (event.key === "Escape") { event.preventDefault(); commit(false); }
  });
  // 点到编辑框以外的地方才取消(点✓/✕按钮不算)
  box.addEventListener("focusout", (event) => {
    if (!box.contains(event.relatedTarget)) window.setTimeout(() => commit(false), 0);
  });
}

(() => {
  const editNameButton = document.querySelector("[data-edit-name]");
  if (editNameButton) editNameButton.addEventListener("click", () => openStudentNameEditor());
  const heroName = document.querySelector(".dashboard-hero [data-student-name]");
  if (heroName) heroName.addEventListener("click", () => openStudentNameEditor());
})();

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function shouldTryTextShare() {
  return typeof navigator.share === "function" && (navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
}

function canShareBackupFile(file) {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function isShareAbort(error) {
  return error?.name === "AbortError";
}

function normalizeImportedRecord(record, index) {
  if (!record || typeof record !== "object") throw new Error(`第 ${index + 1} 条记录格式不正确。`);
  const shortName = String(record.shortName || "").trim();
  const date = String(record.date || "").trim();
  const parsedDate = parseDisplayDate(date);
  if (!shortName) throw new Error(`第 ${index + 1} 条记录缺少考试简称。`);
  if (!parsedDate) throw new Error(`第 ${index + 1} 条记录日期格式不正确。`);

  const scores = {};
  const assignedScores = {};
  const ranks = {};
  // 全保留：逐一校验记录里出现的每一科（含未选小科），都写入不删除
  const knownSubjectIds = [...CORE_SUBJECT_IDS, ...ELECTIVE_POOL_IDS];
  knownSubjectIds.forEach((subjectId) => {
    const meta = subjectDefById.get(subjectId);
    const rawScore = record.scores?.[subjectId];
    const rawRank = record.ranks?.[subjectId];
    const hasScore = rawScore !== undefined && rawScore !== null && rawScore !== "";
    const hasRank = rawRank !== undefined && rawRank !== null && rawRank !== "";
    const isCore = CORE_SUBJECT_IDS.includes(subjectId);
    if (!hasScore && !hasRank) {
      // 小科可缺失（旧备份/不同选科）；必选主科缺失才报错
      if (isCore) throw new Error(`第 ${index + 1} 条记录缺少必选科目“${meta.name}”。`);
      return;
    }
    if (hasScore) {
      const score = Number(rawScore);
      if (!Number.isFinite(score) || score < 0 || score > meta.fullMark) {
        throw new Error(`第 ${index + 1} 条记录的${meta.name}分数需在 0-${meta.fullMark} 之间。`);
      }
      scores[subjectId] = score;
    }
    if (hasRank) {
      const rank = Number(rawRank);
      if (!Number.isInteger(rank) || rank < 1 || rank > 200) {
        throw new Error(`第 ${index + 1} 条记录的${meta.name}校排需为 1-200 的整数。`);
      }
      ranks[subjectId] = rank;
    }
  });

  const totalRankValue = record.ranks?.total;
  const hasTotalRank = totalRankValue !== undefined && totalRankValue !== null && totalRankValue !== "";
  if (hasTotalRank) {
    const totalRank = Number(totalRankValue);
    if (!Number.isInteger(totalRank) || totalRank < 1 || totalRank > 200) {
      throw new Error(`第 ${index + 1} 条记录的总分校排需为 1-200 的整数。`);
    }
    ranks.total = totalRank;
  }

  ELECTIVE_POOL_IDS.forEach((subjectId) => {
    const value = record.assignedScores?.[subjectId];
    const hasAssignedScore = value !== undefined && value !== null && value !== "";
    if (!hasAssignedScore) return;
    const assignedScore = Number(value);
    const meta = subjectDefById.get(subjectId);
    if (!Number.isFinite(assignedScore) || assignedScore < 0 || assignedScore > ELECTIVE_FULL_MARK) {
      throw new Error(`第 ${index + 1} 条记录的${meta.name}赋分需在 0-${ELECTIVE_FULL_MARK} 之间。`);
    }
    assignedScores[subjectId] = assignedScore;
  });
  writeComputedTotals(scores, assignedScores);

  const now = new Date().toISOString();
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : makeRecordId(),
    shortName,
    date: parsedDate,
    scores,
    assignedScores,
    ranks,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now
  };
}

function validateImportedPayload(payload) {
  const records = Array.isArray(payload) ? payload : payload?.records;
  if (!Array.isArray(records)) throw new Error("请选择 Scornal 导出的 JSON 文件。未找到 records 数组。");
  if (!records.length) throw new Error("备份文件里没有成绩记录。若要清空，请在列表中逐条删除。");
  return sortRecords(records.map((record, index) => normalizeImportedRecord(record, index)));
}

async function exportRecords() {
  const records = await readRecords();
  const settings = readSettings();
  // 默认不导出照片：照片属于个人信息，且会明显增大备份体积。
  const includeAvatars = Boolean(includeAvatarsInput?.checked);
  const payload = {
    app: "Scornal",
    version: 3,
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    identity: {
      studentName: typeof settings.studentName === "string" ? settings.studentName : "",
      avatarId: settings.avatarId,
      frameId: settings.frameId,
      avatarSource: settings.avatarSource,
      avatar: settings.avatar
    },
    records
  };

  if (includeAvatars && avatarSystem?.storage) {
    const customAvatars = await avatarSystem.storage.serializeForBackup();
    payload.customAvatars = customAvatars;
    payload.customAvatarCount = customAvatars.length;
  }

  const jsonText = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonText], { type: BACKUP_MIME_TYPE });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `scornal-backup-${stamp}.json`;
  const shareTitle = "Scornal 成绩备份";
  const shareText = `Scornal 成绩备份：${records.length} 条记录。`;

  if (typeof File === "function") {
    const file = new File([jsonText], filename, { type: BACKUP_MIME_TYPE });
    if (canShareBackupFile(file)) {
      try {
        await navigator.share({ files: [file], title: shareTitle, text: shareText });
        backupStatus.textContent = `已通过系统分享 ${records.length} 条记录。`;
        return;
      } catch (error) {
        if (isShareAbort(error)) {
          backupStatus.textContent = "IndexedDB 数据已留在本机。";
          return;
        }
      }
    }
  }

  if (shouldTryTextShare()) {
    try {
      await navigator.share({ title: shareTitle, text: `${shareText}\n\n${jsonText}` });
      backupStatus.textContent = `已通过系统分享备份文本，共 ${records.length} 条记录。`;
      return;
    } catch (error) {
      if (isShareAbort(error)) {
        backupStatus.textContent = "IndexedDB 数据已留在本机。";
        return;
      }
    }
  }

  downloadBlob(blob, filename);
  backupStatus.textContent = `已导出 ${records.length} 条记录为 JSON。`;
}

async function importRecordsFromFile(file) {
  backupStatus.textContent = "正在读取备份文件…";
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new Error("JSON 文件无法解析，请重新选择 Scornal 备份。")
  }

  // 先把两部分都校验通过，再动数据库；任何一处不合法都不写入，现有数据保持原样。
  const importedRecords = validateImportedPayload(payload);
  const hasAvatarPayload = Array.isArray(payload?.customAvatars) && payload.customAvatars.length > 0;
  if (hasAvatarPayload && avatarSystem?.storage) {
    validateCustomAvatarBackup(payload.customAvatars);
  }

  const replaceExisting = importReplaceInput.checked;
  await writeImportedRecords(importedRecords, replaceExisting);

  const notes = [];
  if (hasAvatarPayload && avatarSystem?.storage) {
    const restored = await avatarSystem.storage.restoreFromBackup(
      payload.customAvatars,
      replaceExisting ? "replace" : "merge"
    );
    notes.push(`${restored} 张自定义头像`);
  }

  // 旧备份没有 identity 字段：成绩照常恢复，头像沿用本机当前设置。
  if (payload?.identity && typeof payload.identity === "object") {
    const settings = readSettings();
    const identity = payload.identity;
    const next = { ...settings };
    if (typeof identity.studentName === "string" && identity.studentName.trim()) {
      next.studentName = identity.studentName.trim().slice(0, 12);
    }
    if (typeof identity.avatar === "string") next.avatar = identity.avatar;
    if (typeof identity.frameId === "string") next.frameId = identity.frameId;
    // 自定义头像 id 只有在对应 Blob 也恢复了的情况下才接受
    const wantsCustom = isCustomAvatarId(identity.avatarId);
    if (typeof identity.avatarId === "string" && (!wantsCustom || hasAvatarPayload)) {
      next.avatarId = identity.avatarId;
      next.avatarSource = wantsCustom ? "local-album" : "builtin";
    }
    writeSettings(next);
    renderStudentName();
    notes.push("身份设置");
  }

  await avatarSystem?.reloadCustomAvatars();
  await refreshRecords();
  const extra = notes.length ? `，并恢复了${notes.join("、")}` : "";
  backupStatus.textContent = replaceExisting
    ? `已替换恢复 ${importedRecords.length} 条记录${extra}。`
    : `已合并导入 ${importedRecords.length} 条记录${extra}。`;
}

// —— 数据删除 ——
// 三个层级：只删当前照片 / 删身份信息 / 删本机全部数据。

async function deleteCurrentCustomAvatar() {
  const identity = avatarSystem?.getIdentity();
  if (!identity || !isCustomAvatarId(identity.avatarId)) {
    setPrivacyStatus("当前使用的不是自定义头像，无需删除。");
    return;
  }
  if (!window.confirm("删除当前自定义头像？这张照片会从本机移除，不可恢复。")) return;
  await avatarSystem.storage.remove(identity.avatarId);
  const settings = readSettings();
  writeSettings({
    ...settings,
    avatarId: avatarSystem.catalog.defaultAvatarId || "panda",
    avatarSource: "builtin",
    avatarVariantId: undefined
  });
  await avatarSystem.reloadCustomAvatars();
  setPrivacyStatus("已删除当前自定义头像，并切回默认头像。");
}

async function clearIdentityData() {
  if (!window.confirm("清除身份信息？姓名、头像与边框选择会被删除，成绩记录保留。此操作不可恢复。")) return;
  if (avatarSystem?.storage) await avatarSystem.storage.clear();
  const settings = readSettings();
  // 只摘掉身份相关字段，选科等设置保留
  const kept = { ...settings };
  delete kept.studentName;
  delete kept.avatar;
  delete kept.avatarId;
  delete kept.frameId;
  delete kept.avatarVariantId;
  delete kept.avatarSource;
  writeSettings(kept);
  renderStudentName();
  await avatarSystem?.reloadCustomAvatars();
  setPrivacyStatus("已清除姓名与头像装扮，成绩记录仍然保留。");
}

function deleteRecordsDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(); // 其它标签页占用时也继续，关闭后即生效
  });
}

async function clearAllLocalData() {
  const first = window.confirm(
    "清除全部本机数据？成绩记录、姓名、头像照片、选科与所有设置都会被删除。此操作不可恢复，且不会影响你已导出的备份文件。"
  );
  if (!first) return;
  const second = window.confirm("再确认一次：真的要删除本机全部 Scornal 数据吗？删除后无法恢复。");
  if (!second) return;

  setPrivacyStatus("正在清除本机数据…");
  try {
    // 顺序：先释放 Object URL 与句柄，再删库，最后清 localStorage 与缓存
    avatarSystem?.storage?.releaseAllUrls();
    if (recordsDatabase) {
      recordsDatabase.close();
      recordsDatabase = null;
    }
    await deleteRecordsDatabase();
    localStorage.removeItem(SETTINGS_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_ENTERED_KEY);
    sessionStorage.removeItem(SESSION_VIEW_KEY);
    sessionStorage.removeItem(SESSION_EDIT_RECORD_KEY);
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("scornal")).map((key) => caches.delete(key)));
    }
    setPrivacyStatus("已清除本机全部数据，正在重新载入…");
    window.setTimeout(() => window.location.reload(), 600);
  } catch (error) {
    setPrivacyStatus(`清除失败：${error?.message || error}`, "error");
  }
}

// —— 隐私与合规页面 ——

function escapeComplianceHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderComplianceInventory() {
  const host = document.querySelector("[data-privacy-inventory]");
  if (!host) return;
  host.innerHTML = COLLECTION_INVENTORY.map((entry) => `
    <article class="inventory-card">
      <h5>${escapeComplianceHtml(entry.item)}</h5>
      <dl>
        <div><dt>存储位置</dt><dd>${escapeComplianceHtml(entry.location)}</dd></div>
        <div><dt>字段</dt><dd><code>${escapeComplianceHtml(entry.field)}</code></dd></div>
        <div><dt>来源</dt><dd>${escapeComplianceHtml(entry.source)}</dd></div>
        <div><dt>用途</dt><dd>${escapeComplianceHtml(entry.purpose)}</dd></div>
        <div><dt>是否必需</dt><dd>${escapeComplianceHtml(entry.required)}</dd></div>
        <div><dt>处理方式</dt><dd>${escapeComplianceHtml(entry.handling)}</dd></div>
        <div><dt>保存期限</dt><dd>${escapeComplianceHtml(entry.retention)}</dd></div>
        <div><dt>删除方式</dt><dd>${escapeComplianceHtml(entry.deletion)}</dd></div>
        <div><dt>是否对外提供</dt><dd>${escapeComplianceHtml(entry.shared)}</dd></div>
      </dl>
    </article>
  `).join("");
}

function renderComplianceValues() {
  document.querySelectorAll("[data-compliance]").forEach((node) => {
    const key = node.dataset.compliance;
    node.textContent = complianceValue(key);
    node.classList.toggle("is-pending", isPending(key));
  });
  const pendingLabel = document.querySelector("[data-pending-label]");
  if (pendingLabel) pendingLabel.textContent = PENDING_LABEL;
  const versionDetail = document.querySelector("[data-app-version-detail]");
  if (versionDetail) versionDetail.textContent = `成绩留声机 · ${SERVICE_WORKER_VERSION}`;
}

function selectPrivacySection(sectionId) {
  document.querySelectorAll("[data-privacy-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.privacyTab === sectionId);
  });
  document.querySelectorAll("[data-privacy-section]").forEach((section) => {
    section.hidden = section.dataset.privacySection !== sectionId;
  });
  document.querySelector(".privacy-body")?.scrollTo({ top: 0 });
}

document.querySelectorAll("[data-privacy-tab]").forEach((button) => {
  button.addEventListener("click", () => selectPrivacySection(button.dataset.privacyTab));
});

function hasDraggedFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function isJsonBackupFile(file) {
  const mimeType = file.type.toLowerCase();
  return file.name.toLowerCase().endsWith(".json") || mimeType === BACKUP_MIME_TYPE;
}

function setBackupDropState(isActive) {
  backupPanel.classList.toggle("is-drag-over", isActive);
}

async function importDroppedBackupFile(file) {
  if (!isJsonBackupFile(file)) {
    backupStatus.textContent = "导入失败：请拖入 .json 格式的 Scornal 备份文件。";
    return;
  }

  try {
    await importRecordsFromFile(file);
  } catch (error) {
    backupStatus.textContent = `导入失败：${error.message}`;
  }
}

let sharePreviewUrl = "";
let shareLastFocusedElement = null;
let shareActionState = null;

const shareActionModes = {
  download: "download",
  share: "share",
  longPress: "longPress"
};

const shareCanvasTheme = {
  width: 390,
  padding: 24,
  background: "#f4f2ea",
  paper: "#ffffff",
  paperDeep: "#e8ece8",
  ink: "#183a32",
  muted: "#6b756f",
  line: "rgba(32, 60, 51, 0.16)",
  sage: "#386a59",
  clay: "#d56f59",
  rose: "#e3a39a"
};

const shareFontStack = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const shareSerifStack = 'Georgia, "Times New Roman", "Microsoft YaHei", serif';
const SHARE_MESSAGE_MAX = 40;
const shareMeasureContext = document.createElement("canvas").getContext("2d");

function getShareMessage() {
  const settings = readSettings();
  return typeof settings.shareMessage === "string" ? settings.shareMessage.trim() : "";
}

function getShareMessageMetrics() {
  const message = getShareMessage();
  if (!message) return { height: 0, lines: [] };
  const innerWidth = shareCanvasTheme.width - shareCanvasTheme.padding * 2 - 44;
  shareMeasureContext.font = `15px ${shareFontStack}`;
  const lines = measureWrappedLines(shareMeasureContext, message, innerWidth).slice(0, 2);
  return { height: 20 + 62 + lines.length * 24, lines };
}

function getStudentShortName() {
  const studentName = getStudentName();
  return studentName ? studentName : "同学";
}

function previousExamFor(record) {
  const recordIndex = sortedExams.findIndex((exam) => exam.id === record.id);
  return recordIndex > 0 ? sortedExams[recordIndex - 1] : null;
}

function measureWrappedLines(context, text, maxWidth) {
  const source = String(text || "");
  const lines = [];
  let currentLine = "";

  Array.from(source).forEach((character) => {
    const nextLine = `${currentLine}${character}`;
    if (currentLine && context.measureText(nextLine).width > maxWidth) {
      lines.push(currentLine);
      currentLine = character;
    } else {
      currentLine = nextLine;
    }
  });

  if (currentLine) lines.push(currentLine);
  return lines.length ? lines : [""];
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight) {
  const lines = measureWrappedLines(context, text, maxWidth);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function drawFittedText(context, text, x, y, maxWidth) {
  const source = String(text || "");
  if (context.measureText(source).width <= maxWidth) {
    context.fillText(source, x, y);
    return;
  }

  let fitted = source;
  while (fitted.length > 1 && context.measureText(`${fitted}…`).width > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  context.fillText(`${fitted}…`, x, y);
}

function roundedRectPath(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function fillRoundedRect(context, x, y, width, height, radius, fillStyle, strokeStyle) {
  roundedRectPath(context, x, y, width, height, radius);
  context.fillStyle = fillStyle;
  context.fill();
  if (strokeStyle) {
    context.strokeStyle = strokeStyle;
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawShareBackground(context, width, height) {
  context.fillStyle = shareCanvasTheme.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(56, 106, 89, 0.10)";
  context.fillRect(0, 0, 9, height);
  context.fillStyle = "rgba(213, 111, 89, 0.08)";
  context.fillRect(width - 5, 0, 5, height);
  context.strokeStyle = "rgba(32, 60, 51, 0.045)";
  context.lineWidth = 1;
  for (let y = 24; y < height; y += 36) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function drawShareHeader(context, title, subtitle) {
  const { padding, width, ink, muted, sage } = shareCanvasTheme;
  let y = 34;

  context.fillStyle = sage;
  context.font = `700 13px ${shareFontStack}`;
  context.letterSpacing = "0.6px";
  context.fillText("SCORNAL · 成绩留声机", padding, y);
  context.letterSpacing = "0px";

  avatarSystem?.drawCanvasIdentity(context, { x: width - padding - 54, y: 10, size: 54 });
  fillRoundedRect(context, width - padding - 148, 20, 82, 28, 14, "rgba(255, 255, 255, 0.56)", "rgba(89, 77, 58, 0.14)");
  context.fillStyle = muted;
  context.font = `700 13px ${shareFontStack}`;
  drawFittedText(context, getStudentShortName(), width - padding - 134, 39, 54);

  y = 74;
  context.fillStyle = ink;
  context.font = `700 28px ${shareFontStack}`;
  y = drawWrappedText(context, title, padding, y, width - padding * 2, 32);

  context.fillStyle = muted;
  context.font = `14px ${shareSerifStack}`;
  context.fillText(subtitle, padding, y + 8);
  return y + 34;
}

function drawShareMessage(context, y) {
  const { lines } = getShareMessageMetrics();
  if (!lines.length) return y;
  const { width, padding, ink, sage } = shareCanvasTheme;
  const bandTop = y + 20;
  const bandW = width - padding * 2;
  const bandH = 62 + lines.length * 24;
  fillRoundedRect(context, padding, bandTop, bandW, bandH, 20, "rgba(214, 176, 128, 0.16)", "rgba(198, 143, 120, 0.3)");
  context.fillStyle = sage;
  context.font = `700 12px ${shareFontStack}`;
  context.fillText("\u5bc4\u8bed", padding + 20, bandTop + 26);
  context.fillStyle = ink;
  context.font = `15px ${shareFontStack}`;
  lines.forEach((line, index) => {
    context.fillText(line, padding + 20, bandTop + 50 + index * 24);
  });
  return bandTop + bandH;
}

function drawShareFooter(context, y) {
  const { padding, width, muted } = shareCanvasTheme;
  y = drawShareMessage(context, y);
  y += 22;
  context.strokeStyle = "rgba(89, 77, 58, 0.14)";
  context.beginPath();
  context.moveTo(padding, y);
  context.lineTo(width - padding, y);
  context.stroke();

  context.fillStyle = muted;
  context.font = `13px ${shareFontStack}`;
  context.fillText("记录起伏，看见成长", padding, y + 26);
  context.fillStyle = "rgba(102, 124, 97, 0.72)";
  context.font = `700 12px ${shareSerifStack}`;
  context.fillText("Scornal", width - padding - 48, y + 26);
  return y + 48;
}

function getExamScoreLines(record, subject) {
  const display = getSubjectScoreDisplay(record, subject.id);
  const isTotal = subject.id === "total";
  const rawLabel = isTotal ? "原始总分" : (display.isCore ? "分数" : "原始分");
  const assignedLabel = isTotal ? "赋分总分" : "赋分";
  const lines = [];

  if (display.hasRaw) {
    lines.push({ label: rawLabel, valueText: display.rawText });
  }

  if (display.hasAssigned) {
    lines.push({ label: assignedLabel, valueText: display.assignedText });
  }

  return lines;
}

function hasSubjectRank(record, subject) {
  return Number.isFinite(record?.ranks?.[subject.id]);
}

function subjectDeltaLine(record, previous, subject) {
  if (!previous) return "较上次 暂无对比";

  const comparison = getSubjectScoreComparison(record, previous, subject.id);
  const scoreDelta = comparison.assignedDelta || comparison.rawDelta;
  const scoreText = scoreDelta ? scoreDelta.text : (comparison.mismatchText || "暂无同口径分数对比");
  const currentRank = record.ranks?.[subject.id];
  const previousRank = previous.ranks?.[subject.id];
  const rankText = Number.isFinite(currentRank) && Number.isFinite(previousRank)
    ? rankDeltaText(currentRank, previousRank).text
    : "暂无校排对比";

  return `较上次 ${scoreText} · ${rankText}`;
}

function measureExamSubjectCardHeight(record, subject) {
  const scoreLineCount = Math.max(getExamScoreLines(record, subject).length, 1);
  const scoreBlockHeight = scoreLineCount * 26;
  return hasSubjectRank(record, subject) ? 88 + scoreBlockHeight + 26 : 72 + scoreBlockHeight;
}

function measureExamTotalCardHeight(record, subject) {
  const scoreLineCount = Math.max(getExamScoreLines(record, subject).length, 1);
  const scoreBlockHeight = scoreLineCount * 30;
  return hasSubjectRank(record, subject) ? 82 + scoreBlockHeight + 32 : 68 + scoreBlockHeight;
}

function measureShareHeaderHeight(title) {
  const { width, padding } = shareCanvasTheme;
  shareMeasureContext.font = `700 28px ${shareFontStack}`;
  return 74 + measureWrappedLines(shareMeasureContext, title, width - padding * 2).length * 32 + 34;
}

function measureShareFooterHeight() {
  return getShareMessageMetrics().height + 70;
}

function drawExamScoreLine(context, line, x, y, color, fullMark, options = {}) {
  const labelWidth = options.labelWidth || 50;
  const valueX = x + labelWidth;
  const markX = options.markX || valueX + 58;
  const valueFontSize = options.valueFontSize || 22;
  const markFontSize = options.markFontSize || 12;

  context.fillStyle = shareCanvasTheme.muted;
  context.font = `700 12px ${shareFontStack}`;
  context.fillText(line.label, x, y - 2);
  context.fillStyle = color;
  context.font = `700 ${valueFontSize}px ${shareSerifStack}`;
  context.fillText(line.valueText, valueX, y);
  context.fillStyle = shareCanvasTheme.ink;
  context.font = `${markFontSize}px ${shareFontStack}`;
  context.fillText(`/ ${fullMark} 分`, markX, y - 2);
}

function drawExamSubjectCard(context, record, previous, subject, x, y, width, height) {
  const actualHeight = height || measureExamSubjectCardHeight(record, subject);
  fillRoundedRect(context, x, y, width, actualHeight, 18, "rgba(255, 253, 244, 0.78)", shareCanvasTheme.line);

  context.save();
  context.fillStyle = subject.color;
  context.globalAlpha = 0.16;
  roundedRectPath(context, x, y, width, actualHeight, 18);
  context.clip();
  context.fillRect(x, y, 7, actualHeight);
  context.beginPath();
  context.arc(x + width - 10, y + 4, 54, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.fillStyle = shareCanvasTheme.ink;
  context.font = `700 17px ${shareFontStack}`;
  context.fillText(subject.name, x + 15, y + 27);

  context.fillStyle = shareCanvasTheme.muted;
  context.font = `12px ${shareFontStack}`;
  context.fillText(`满分 ${subject.fullMark}`, x + 15, y + 47);

  const scoreLines = getExamScoreLines(record, subject);
  if (scoreLines.length) {
    scoreLines.forEach((line, index) => {
      drawExamScoreLine(context, line, x + 15, y + 76 + index * 26, subject.color, subject.fullMark);
    });
  } else {
    context.fillStyle = shareCanvasTheme.muted;
    context.font = `14px ${shareFontStack}`;
    context.fillText("本次未录入", x + 15, y + 76);
  }

  if (hasSubjectRank(record, subject)) {
    const rankY = y + 76 + Math.max(scoreLines.length, 1) * 26 + 12;
    context.fillStyle = shareCanvasTheme.muted;
    context.font = `13px ${shareFontStack}`;
    context.fillText(`校排第 ${record.ranks[subject.id]}`, x + 15, rankY);
    drawFittedText(context, subjectDeltaLine(record, previous, subject), x + 15, rankY + 22, width - 30);
  }

  return actualHeight;
}

function buildExamShareLayout(record) {
  const previous = previousExamFor(record);
  const title = `${record.shortName}`;
  const subtitle = record.date;
  const rows = getActiveSubjects().filter((subject) => subject.id !== "total");
  const totalSubject = getSubject("total");
  const cardGap = 14;
  const subjectCardsHeight = rows.reduce((sum, subject) => sum + measureExamSubjectCardHeight(record, subject) + cardGap, 0);
  const totalCardHeight = measureExamTotalCardHeight(record, totalSubject);
  const contentHeight = measureShareHeaderHeight(title) + subjectCardsHeight + totalCardHeight + measureShareFooterHeight();
  return { previous, title, subtitle, rows, totalSubject, totalCardHeight, contentHeight };
}

function renderExamShareCanvas(record) {
  const { width, padding, ink, muted, sage, clay } = shareCanvasTheme;
  const { previous, title, subtitle, rows, totalSubject, totalCardHeight, contentHeight } = buildExamShareLayout(record);
  const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(contentHeight * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${contentHeight}px`;
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  context.save();

  drawShareBackground(context, width, contentHeight);
  let y = drawShareHeader(context, title, subtitle);

  const cardWidth = width - padding * 2;
  rows.forEach((subject) => {
    const cardHeight = measureExamSubjectCardHeight(record, subject);
    context.save();
    drawExamSubjectCard(context, record, previous, subject, padding, y, cardWidth, cardHeight);
    context.restore();
    y += cardHeight + 14;
  });

  fillRoundedRect(context, padding, y, cardWidth, totalCardHeight, 24, "rgba(255, 250, 238, 0.86)", "rgba(198, 120, 93, 0.28)");
  context.fillStyle = clay;
  context.globalAlpha = 0.18;
  context.beginPath();
  context.arc(width - padding - 8, y + 18, 70, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  context.fillStyle = muted;
  context.font = `13px ${shareFontStack}`;
  context.fillText("总分概览", padding + 18, y + 28);

  const totalScoreLines = getExamScoreLines(record, totalSubject);
  if (totalScoreLines.length) {
    totalScoreLines.forEach((line, index) => {
      drawExamScoreLine(context, line, padding + 18, y + 64 + index * 30, clay, totalSubject.fullMark, {
        labelWidth: 72,
        markX: padding + 174,
        valueFontSize: 26,
        markFontSize: 13
      });
    });
  } else {
    context.fillStyle = muted;
    context.font = `14px ${shareFontStack}`;
    context.fillText("总分未录入", padding + 18, y + 64);
  }

  if (hasSubjectRank(record, totalSubject)) {
    const rankY = y + 64 + Math.max(totalScoreLines.length, 1) * 30 + 8;
    context.fillStyle = sage;
    context.font = `700 15px ${shareFontStack}`;
    context.fillText(`总分校排第 ${record.ranks.total}`, padding + 18, rankY);
    context.fillStyle = muted;
    context.font = `13px ${shareFontStack}`;
    drawFittedText(context, subjectDeltaLine(record, previous, totalSubject), padding + 148, rankY, cardWidth - 166);
  }
  y += totalCardHeight;

  const finalHeight = drawShareFooter(context, y);
  context.restore();
  return { canvas, height: finalHeight };
}

function analysisDeltaText(value, goodWord, badWord, unit) {
  const abs = Math.abs(value);
  if (unit === "分" && abs < 0.01) return "持平";
  if (unit === "名" && abs === 0) return "持平";
  return `${value > 0 ? goodWord : badWord} ${unit === "分" ? formatDeltaNumber(abs) : abs} ${unit}`;
}

function analysisCanvasScoreTrackLabel(row) {
  if (!row?.track) return "";
  if (row.subject.id === "total") return row.track === "assigned" ? "赋分总分" : "原始总分";
  return row.track === "assigned" ? "赋分" : "原始分";
}

function analysisCanvasScoreText(row) {
  const label = analysisCanvasScoreTrackLabel(row);
  if (!Number.isFinite(row?.scoreDelta)) return label ? `${label}暂无同口径对比` : "暂无同口径分数对比";
  return `${label}${analysisDeltaText(row.scoreDelta, "上升", "下降", "分")}`;
}

function analysisCanvasRankText(row) {
  if (!Number.isFinite(row?.rankMovement)) return "暂无校排对比";
  return `校排${analysisDeltaText(row.rankMovement, "前进", "后退", "名")}`;
}
function topAnalysisRows(rows, mode) {
  const isProgress = mode === "progress";
  return rows
    .filter((row) => isProgress ? row.progressWeight > 0 : row.regressionWeight > 0)
    .sort((a, b) => isProgress ? b.progressWeight - a.progressWeight : b.regressionWeight - a.regressionWeight);
}

function drawAnalysisBoard(context, title, helper, rows, mode, x, y, width) {
  const isProgress = mode === "progress";
  fillRoundedRect(context, x, y, width, 72 + Math.max(rows.length, 1) * 54, 22, "rgba(255, 253, 244, 0.78)", shareCanvasTheme.line);
  context.fillStyle = isProgress ? shareCanvasTheme.sage : "#b06f5e";
  context.font = `700 20px ${shareFontStack}`;
  context.fillText(title, x + 17, y + 30);
  context.fillStyle = shareCanvasTheme.muted;
  context.font = `12px ${shareFontStack}`;
  context.fillText(helper, x + 17, y + 50);

  if (!rows.length) {
    context.fillStyle = shareCanvasTheme.muted;
    context.font = `14px ${shareFontStack}`;
    context.fillText(`这次没有明显${isProgress ? "进步" : "退步"}项。`, x + 17, y + 88);
    return y + 126;
  }

  rows.forEach((row, index) => {
    const rowY = y + 72 + index * 54;
    fillRoundedRect(context, x + 12, rowY, width - 24, 42, 15, "rgba(255, 255, 255, 0.48)", "rgba(89, 77, 58, 0.08)");
    context.fillStyle = row.subject.color;
    context.globalAlpha = 0.18;
    context.fillRect(x + 12, rowY, 6, 42);
    context.globalAlpha = 1;
    context.fillStyle = shareCanvasTheme.ink;
    context.font = `700 15px ${shareFontStack}`;
    context.fillText(`${index + 1}. ${row.subject.name}`, x + 25, rowY + 26);
    context.fillStyle = shareCanvasTheme.muted;
    context.font = `12px ${shareFontStack}`;
    const scoreText = analysisCanvasScoreText(row);
    const rankText = analysisCanvasRankText(row);
    drawFittedText(context, `${scoreText} · ${rankText}`, x + 96, rowY + 26, width - 122);
  });

  return y + 84 + rows.length * 54;
}

function renderAnalysisShareCanvas() {
  const { width, padding, ink, muted, sage, clay } = shareCanvasTheme;
  const [latest, previous] = getLatestPair();
  const rows = latest && previous ? buildAnalysisRows(latest, previous) : [];
  const progressRows = topAnalysisRows(rows, "progress");
  const regressionRows = topAnalysisRows(rows, "regression");
  const contentHeight = 560 + Math.max(progressRows.length, 1) * 54 + Math.max(regressionRows.length, 1) * 54 + getShareMessageMetrics().height;
  const dpr = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(contentHeight * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${contentHeight}px`;
  const context = canvas.getContext("2d");
  context.scale(dpr, dpr);
  context.save();

  drawShareBackground(context, width, contentHeight);
  let y = drawShareHeader(context, "最近两次考试对照", latest && previous ? `${previous.shortName} → ${latest.shortName}` : "等待更多考试记录");

  if (!latest || !previous) {
    fillRoundedRect(context, padding, y, width - padding * 2, 126, 22, "rgba(255, 253, 244, 0.78)", shareCanvasTheme.line);
    context.fillStyle = ink;
    context.font = `700 20px ${shareFontStack}`;
    context.fillText("还需要至少两次考试", padding + 18, y + 38);
    context.fillStyle = muted;
    context.font = `14px ${shareFontStack}`;
    drawWrappedText(context, "再保存一次考试后，就能自动生成进步榜、退步榜和总分趋势。", padding + 18, y + 68, width - padding * 2 - 36, 22);
    y += 132;
    drawShareFooter(context, y);
    context.restore();
    return { canvas };
  }

  const totalRow = rows.find((row) => row.subject.id === "total");
  const totalScoreText = analysisCanvasScoreText(totalRow);
  const totalRankText = analysisCanvasRankText(totalRow);
  fillRoundedRect(context, padding, y, width - padding * 2, 128, 24, "rgba(255, 250, 238, 0.86)", "rgba(102, 124, 97, 0.20)");
  context.fillStyle = sage;
  context.font = `700 14px ${shareFontStack}`;
  context.fillText("总分 / 校排趋势", padding + 18, y + 30);
  context.fillStyle = ink;
  context.font = `700 25px ${shareFontStack}`;
  drawFittedText(context, totalScoreText, padding + 18, y + 68, width - padding * 2 - 36);
  context.fillStyle = clay;
  context.font = `700 18px ${shareFontStack}`;
  context.fillText(totalRankText, padding + 18, y + 98);
  context.fillStyle = muted;
  context.font = `12px ${shareSerifStack}`;
  context.fillText(`${previous.date}  对照  ${latest.date}`, padding + 18, y + 116);
  y += 146;

  y = drawAnalysisBoard(context, "进步榜", "分数上升或校排前进", progressRows, "progress", padding, y, width - padding * 2);
  y += 14;
  y = drawAnalysisBoard(context, "退步榜", "分数下降或校排后退", regressionRows, "regression", padding, y, width - padding * 2);

  drawShareFooter(context, y);
  context.restore();
  return { canvas };
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PNG 图片生成失败，请重试。"));
      }
    }, "image/png");
  });
}

function canSharePngFile(file) {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

function isTouchMobileDevice() {
  return navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isIosLikeDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function createPngFile(blob, filename) {
  if (typeof File !== "function") return null;
  return new File([blob], filename, { type: "image/png" });
}

function chooseShareAction(blob, filename) {
  const file = createPngFile(blob, filename);
  if (isTouchMobileDevice() && file && typeof navigator.share === "function" && canSharePngFile(file)) {
    return { mode: shareActionModes.share, file };
  }
  if (isIosLikeDevice()) return { mode: shareActionModes.longPress, file };
  return { mode: shareActionModes.download, file };
}

function applyShareActionMode(mode) {
  shareActionState.mode = mode;
  shareDownload.dataset.shareMode = mode;
  shareDownload.href = shareActionState.objectUrl;
  shareDownload.classList.toggle("is-longpress", mode === shareActionModes.longPress);

  if (mode === shareActionModes.download) {
    shareDownload.download = shareActionState.filename;
    shareDownload.textContent = "保存 PNG";
    shareStatus.textContent = "图片已生成，可保存 PNG。";
    return;
  }

  shareDownload.removeAttribute("download");
  if (mode === shareActionModes.share) {
    shareDownload.textContent = "分享 / 保存图片";
    shareStatus.textContent = "点击下方按钮打开系统分享，可存到相册或发送。";
    return;
  }

  shareDownload.textContent = "长按保存图片";
  shareStatus.textContent = "长按上方图片保存到相册。";
}

function openShareModal(title, subtitle, objectUrl, filename, blob) {
  const shareText = "Scornal 生成的成绩长图";
  const selectedAction = chooseShareAction(blob, filename);
  shareLastFocusedElement = document.activeElement;
  shareActionState = {
    ...selectedAction,
    blob,
    filename,
    objectUrl,
    title,
    text: shareText
  };
  shareTitle.textContent = title;
  shareSubtitle.textContent = subtitle;
  sharePreview.classList.remove("is-developing");
  sharePreview.src = objectUrl;
  void sharePreview.offsetWidth;
  sharePreview.classList.add("is-developing");
  applyShareActionMode(selectedAction.mode);
  showLockingModal(shareModal);
  shareDownload.focus({ preventScroll: true });
}

function closeShareModal() {
  hideLockingModal(shareModal);
  sharePreview.classList.remove("is-longpress-nudge");
  if (shareLastFocusedElement && typeof shareLastFocusedElement.focus === "function") {
    shareLastFocusedElement.focus({ preventScroll: true });
  }
}

async function shareGeneratedPng() {
  if (!shareActionState.file) {
    applyShareActionMode(isIosLikeDevice() ? shareActionModes.longPress : shareActionModes.download);
    return;
  }

  try {
    shareStatus.textContent = "正在打开系统分享…";
    await navigator.share({ files: [shareActionState.file], title: shareActionState.title, text: shareActionState.text });
    shareStatus.textContent = "已打开系统分享，可存到相册或发送。";
  } catch (error) {
    if (isShareAbort(error)) {
      shareStatus.textContent = "点击下方按钮打开系统分享，可存到相册或发送。";
      return;
    }
    if (isIosLikeDevice()) {
      applyShareActionMode(shareActionModes.longPress);
      return;
    }
    applyShareActionMode(shareActionModes.download);
    downloadBlob(shareActionState.blob, shareActionState.filename);
    shareStatus.textContent = "系统分享未完成，已改为下载 PNG。";
  }
}

function promptLongPressSave() {
  shareStatus.textContent = "长按上方图片保存到相册。";
  sharePreview.scrollIntoView({ block: "center", behavior: "smooth" });
  sharePreview.classList.remove("is-longpress-nudge");
  void sharePreview.offsetWidth;
  sharePreview.classList.add("is-longpress-nudge");
  window.setTimeout(() => sharePreview.classList.remove("is-longpress-nudge"), 900);
}

async function rerenderSharePreview() {
  if (!activeShareKind || !shareActionState) return;
  const isExamShare = activeShareKind === "exam";
  const record = activeShareRecord;
  if (isExamShare && !record) return;
  await avatarSystem?.prepareCanvasIdentity();
  const { canvas } = isExamShare ? renderExamShareCanvas(record) : renderAnalysisShareCanvas();
  const blob = await canvasToPngBlob(canvas);
  if (sharePreviewUrl) URL.revokeObjectURL(sharePreviewUrl);
  sharePreviewUrl = URL.createObjectURL(blob);
  const selectedAction = chooseShareAction(blob, shareActionState.filename);
  shareActionState = { ...shareActionState, ...selectedAction, blob, objectUrl: sharePreviewUrl };
  sharePreview.src = sharePreviewUrl;
  applyShareActionMode(selectedAction.mode);
}

if (shareMessageInput) {
  shareMessageInput.addEventListener("input", () => {
    const settings = readSettings();
    settings.shareMessage = shareMessageInput.value.slice(0, SHARE_MESSAGE_MAX);
    writeSettings(settings);
    window.clearTimeout(shareMessageTimer);
    shareMessageTimer = window.setTimeout(rerenderSharePreview, 260);
  });
}

async function openGeneratedShare(kind) {
  const isExamShare = kind === "exam";
  const record = isExamShare ? sortedExams.find((exam) => exam.id === viewingRecordId) : null;
  if (isExamShare && !record) return;
  activeShareKind = kind;
  activeShareRecord = record;
  if (shareMessageInput) shareMessageInput.value = getShareMessage();

  const filename = isExamShare ? `scornal-${record.date}-${record.shortName}.png` : "scornal-analysis.png";
  const modalTitleText = isExamShare ? `${record.shortName} 长图` : "进退步分析长图";
  const modalSubtitleText = isExamShare ? `${record.date} · ${getStudentShortName()}` : `最近两次考试 · ${getStudentShortName()}`;
  await avatarSystem?.prepareCanvasIdentity();
  const { canvas } = isExamShare ? renderExamShareCanvas(record) : renderAnalysisShareCanvas();
  const blob = await canvasToPngBlob(canvas);

  if (sharePreviewUrl) URL.revokeObjectURL(sharePreviewUrl);
  sharePreviewUrl = URL.createObjectURL(blob);
  openShareModal(modalTitleText, modalSubtitleText, sharePreviewUrl, filename, blob);
}
function scoreDeltaText(current, previous) {
  const delta = current - previous;
  const abs = Math.abs(delta);
  if (abs < 0.01) return { text: "持平", className: "" };
  return {
    text: `${delta > 0 ? "+" : "-"}${formatNumber(abs)} 分`,
    className: delta > 0 ? "delta-good" : "delta-bad"
  };
}

function rankDeltaText(current, previous) {
  const delta = previous - current;
  const abs = Math.abs(delta);
  if (abs === 0) return { text: "排名持平", className: "" };
  return {
    text: `${delta > 0 ? "上升" : "下降"} ${abs} 名`,
    className: delta > 0 ? "delta-good" : "delta-bad"
  };
}

function getLatestPair() {
  return [sortedExams.at(-1), sortedExams.at(-2)];
}

function renderLatestSnapshot() {
  const [latest, previous] = getLatestPair();
  const latestTitle = document.querySelector("[data-latest-title]");
  const totalScore = document.querySelector("[data-total-score]");
  const totalRank = document.querySelector("[data-total-rank]");
  const examCount = document.querySelector("[data-exam-count]");
  const totalScoreChange = document.querySelector("[data-total-score-change]");
  const totalRankChange = document.querySelector("[data-total-rank-change]");

  if (!latest) {
    latestTitle.textContent = "暂无记录";
    totalScore.textContent = "--";
    totalRank.textContent = "--";
    examCount.textContent = "0 次";
    totalScoreChange.textContent = "保存一次考试后生成概览";
    totalRankChange.textContent = "";
    totalScoreChange.className = "";
    totalRankChange.className = "";
    return;
  }

  const totalDisplay = getSubjectScoreDisplay(latest, "total");
  const previousTotalDisplay = previous ? getSubjectScoreDisplay(previous, "total") : null;
  const hasTotalRank = Number.isFinite(Number(latest.ranks?.total));

  latestTitle.textContent = latest.shortName;
  totalScore.innerHTML = totalDisplay.hasAny
    ? `<span class="latest-total-stack score-dual ${totalDisplay.hasAssigned ? "has-assigned" : ""}">
        ${totalDisplay.hasAssigned ? `<span class="score-line is-assigned"><span class="score-label">赋分总分</span><b>${totalDisplay.assignedText}</b></span>` : ""}
        ${totalDisplay.hasRaw ? `<span class="score-line"><span class="score-label">原始总分</span><b>${totalDisplay.rawText}</b></span>` : ""}
      </span>`
    : `<span class="score-empty">本次未录入总分</span>`;
  totalRank.textContent = hasTotalRank ? `第 ${latest.ranks.total}` : "--";
  examCount.textContent = `${sortedExams.length} 次`;

  if (!previous) {
    totalScoreChange.textContent = "暂无上次对比";
    totalRankChange.textContent = hasTotalRank ? "暂无上次对比" : "本次未记录校排";
    totalScoreChange.className = "";
    totalRankChange.className = "";
    return;
  }

  const totalScoreChanges = [];
  if (totalDisplay.hasAssigned && previousTotalDisplay?.hasAssigned) {
    const assignedDelta = scoreDeltaText(totalDisplay.assignedValue, previousTotalDisplay.assignedValue);
    totalScoreChanges.push(`<span class="${assignedDelta.className}">赋分较上次 ${assignedDelta.text}</span>`);
  }
  if (totalDisplay.hasRaw && previousTotalDisplay?.hasRaw) {
    const rawDelta = scoreDeltaText(totalDisplay.rawValue, previousTotalDisplay.rawValue);
    totalScoreChanges.push(`<span class="${rawDelta.className}">原始较上次 ${rawDelta.text}</span>`);
  }
  totalScoreChange.innerHTML = totalScoreChanges.length ? totalScoreChanges.join(" · ") : "暂无同口径对比";
  totalScoreChange.className = totalScoreChanges.length > 1 ? "score-change-list" : "";

  const previousHasTotalRank = Number.isFinite(Number(previous.ranks?.total));
  if (hasTotalRank && previousHasTotalRank) {
    const totalRankDelta = rankDeltaText(latest.ranks.total, previous.ranks.total);
    totalRankChange.textContent = `较上次 ${totalRankDelta.text}`;
    totalRankChange.className = totalRankDelta.className;
  } else {
    totalRankChange.textContent = "暂无上次对比";
    totalRankChange.className = "";
  }
}

function renderSubjectCards() {
  const [latest, previous] = getLatestPair();

  if (!latest) {
    subjectGrid.innerHTML = `<article class="subject-card"><h4 class="subject-name">暂无成绩</h4><p class="subject-rank">点击“记录成绩”保存第一次考试。</p></article>`;
    return;
  }

  subjectGrid.innerHTML = getActiveSubjects().map((subject) => {
    const display = getSubjectScoreDisplay(latest, subject.id);
    const hasRank = Number.isFinite(Number(latest.ranks?.[subject.id]));
    const rank = latest.ranks?.[subject.id];
    const fullMarkText = `满分 ${subject.fullMark}`;
    const prevDisplay = previous ? getSubjectScoreDisplay(previous, subject.id) : null;
    let scoreDelta = null;
    if (display.hasAssigned && prevDisplay?.hasAssigned) {
      scoreDelta = scoreDeltaText(display.assignedValue, prevDisplay.assignedValue);
    } else if (display.hasRaw && prevDisplay?.hasRaw) {
      scoreDelta = scoreDeltaText(display.rawValue, prevDisplay.rawValue);
    }
    const currentRank = Number(rank);
    const previousRank = Number(previous?.ranks?.[subject.id]);
    const rankDelta = hasRank && Number.isFinite(previousRank) ? rankDeltaText(currentRank, previousRank) : null;
    const changeParts = [];
    if (scoreDelta) {
      changeParts.push(`<span class="subject-delta ${scoreDelta.className}">较上次 ${scoreDelta.text}</span>`);
    }
    if (rankDelta) {
      const rankDeltaTextValue = rankDelta.text.replace("上升", "前进").replace("下降", "后退");
      changeParts.push(`<span class="subject-delta ${rankDelta.className}">较上次 ${rankDeltaTextValue}</span>`);
    }
    const scoreHtml = display.isCore
      ? (display.hasRaw ? `<div class="subject-score"><strong>${display.rawText}</strong><span>分</span></div>` : `<div class="subject-score is-empty"><span class="score-empty">本次未录入</span></div>`)
      : `<div class="subject-score dual-score score-dual ${display.hasAny ? "" : "is-empty"}">
          ${display.hasRaw ? `<span class="score-line is-raw"><span class="score-label">原始分</span><strong>${display.rawText}</strong></span>` : ""}
          ${display.hasAssigned ? `<span class="score-line is-assigned"><span class="score-label">赋分</span><strong>${display.assignedText}</strong></span>` : ""}
          ${display.hasAny ? "" : `<span class="score-empty">本次未录入</span>`}
        </div>`;
    const comparisonHtml = changeParts.length ? ` · ${changeParts.join(" · ")}` : "";
    const rankHtml = hasRank
      ? `校排第 ${rank}${comparisonHtml}`
      : `本次未记录校排${comparisonHtml}`;

    return `
      <article class="subject-card${subject.id === "total" ? " is-total" : ""}" data-subject-card="${subject.id}" style="--subject-color: ${subject.color}">
        <div class="subject-top">
          <h4 class="subject-name">${subject.name}</h4>
          <span class="subject-fullmark">${fullMarkText}</span>
        </div>
        ${scoreHtml}
        <p class="subject-rank">${rankHtml}</p>
        <div class="card-actions">
          <button type="button" data-open-trend="score" data-subject="${subject.id}">分数走势</button>
          <button type="button" data-open-trend="rank" data-subject="${subject.id}">排名走势</button>
        </div>
      </article>
    `;
  }).join("");
}

function formatDeltaNumber(value) {
  return Math.abs(value).toFixed(1);
}

function scoreTrackLabel(row) {
  if (!row?.track) return "";
  if (row.subject.id === "total") return row.track === "assigned" ? "赋分总分" : "原始总分";
  if (CORE_SUBJECT_IDS.includes(row.subject.id)) return "";
  return row.track === "assigned" ? "赋分" : "原始分";
}

function scoreDeltaChip(delta, row = null) {
  if (!Number.isFinite(delta)) return "";
  const abs = Math.abs(delta);
  const label = scoreTrackLabel(row);
  const prefix = label ? `${label}` : "";
  if (abs < 0.01) return `<span class="delta-chip">${prefix ? `${prefix}持平` : "持平"}</span>`;
  return `<span class="delta-chip ${delta > 0 ? "is-good" : "is-bad"}">${prefix}${delta > 0 ? "提高" : "下降"} ${formatDeltaNumber(abs)} 分</span>`;
}

function rankDeltaChip(rankMovement) {
  if (!Number.isFinite(rankMovement)) return "";
  const abs = Math.abs(rankMovement);
  if (abs === 0) return `<span class="delta-chip">校排持平</span>`;
  return `<span class="delta-chip ${rankMovement > 0 ? "is-good" : "is-bad"}">${rankMovement > 0 ? "前进" : "后退"} ${abs} 名</span>`;
}

function buildAnalysisRows(latest, previous) {
  return getActiveSubjects()
    .map((subject) => {
      const subjectId = subject.id;
      const latestDisplay = getSubjectScoreDisplay(latest, subjectId);
      const previousDisplay = getSubjectScoreDisplay(previous, subjectId);
      const latestRank = Number(latest.ranks?.[subjectId]);
      const previousRank = Number(previous.ranks?.[subjectId]);
      const hasRankMovement = Number.isFinite(latestRank) && Number.isFinite(previousRank);

      let track = null;
      let latestValue = null;
      let previousValue = null;
      let scoreDelta = null;

      if (latestDisplay.hasAssigned && previousDisplay.hasAssigned) {
        track = "assigned";
        latestValue = latestDisplay.assignedValue;
        previousValue = previousDisplay.assignedValue;
      } else if (latestDisplay.hasRaw && previousDisplay.hasRaw) {
        track = "raw";
        latestValue = latestDisplay.rawValue;
        previousValue = previousDisplay.rawValue;
      }

      if (track) scoreDelta = latestValue - previousValue;

      const rankMovement = hasRankMovement ? previousRank - latestRank : null;
      const scoreMovement = Number.isFinite(scoreDelta) ? scoreDelta : 0;
      const rankWeightMovement = Number.isFinite(rankMovement) ? rankMovement : 0;

      return {
        subject,
        track,
        scoreDelta,
        rankMovement,
        latestValue,
        previousValue,
        latestRank: hasRankMovement ? latestRank : null,
        previousRank: hasRankMovement ? previousRank : null,
        progressWeight: Math.max(scoreMovement, 0) * 2 + Math.max(rankWeightMovement, 0),
        regressionWeight: Math.max(-scoreMovement, 0) * 2 + Math.max(-rankWeightMovement, 0)
      };
    })
    .filter((row) => Number.isFinite(row.scoreDelta) || Number.isFinite(row.rankMovement));
}

function analysisBoardRows(rows, mode) {
  const isProgress = mode === "progress";
  const filteredRows = rows
    .filter((row) => isProgress ? row.progressWeight > 0 : row.regressionWeight > 0)
    .sort((a, b) => isProgress ? b.progressWeight - a.progressWeight : b.regressionWeight - a.regressionWeight);

  if (!filteredRows.length) {
    return `<p class="analysis-empty-line">这次没有明显${isProgress ? "进步" : "退步"}项。</p>`;
  }

  return filteredRows.map((row, index) => `
    <div class="analysis-rank-row ${isProgress ? "is-progress" : "is-regression"}${isProgress && index === 0 ? " is-top" : ""}" style="--subject-color: ${row.subject.color}; --row-index: ${index};">
      <strong>${index + 1}</strong>
      <span>${row.subject.name}</span>
      <em>${scoreDeltaChip(row.scoreDelta, row)}${rankDeltaChip(row.rankMovement)}</em>
    </div>
  `).join("");
}

function scoreCompareText(row) {
  if (!Number.isFinite(row.scoreDelta)) return "暂无同口径分数对比";
  const label = scoreTrackLabel(row);
  return `${label ? `${label} ` : ""}${formatNumber(row.previousValue)} → ${formatNumber(row.latestValue)}`;
}

function totalScoreSummaryText(row) {
  if (!row || !Number.isFinite(row.scoreDelta)) return "暂无可比总分";
  const label = scoreTrackLabel(row) || "总分";
  if (Math.abs(row.scoreDelta) < 0.01) return `${label}持平`;
  return `${label}${row.scoreDelta > 0 ? "上升" : "下降"} ${formatDeltaNumber(Math.abs(row.scoreDelta))} 分`;
}

function totalRankSummaryText(row) {
  if (!row || !Number.isFinite(row.rankMovement)) return "暂无可比校排";
  if (row.rankMovement === 0) return "总体校排持平";
  return `总体校排${row.rankMovement > 0 ? "前进" : "后退"} ${Math.abs(row.rankMovement)} 名`;
}

function renderAnalysisPage() {
  if (!analysisPage) return;

  if (sortedExams.length < 2) {
    analysisSummary.innerHTML = `
      <article class="analysis-empty-card">
        <strong>还需要至少两次考试</strong>
        <p>现在只有 ${sortedExams.length} 次记录。再保存一次考试后，就能自动生成进步榜、退步榜和总分趋势。</p>
      </article>
    `;
    progressBoard.innerHTML = `<p class="analysis-empty-line">等待下一次考试。</p>`;
    regressionBoard.innerHTML = `<p class="analysis-empty-line">等待下一次考试。</p>`;
    analysisCompare.innerHTML = "";
    return;
  }

  const [latest, previous] = getLatestPair();
  const rows = buildAnalysisRows(latest, previous);
  const totalRow = rows.find((row) => row.subject.id === "total");
  const totalScoreDelta = Number.isFinite(totalRow?.scoreDelta) ? totalRow.scoreDelta : null;
  const totalRankMovement = Number.isFinite(totalRow?.rankMovement) ? totalRow.rankMovement : null;
  const totalScoreText = totalScoreSummaryText(totalRow);
  const totalRankText = totalRankSummaryText(totalRow);
  const totalSignals = [totalScoreDelta, totalRankMovement].filter(Number.isFinite);
  const summaryToneClass = totalSignals.length && totalSignals.every((value) => value >= 0)
    ? "is-good"
    : totalSignals.length && totalSignals.every((value) => value <= 0)
      ? "is-bad"
      : "";

  analysisSummary.innerHTML = `
    <article class="analysis-summary-card ${summaryToneClass}">
      <span>本次</span>
      <strong>${escapeHtml(latest.shortName)}</strong>
      <em>${formatDateForDisplay(latest.date)}</em>
    </article>
    <article class="analysis-summary-card">
      <span>对照</span>
      <strong>${escapeHtml(previous.shortName)}</strong>
      <em>${formatDateForDisplay(previous.date)}</em>
    </article>
    <article class="analysis-summary-card analysis-summary-main">
      <span>总分趋势</span>
      <strong>${totalScoreText}</strong>
      <em>${totalRankText}</em>
    </article>
  `;

  progressBoard.innerHTML = analysisBoardRows(rows, "progress");
  regressionBoard.innerHTML = analysisBoardRows(rows, "regression");
  analysisCompare.innerHTML = rows.map((row) => `
    <div class="analysis-compare-row" style="--subject-color: ${row.subject.color}">
      <strong>${row.subject.name}</strong>
      <span>${scoreCompareText(row)}</span>
      <em>${scoreDeltaChip(row.scoreDelta, row)}${rankDeltaChip(row.rankMovement)}</em>
    </div>
  `).join("");
}
function currentSceneElements() {
  if (homeScreen.classList.contains("is-adding")) return [addPage];
  if (homeScreen.classList.contains("is-listing")) {
    const rows = Array.from(document.querySelectorAll(".grade-list-track .grade-entry"));
    const base = rows.length ? rows : [listPage];
    return editPanel.hidden ? base : [...base, editPanel];
  }
  if (homeScreen.classList.contains("is-detailing")) return [detailPage];
  if (homeScreen.classList.contains("is-analysing")) return [analysisPage];
  if (homeScreen.classList.contains("is-profile")) return Array.from(document.querySelectorAll(".profile-card, .profile-list"));
  const hero = document.querySelector(".dashboard-hero");
  const latest = document.querySelector(".latest-panel");
  const cards = Array.from(document.querySelectorAll(".subject-grid .subject-card"));
  const backup = document.querySelector(".backup-panel");
  return [hero, latest, ...cards, backup];
}

function playSceneTransition() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  currentSceneElements().filter(Boolean).forEach((element, index) => {
    element.classList.remove("scene-enter");
    element.style.setProperty("--scene-delay", `${Math.min(index, 8) * 42}ms`);
    void element.offsetWidth;
    element.classList.add("scene-enter");
    const cleanup = () => {
      element.classList.remove("scene-enter");
      element.style.removeProperty("--scene-delay");
    };
    element.addEventListener("animationend", cleanup, { once: true });
    window.setTimeout(cleanup, 1200);
  });
}

function showDashboardPage(options = {}) {
  const { remember = true, scroll = true, transition = true } = options;
  homeScreen.classList.remove("is-adding", "is-listing", "is-detailing", "is-analysing", "is-profile");
  if (profilePage) profilePage.hidden = true;
  addPage.hidden = true;
  listPage.hidden = true;
  detailPage.hidden = true;
  analysisPage.hidden = true;
  editPanel.hidden = true;
  viewingRecordId = "";
  if (remember) rememberActiveView(activeViews.dashboard);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (transition) playSceneTransition();
}

function showAddPage(options = {}) {
  const { remember = true, scroll = true, focus = true, transition = true } = options;
  addPage.hidden = false;
  listPage.hidden = true;
  detailPage.hidden = true;
  analysisPage.hidden = true;
  editPanel.hidden = true;
  viewingRecordId = "";
  homeScreen.classList.remove("is-adding", "is-listing", "is-detailing", "is-analysing", "is-profile");
  homeScreen.classList.add("is-adding");
  if (profilePage) profilePage.hidden = true;
  if (remember) rememberActiveView(activeViews.add);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (transition) playSceneTransition();
  if (focus) addPage.querySelector("input")?.focus({ preventScroll: true });
}

function showGradeListPage(options = {}) {
  const { remember = true, scroll = true, transition = true } = options;
  addPage.hidden = true;
  listPage.hidden = false;
  detailPage.hidden = true;
  analysisPage.hidden = true;
  viewingRecordId = "";
  if (profilePage) profilePage.hidden = true;
  homeScreen.classList.remove("is-adding", "is-listing", "is-detailing", "is-analysing", "is-profile");
  homeScreen.classList.add("is-listing");
  pendingDeleteId = "";
  editPanel.hidden = true;
  renderGradeList();
  if (remember) rememberActiveView(activeViews.list);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (transition) playSceneTransition();
}

function showAnalysisPage(options = {}) {
  const { remember = true, scroll = true, transition = true } = options;
  addPage.hidden = true;
  listPage.hidden = true;
  detailPage.hidden = true;
  analysisPage.hidden = false;
  editPanel.hidden = true;
  viewingRecordId = "";
  editingRecordId = "";
  pendingDeleteId = "";
  if (profilePage) profilePage.hidden = true;
  homeScreen.classList.remove("is-adding", "is-listing", "is-detailing", "is-analysing", "is-profile");
  homeScreen.classList.add("is-analysing");
  renderAnalysisPage();
  if (remember) rememberActiveView(activeViews.analysis);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (transition) playSceneTransition();
}

function showProfilePage(options = {}) {
  const { remember = true, scroll = true, transition = true } = options;
  addPage.hidden = true;
  listPage.hidden = true;
  detailPage.hidden = true;
  analysisPage.hidden = true;
  editPanel.hidden = true;
  if (profilePage) profilePage.hidden = false;
  viewingRecordId = "";
  editingRecordId = "";
  pendingDeleteId = "";
  homeScreen.classList.remove("is-adding", "is-listing", "is-detailing", "is-analysing");
  homeScreen.classList.add("is-profile");
  renderProfile();
  if (remember) rememberActiveView(activeViews.profile);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (transition) playSceneTransition();
}

function detailSubjectCards(record, previous = previousExamFor(record)) {
  return getActiveSubjects()
    .map((subject) => {
      const display = getSubjectScoreDisplay(record, subject.id);
      const previousDisplay = previous ? getSubjectScoreDisplay(previous, subject.id) : null;
      const comparison = getSubjectScoreComparison(record, previous, subject.id);
      const hasRank = Number.isFinite(Number(record.ranks?.[subject.id]));
      const previousHasRank = Number.isFinite(Number(previous?.ranks?.[subject.id]));
      const rankDelta = hasRank && previousHasRank ? rankDeltaText(record.ranks[subject.id], previous.ranks[subject.id]) : null;
      const scoreLines = [];
      const scoreChangeText = (track) => {
        const label = track === "raw" ? (display.isCore ? "分数变化" : "原始分变化") : "赋分变化";
        const delta = track === "raw" ? comparison.rawDelta : comparison.assignedDelta;
        if (delta) return `<em class="${delta.className}">${label}：较上次 ${delta.text}</em>`;
        if (comparison.mismatchText) return `<em>${label}：${comparison.mismatchText}</em>`;
        if (!previous) return `<em>${label}：暂无上次对比</em>`;
        return previousDisplay?.hasAny ? `<em>${label}：暂无同口径对比</em>` : `<em>${label}：暂无上次同口径数据</em>`;
      };

      if (display.hasRaw) {
        scoreLines.push(`
          <div class="score-detail-line">
            <span>${display.isCore ? "分数" : "原始分"}</span>
            <strong>${display.rawText}<small> 分</small></strong>
            ${scoreChangeText("raw")}
          </div>
        `);
      }
      if (display.hasAssigned) {
        scoreLines.push(`
          <div class="score-detail-line is-assigned">
            <span>赋分</span>
            <strong>${display.assignedText}<small> 分</small></strong>
            ${scoreChangeText("assigned")}
          </div>
        `);
      }

      return `
    <article class="exam-detail-subject ${subject.id === "total" ? "is-total" : ""}" style="--subject-color: ${subject.color}">
      <div>
        <h4>${subject.name}</h4>
        <span>满分 ${subject.fullMark}</span>
      </div>
      <div class="detail-score-stack">
        ${scoreLines.length ? scoreLines.join("") : `<span class="score-empty">本次未录入该科</span>`}
      </div>
      <div class="detail-rank-stack">
        <em>${hasRank ? `校排第 ${record.ranks[subject.id]}` : "未记录校排"}</em>
        <em class="${rankDelta?.className || ""}">${rankDelta ? `较上次 ${rankDelta.text}` : (previous ? "暂无排名对比" : "暂无上次对比")}</em>
      </div>
    </article>
  `;
    }).join("");
}

function renderExamDetail(record) {
  const previous = previousExamFor(record);
  const totalDisplay = getSubjectScoreDisplay(record, "total");
  const totalScoreHtml = totalDisplay.hasAny
    ? `<span class="detail-total-stack score-dual ${totalDisplay.hasAssigned ? "has-assigned" : ""}">
        ${totalDisplay.hasAssigned ? `<span class="score-line is-assigned"><span class="score-label">赋分总分</span><b>${totalDisplay.assignedText}</b></span>` : ""}
        ${totalDisplay.hasRaw ? `<span class="score-line"><span class="score-label">原始总分</span><b>${totalDisplay.rawText}</b></span>` : ""}
      </span>`
    : `<span class="score-empty">本次未录入总分</span>`;
  const hasTotalRank = Number.isFinite(Number(record.ranks?.total));
  detailTitle.textContent = record.shortName;
  detailDate.textContent = formatDateForDisplay(record.date);
  detailMeta.innerHTML = `
    <article>
      <span>总分</span>
      <strong>${totalScoreHtml}</strong>
      <em>满分 ${getTotalFullMark()}</em>
    </article>
    <article>
      <span>校排</span>
      <strong>${hasTotalRank ? `第 ${record.ranks.total}` : "--"}</strong>
      <em>学校排名 1-200</em>
    </article>
    <article>
      <span>收录日期</span>
      <strong>${formatDateForDisplay(record.date)}</strong>
      <em>从列表进入详情后再编辑</em>
    </article>
  `;
  detailSubjects.innerHTML = detailSubjectCards(record, previous);
}

function showExamDetailPage(recordId, options = {}) {
  const { remember = true, scroll = true, transition = true } = options;
  const record = sortedExams.find((exam) => exam.id === recordId);
  if (!record) {
    rememberActiveView(activeViews.list);
    showGradeListPage({ remember: false, scroll });
    return;
  }

  viewingRecordId = recordId;
  pendingDeleteId = "";
  editingRecordId = "";
  addPage.hidden = true;
  listPage.hidden = true;
  detailPage.hidden = false;
  analysisPage.hidden = true;
  editPanel.hidden = true;
  homeScreen.classList.remove("is-adding", "is-listing", "is-analysing");
  homeScreen.classList.add("is-detailing");
  renderExamDetail(record);
  if (remember) rememberActiveView(activeViews.detail, recordId);
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  if (transition) playSceneTransition();
}

function makeRecordId() {
  return `record-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readOptionalNumber(formData, fieldName) {
  const rawValue = formData.get(fieldName);
  const text = rawValue == null ? "" : String(rawValue).trim();
  if (!text) return undefined;
  return Number(text);
}

function readRecordFromForm(form, existingRecord) {
  const formData = new FormData(form);
  const shortName = String(formData.get("examShortName") || "").trim();
  const date = String(formData.get("examDate") || "").trim();

  if (!shortName) throw new Error("请填写考试简称。");
  if (!date) throw new Error("请选择考试日期。");

  const scores = {};
  const assignedScores = {};
  const ranks = {};
  const activeSubjects = getActiveSubjects();
  const activeSubjectIds = new Set(activeSubjects.map((subject) => subject.id));

  // 仅录入当前生效科目（语数英 + 选中小科 + 总分校排）；总分分数始终自动计算
  activeSubjects.forEach((subject) => {
    const isTotal = subject.id === "total";
    const score = isTotal ? undefined : readOptionalNumber(formData, `${subject.id}Score`);
    const rank = readOptionalNumber(formData, `${subject.id}Rank`);

    if (score !== undefined) {
      if (!Number.isFinite(score) || score < 0 || score > subject.fullMark) {
        throw new Error(`${subject.name}原始分需在 0-${subject.fullMark} 之间。`);
      }
      scores[subject.id] = score;
    }

    if (!isTotal && !CORE_SUBJECT_IDS.includes(subject.id)) {
      const assignedScore = readOptionalNumber(formData, `${subject.id}Assigned`);
      if (assignedScore !== undefined) {
        if (!Number.isFinite(assignedScore) || assignedScore < 0 || assignedScore > ELECTIVE_FULL_MARK) {
          throw new Error(`${subject.name}赋分需在 0-${ELECTIVE_FULL_MARK} 之间。`);
        }
        assignedScores[subject.id] = assignedScore;
      }
    }

    if (rank !== undefined) {
      if (!Number.isInteger(rank) || rank < 1 || rank > 200) {
        throw new Error(`${subject.name}校排需为 1-200 的整数。`);
      }
      ranks[subject.id] = rank;
    }
  });
  // 全保留：编辑时保留该记录里未选小科的旧分数/校排/赋分（界面不显示但不删）
  if (existingRecord) {
    Object.keys(existingRecord.scores || {}).forEach((subjectId) => {
      if (!activeSubjectIds.has(subjectId) && existingRecord.scores[subjectId] !== undefined) {
        scores[subjectId] = existingRecord.scores[subjectId];
      }
    });
    Object.keys(existingRecord.ranks || {}).forEach((subjectId) => {
      if (!activeSubjectIds.has(subjectId) && existingRecord.ranks[subjectId] !== undefined) {
        ranks[subjectId] = existingRecord.ranks[subjectId];
      }
    });
    Object.keys(getAssignedScores(existingRecord)).forEach((subjectId) => {
      if (!activeSubjectIds.has(subjectId) && getAssignedScores(existingRecord)[subjectId] !== undefined) {
        assignedScores[subjectId] = getAssignedScores(existingRecord)[subjectId];
      }
    });
  }

  writeComputedTotals(scores, assignedScores);

  const now = new Date().toISOString();
  return {
    id: existingRecord?.id || makeRecordId(),
    shortName,
    date,
    scores,
    assignedScores,
    ranks,
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now
  };
}
async function saveRecordFromForm(form, existingRecord) {
  const record = readRecordFromForm(form, existingRecord);
  await putRecord(record);
  await refreshRecords();
  return record;
}

function getVisibleExams() {
  return modalState.showAll ? sortedExams : sortedExams.slice(-RECENT_LIMIT);
}

function getSeries(subjectId, metric) {
  return getVisibleExams().map((exam) => {
    const value = getTrendMetricValue(exam, subjectId, metric);
    return {
      label: exam.shortName,
      date: exam.date,
      value: hasValidScore(value) ? value : null
    };
  });
}

function niceRankAxis(values) {
  const finiteValues = values.filter(hasValidScore);
  if (!finiteValues.length) return { top: 1, bottom: 20, ticks: [1, 5, 10, 15, 20] };
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  let top = Math.max(1, Math.floor((min - 8) / 10) * 10);
  let bottom = Math.min(200, Math.ceil((max + 8) / 10) * 10);

  if (top < 1) top = 1;
  if (bottom - top < 20) bottom = Math.min(200, top + 20);
  if (bottom === top) bottom = Math.min(200, top + 10);

  const range = bottom - top;
  const step = range <= 25 ? 5 : range <= 70 ? 10 : 20;
  const ticks = [];
  for (let tick = top; tick <= bottom; tick += step) {
    ticks.push(tick);
  }
  if (ticks[ticks.length - 1] !== bottom) ticks.push(bottom);
  return { top, bottom, ticks };
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function createSvgElement(name, attrs = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    element.setAttribute(key, String(value));
  });
  return element;
}

function assertTrendModalReady() {
  const missing = [
    ["[data-modal]", modalLayer],
    ["[data-chart]", chart],
    ["[data-chart-scroll]", chartScroll],
    ["[data-chart-help]", chartHelp],
    ["[data-modal-title]", modalTitle],
    ["[data-modal-subtitle]", modalSubtitle],
    ["[data-point-summary]", pointSummary],
    ["[data-show-all]", showAllInput],
    ["[data-metric-tabs]", metricTabs]
  ].filter(([, element]) => !element).map(([selector]) => selector);

  if (missing.length) throw new Error(`趋势弹窗缺少必要节点：${missing.join(", ")}`);
}

function renderChart() {
  assertTrendModalReady();
  const subject = getTrendSubject(modalState.subjectId);
  const metrics = getTrendMetrics(subject.id);
  const metric = metrics.includes(modalState.metric) ? modalState.metric : metrics[0];
  modalState.metric = metric;
  const metricLabel = getTrendMetricLabel(subject.id, metric);
  const points = getSeries(subject.id, metric);
  const validPoints = points.filter((point) => point.value !== null);
  const allCount = sortedExams.filter((exam) => hasValidScore(getTrendMetricValue(exam, subject.id, metric))).length;
  const width = modalState.showAll ? Math.max(560, points.length * 96 + 128) : 560;
  const height = 330;
  const margin = { top: 34, right: 28, bottom: 72, left: 54 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  chart.style.minWidth = `${width}px`;
  chart.style.setProperty("--chart-color", subject.color || DEFAULT_SUBJECT_COLOR);
  chart.setAttribute("aria-label", `${subject.name}${metricLabel}趋势折线图`);

  clearSvg(chart);

  if (!validPoints.length) {
    const emptyText = trendMetrics[metric]?.emptyText || "暂无数据";
    chart.appendChild(createSvgElement("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "axis-label" })).textContent = emptyText;
    modalSubtitle.textContent = `${subject.name} · ${metricLabel}暂无记录`;
    pointSummary.textContent = "保存对应口径的数据后会自动生成趋势图。";
    chartHelp.textContent = emptyText;
    return;
  }

  let yForValue;
  let ticks;
  let axisLabel;

  if (metric === "rank") {
    const axis = niceRankAxis(validPoints.map((point) => point.value));
    ticks = axis.ticks;
    yForValue = (value) => margin.top + ((value - axis.top) / (axis.bottom - axis.top)) * innerHeight;
    axisLabel = "校排（1 在顶部，数字越小越好）";
    chartHelp.textContent = "排名图为反向阅读：校排 1 在最上方，数字向下增大，线越高代表排名越好。";
  } else {
    const fullMark = Number.isFinite(subject.fullMark) && subject.fullMark > 0 ? subject.fullMark : ELECTIVE_FULL_MARK;
    ticks = [fullMark, Math.round(fullMark * 0.75), Math.round(fullMark * 0.5), Math.round(fullMark * 0.25), 0];
    yForValue = (value) => margin.top + (1 - value / fullMark) * innerHeight;
    axisLabel = metric === "assigned" ? `${subject.name}赋分满分 ${fullMark} · 越高越好` : `${subject.name}满分 ${fullMark} · 越高越好`;
    chartHelp.textContent = metric === "assigned" ? "Y 轴顶部为本科赋分满分，数据线越高表示赋分越高。" : "Y 轴顶部为本科满分，数据线越高表示原始分越高。";
  }

  const xForIndex = (index) => margin.left + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);

  const gridGroup = createSvgElement("g");
  ticks.forEach((tick) => {
    const y = yForValue(tick);
    gridGroup.appendChild(createSvgElement("line", { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: "grid-line" }));
    const label = createSvgElement("text", { x: margin.left - 10, y: y + 4, "text-anchor": "end", class: "tick-label" });
    label.textContent = String(tick);
    gridGroup.appendChild(label);
  });
  chart.appendChild(gridGroup);

  chart.appendChild(createSvgElement("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, class: "axis-line" }));
  chart.appendChild(createSvgElement("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, class: "axis-line" }));

  const axisText = createSvgElement("text", { x: margin.left, y: 18, class: "axis-label" });
  axisText.textContent = axisLabel;
  chart.appendChild(axisText);

  const coordinates = points.map((point, index) => ({
    x: xForIndex(index),
    y: point.value === null ? null : yForValue(point.value),
    ...point
  }));

  const segments = [];
  let currentSegment = [];
  coordinates.forEach((point) => {
    if (point.value === null) {
      if (currentSegment.length) segments.push(currentSegment);
      currentSegment = [];
      return;
    }
    currentSegment.push(point);
  });
  if (currentSegment.length) segments.push(currentSegment);

  segments.forEach((segment) => {
    const linePath = segment.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    if (segment.length > 1) {
      const lastPoint = segment[segment.length - 1];
      const areaPath = `${linePath} L ${lastPoint.x.toFixed(1)} ${height - margin.bottom} L ${segment[0].x.toFixed(1)} ${height - margin.bottom} Z`;
      chart.appendChild(createSvgElement("path", { d: areaPath, class: "chart-area" }));
      chart.appendChild(createSvgElement("path", { d: linePath, class: "chart-line" }));
    }
  });

  coordinates.forEach((point, index) => {
    const tick = createSvgElement("text", {
      x: point.x,
      y: height - margin.bottom + 26,
      "text-anchor": points.length > 7 ? "end" : "middle",
      class: "axis-label",
      transform: points.length > 7 ? `rotate(-32 ${point.x} ${height - margin.bottom + 26})` : ""
    });
    tick.textContent = point.label;
    chart.appendChild(tick);

    if (index < coordinates.length - 1) {
      const next = coordinates[index + 1];
      const midX = (point.x + next.x) / 2;
      chart.appendChild(createSvgElement("circle", { cx: midX, cy: height - margin.bottom, r: 1.7, fill: "rgba(109,102,88,0.28)" }));
    }

    if (point.value === null) return;

    const dot = createSvgElement("circle", { cx: point.x, cy: point.y, r: 4.6, class: "chart-dot" });
    dot.appendChild(createSvgElement("title", {})).textContent = `${point.label} · ${metricLabel}：${metric === "rank" ? `第${point.value}` : formatNumber(point.value)}`;
    chart.appendChild(dot);

    const valueLabel = createSvgElement("text", {
      x: point.x,
      y: point.y - 10,
      "text-anchor": "middle",
      class: "chart-value"
    });
    valueLabel.textContent = metric === "rank" ? `第${point.value}` : formatNumber(point.value);
    chart.appendChild(valueLabel);
  });

  const visibleLabel = modalState.showAll ? `全部 ${points.length} 次` : `近 ${Math.min(RECENT_LIMIT, points.length)} 次考试`;
  modalSubtitle.textContent = `${subject.name} · ${metricLabel} · ${visibleLabel}`;
  pointSummary.textContent = validPoints.length === 1
    ? `当前只有 1 个有效点，再记录一次即可看到变化。`
    : `按考试日期排序，横轴显示学生自定义简称。当前可用 ${validPoints.length}/${points.length} 个点；缺失记录会断开，不跨点连线。全部记录中该口径共有 ${allCount} 个有效点。`;

  if (modalState.showAll) chartScroll.scrollLeft = chartScroll.scrollWidth;
}
function openTrend(subjectId, metric) {
  try {
    assertTrendModalReady();
    const subject = getTrendSubject(subjectId);
    const metrics = getTrendMetrics(subject.id);
    const requestedMetric = metrics.includes(metric) ? metric : metrics[0];
    const activeMetric = hasTrendData(subject.id, requestedMetric)
      ? requestedMetric
      : metrics.find((candidate) => hasTrendData(subject.id, candidate)) || requestedMetric;

    modalState.subjectId = subject.id;
    modalState.metric = activeMetric;
    modalState.showAll = false;
    showAllInput.checked = false;
    renderMetricButtons(subject.id, activeMetric);
    modalTitle.textContent = `${subject.name}趋势`;
    showLockingModal(modalLayer);
    renderChart();
  } catch (error) {
    handleTrendRenderError(error, "打开趋势弹窗失败");
  }
}
function closeTrend() {
  hideLockingModal(modalLayer);
}

function subjectRows(record) {
  return getActiveSubjects()
    .map((subject) => {
      const display = getSubjectScoreDisplay(record, subject.id);
      const hasRank = Number.isFinite(Number(record.ranks?.[subject.id]));
      const scoreHtml = display.isCore
        ? (display.hasRaw ? `${display.rawText} 分` : `<span class="score-empty">未录入</span>`)
        : display.hasAny
          ? `<span class="compact-dual-score score-dual">
              ${display.hasRaw ? `<span>原始分 ${display.rawText}</span>` : ""}
              ${display.hasRaw && display.hasAssigned ? `<i>/</i>` : ""}
              ${display.hasAssigned ? `<span class="is-assigned">赋分 ${display.assignedText}</span>` : ""}
            </span>`
          : `<span class="score-empty">未录入</span>`;
      return `
    <div class="grade-subject-row" style="--subject-color: ${subject.color}">
      <strong>${subject.name}</strong>
      <span>${scoreHtml}</span>
      <em>${hasRank ? `校排第 ${record.ranks[subject.id]}` : "未记录"}</em>
    </div>
  `;
    }).join("");
}

function renderGradeList() {
  const visibleRecords = listShowAllInput.checked ? sortedExams : sortedExams.slice(-RECENT_LIMIT);
  const modeText = listShowAllInput.checked ? `全部 ${sortedExams.length} 次` : `最近 ${Math.min(RECENT_LIMIT, sortedExams.length)} / ${sortedExams.length} 次`;
  listSummary.textContent = sortedExams.length ? `${modeText} · 按日期从早到晚排列` : "暂无保存记录。";

  if (!visibleRecords.length) {
    gradeList.innerHTML = `<div class="empty-list-card">还没有保存的考试。点击“新增记录”写入第一条成绩。</div>`;
    return;
  }

  gradeList.innerHTML = visibleRecords.map((record) => {
    const confirming = pendingDeleteId === record.id;
    return `
      <article class="grade-entry" data-record-id="${escapeHtml(record.id)}" tabindex="0" aria-label="查看 ${escapeHtml(record.shortName)}">
        <header class="grade-entry-header">
          <div>
            <h4 class="grade-entry-title">${escapeHtml(record.shortName)}</h4>
            <span class="grade-entry-date">${formatDateForDisplay(record.date)}</span>
          </div>
          <button class="grade-delete-button ${confirming ? "is-confirming" : ""}" type="button" data-delete-record="${escapeHtml(record.id)}">
            ${confirming ? "确认删除" : "删除"}
          </button>
        </header>
        <div class="grade-subject-list">${subjectRows(record)}</div>
      </article>
    `;
  }).join("");

  if (listShowAllInput.checked) gradeListScroll.scrollLeft = gradeListScroll.scrollWidth;
}

function editFields(record) {
  return getActiveSubjects().map((subject) => renderScoreFormRow(subject, record)).join("");
}

function openEditRecord(recordId, options = {}) {
  const { remember = true, scroll = true, transition = true } = options;
  const record = sortedExams.find((exam) => exam.id === recordId);
  if (!record) return;

  editingRecordId = recordId;
  pendingDeleteId = "";
  renderGradeList();
  editPanel.hidden = false;
  editPanel.innerHTML = `
    <header class="list-edit-header">
      <div>
        <p class="eyebrow">修改成绩</p>
        <h4>${escapeHtml(record.shortName)}</h4>
      </div>
      <button class="secondary-button" type="button" data-cancel-edit>收起编辑</button>
    </header>
    <form class="record-form" data-edit-form>
      <div class="form-card exam-card">
        <label class="field-block">
          <span>考试简称</span>
          <small>列表和趋势图显示此名称</small>
          <input name="examShortName" type="text" value="${escapeHtml(record.shortName)}" placeholder="二上月考1" autocomplete="off" />
        </label>
        <label class="field-block">
          <span>日期</span>
          <small>手填或点日历</small>
          <div class="date-input-row">
            <input name="examDateDisplay" type="text" inputmode="numeric" value="${formatDateForDisplay(record.date)}" placeholder="年/月/日" autocomplete="off" data-date-display />
            <input type="date" class="date-pick" data-date-pick value="${escapeHtml(record.date)}" aria-label="从日历选择日期" tabindex="-1" />
          </div>
          <input name="examDate" type="hidden" value="${escapeHtml(record.date)}" data-date-value />
          <small class="date-hint" data-date-hint></small>
        </label>
      </div>
      <div class="score-table" aria-label="Edit subject scores and school ranks">
        <div class="score-table-head" aria-hidden="true">
          <span>科目</span>
          <span>分数</span>
          <span>校排</span>
        </div>
        ${editFields(record)}
      </div>
      <footer class="list-edit-actions">
        <p data-edit-status>保存后会覆盖这条 IndexedDB 记录。</p>
        <button class="primary-link-button" type="submit">保存修改</button>
      </footer>
    </form>
  `;
  if (remember) rememberActiveView(activeViews.edit, recordId);
  if (scroll) editPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  if (transition) playSceneTransition();
}

async function deleteRecordWithConfirmation(recordId) {
  if (pendingDeleteId !== recordId) {
    pendingDeleteId = recordId;
    renderGradeList();
    return;
  }

  await removeRecord(recordId);
  if (editingRecordId === recordId) {
    editingRecordId = "";
    editPanel.hidden = true;
    rememberActiveView(activeViews.list);
  }
  pendingDeleteId = "";
  await refreshRecords();
}

enterButton.addEventListener("click", () => {
  markEnteredThisSession();
  app.classList.add("has-entered");
  rememberActiveView(activeViews.dashboard);
  playSceneTransition();
  maybeShowSubjectOnboarding();
});

replayCoverButton.addEventListener("click", () => {
  app.classList.remove("has-entered");
});

document.addEventListener("input", (event) => {
  const displayInput = event.target.closest("[data-date-display]");
  if (!displayInput) return;
  syncDateField(displayInput);
  updateDateHint(displayInput);
  const wrap = displayInput.closest(".field-block");
  const hidden = wrap ? wrap.querySelector("[data-date-value]") : null;
  const picker = wrap ? wrap.querySelector("[data-date-pick]") : null;
  if (picker && hidden && hidden.value) picker.value = hidden.value;
});

document.addEventListener("change", (event) => {
  const picker = event.target.closest("[data-date-pick]");
  if (!picker) return;
  const wrap = picker.closest(".field-block");
  const displayInput = wrap ? wrap.querySelector("[data-date-display]") : null;
  const hidden = wrap ? wrap.querySelector("[data-date-value]") : null;
  if (!picker.value || !displayInput || !hidden) return;
  hidden.value = picker.value;
  displayInput.value = formatDateForDisplay(picker.value);
  updateDateHint(displayInput);
});

document.addEventListener("click", (event) => {
  const picker = event.target.closest("[data-date-pick]");
  if (!picker || typeof picker.showPicker !== "function") return;
  try { picker.showPicker(); } catch (error) { /* 已打开或不支持则忽略 */ }
});

document.addEventListener("blur", (event) => {
  const displayInput = event.target.closest("[data-date-display]");
  if (displayInput) syncDateField(displayInput, true);
}, true);

showAddButton.addEventListener("click", showAddPage);
showListButton.addEventListener("click", showGradeListPage);
showAnalysisButton.addEventListener("click", showAnalysisPage);
showDashboardButton.addEventListener("click", showDashboardPage);
showAddFromListButton.addEventListener("click", showAddPage);
showDashboardFromListButton.addEventListener("click", showDashboardPage);
showDashboardFromAnalysisButton.addEventListener("click", showDashboardPage);
if (showProfileButton) showProfileButton.addEventListener("click", () => showProfilePage());
if (showDashboardFromProfileButton) showDashboardFromProfileButton.addEventListener("click", showDashboardPage);
if (editNameProfileButton) editNameProfileButton.addEventListener("click", () => {
  const anchor = document.querySelector(".profile-name-line");
  openStudentNameEditor(anchor);
});
if (exportFromProfileButton) exportFromProfileButton.addEventListener("click", () => exportRecords());
document.querySelector("[data-delete-custom-avatar]")?.addEventListener("click", () => deleteCurrentCustomAvatar());
document.querySelector("[data-clear-identity]")?.addEventListener("click", () => clearIdentityData());
document.querySelector("[data-clear-all-data]")?.addEventListener("click", () => clearAllLocalData());
if (openPrivacyButton) openPrivacyButton.addEventListener("click", () => { if (privacyModal) privacyModal.hidden = false; });
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-privacy]")) {
    if (privacyModal) privacyModal.hidden = true;
  }
});

// —— 录入表单科目行：按当前生效科目动态生成 ——
function renderScoreFormRow(subject, record = null) {
  const isTotal = subject.id === "total";
  const isCoreSubject = CORE_SUBJECT_IDS.includes(subject.id);
  const scoreValue = !isTotal && hasValidScore(record?.scores?.[subject.id]) ? escapeHtml(record.scores[subject.id]) : "";
  const assignedValue = !isTotal && hasValidScore(getAssignedScores(record)[subject.id]) ? escapeHtml(getAssignedScores(record)[subject.id]) : "";
  const rankValue = Number.isFinite(Number(record?.ranks?.[subject.id])) ? escapeHtml(record.ranks[subject.id]) : "";
  const scoreLabel = isCoreSubject ? "分数" : "原始";
  const scoreAriaLabel = isCoreSubject ? `${subject.name}分数` : `${subject.name}原始分`;
  const assignedInput = isCoreSubject ? "" : `
          <span class="score-input-field">
            <small>赋分</small>
            <input name="${subject.id}Assigned" type="number" inputmode="decimal" min="0" max="${ELECTIVE_FULL_MARK}" step="0.1" value="${assignedValue}" placeholder="${assignedPlaceholders[subject.id] || ""}" aria-label="${subject.name}赋分" />
          </span>`;
  const scoreInputs = isTotal
    ? `<span class="auto-total-hint"><strong>自动计算</strong><small>按语数英 + 已选小科实时求和</small></span>`
    : `<span class="score-inputs ${isCoreSubject ? "score-inputs-single" : ""}">
          <span class="score-input-field">
            <small>${scoreLabel}</small>
            <input name="${subject.id}Score" type="number" inputmode="decimal" min="0" max="${subject.fullMark}" step="0.1" value="${scoreValue}" placeholder="${scorePlaceholders[subject.id] || ""}" aria-label="${scoreAriaLabel}" />
          </span>${assignedInput}
        </span>`;

  return `
      <label class="score-row ${isTotal ? "total-row" : ""}" style="--subject-color: ${subject.color}">
        <span class="score-subject">${subject.name}<small>满分 ${subject.fullMark}</small></span>
        ${scoreInputs}
        <span class="score-input-field score-rank-field">
          <small>校排</small>
          <input name="${subject.id}Rank" type="number" inputmode="numeric" min="1" max="200" step="1" value="${rankValue}" placeholder="校排" aria-label="${subject.name}校排" />
        </span>
      </label>`;
}

function renderScoreFormRows() {
  if (!scoreRowsContainer) return;
  scoreRowsContainer.innerHTML = getActiveSubjects().map((subject) => renderScoreFormRow(subject)).join("");
}
function updateSubjectsSummary() {
  if (!subjectsSummaryLabel) return;
  const electiveNames = getSelectedElectiveIds().map((id) => subjectDefById.get(id)?.name).filter(Boolean);
  const tail = electiveNames.length ? electiveNames.join("、") : "暂未选小科";
  subjectsSummaryLabel.textContent = `语数英 + ${tail} · 总分满分 ${getTotalFullMark()}`;
}

// —— 选科弹窗 ——
function buildSubjectsModalChoices(selectedIds) {
  if (subjectsCoreGrid) {
    subjectsCoreGrid.innerHTML = CORE_SUBJECTS.map((subject) => `
      <div class="subject-choice is-locked" style="--subject-color: ${subject.color}">
        <span class="subject-choice-check" aria-hidden="true">✓</span>
        <span class="subject-choice-name">${subject.name}</span>
        <span class="subject-choice-mark">满分 ${subject.fullMark} · 必选</span>
      </div>`).join("");
  }
  if (subjectsElectivesGrid) {
    subjectsElectivesGrid.innerHTML = ELECTIVE_POOL.map((subject) => `
      <label class="subject-choice subject-choice-pick ${selectedIds.includes(subject.id) ? "is-chosen" : ""}" style="--subject-color: ${subject.color}">
        <input type="checkbox" data-elective-option="${subject.id}" ${selectedIds.includes(subject.id) ? "checked" : ""} />
        <span class="subject-choice-check" aria-hidden="true">✓</span>
        <span class="subject-choice-name">${subject.name}</span>
        <span class="subject-choice-mark">满分 ${subject.fullMark}</span>
      </label>`).join("");
  }
}

function readSubjectsModalSelection() {
  if (!subjectsElectivesGrid) return [];
  return Array.from(subjectsElectivesGrid.querySelectorAll("[data-elective-option]"))
    .filter((input) => input.checked)
    .map((input) => input.dataset.electiveOption);
}

function updateSubjectsModalPreview() {
  if (!subjectsTotalPreview) return;
  const count = readSubjectsModalSelection().length;
  subjectsTotalPreview.textContent = `当前总分满分：${CORE_FULL_MARK_SUM + count * ELECTIVE_FULL_MARK}`;
}

function openSubjectsModal(mode) {
  if (!subjectsModal) return;
  subjectsModalMode = mode;
  const selectedIds = hasChosenSubjects() ? getSelectedElectiveIds() : DEFAULT_ELECTIVE_IDS;
  buildSubjectsModalChoices(selectedIds);
  updateSubjectsModalPreview();
  const isEdit = mode === "edit";
  if (subjectsKicker) subjectsKicker.textContent = isEdit ? "随时可以调整你的科目" : "第一次来，先选择你的科目";
  if (subjectsTitleEl) subjectsTitleEl.textContent = isEdit ? "修改选科" : "个人选科";
  if (subjectsCloseButton) subjectsCloseButton.hidden = !isEdit;
  showLockingModal(subjectsModal);
}

function closeSubjectsModal() {
  if (!subjectsModal) return;
  hideLockingModal(subjectsModal);
}

async function confirmSubjectsSelection() {
  setSelectedElectiveIds(readSubjectsModalSelection());
  closeSubjectsModal();
  renderScoreFormRows();
  updateSubjectsSummary();
  await refreshRecords();
  if (viewingRecordId) {
    const record = sortedExams.find((exam) => exam.id === viewingRecordId);
    if (record) renderExamDetail(record);
  }
  renderProfile();
}

function maybeShowSubjectOnboarding() {
  if (!hasChosenSubjects()) openSubjectsModal("onboarding");
}

if (openSubjectsButton) openSubjectsButton.addEventListener("click", () => openSubjectsModal("edit"));
if (openSubjectsHeroButton) openSubjectsHeroButton.addEventListener("click", () => openSubjectsModal("edit"));
if (subjectsConfirmButton) subjectsConfirmButton.addEventListener("click", () => { confirmSubjectsSelection(); });
if (subjectsCloseButton) subjectsCloseButton.addEventListener("click", closeSubjectsModal);
if (subjectsScrim) subjectsScrim.addEventListener("click", () => { if (subjectsModalMode === "edit") closeSubjectsModal(); });
if (subjectsElectivesGrid) {
  subjectsElectivesGrid.addEventListener("change", (event) => {
    const input = event.target.closest("[data-elective-option]");
    if (!input) return;
    const label = input.closest(".subject-choice-pick");
    if (label) label.classList.toggle("is-chosen", input.checked);
    updateSubjectsModalPreview();
  });
}

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  recordStatus.textContent = "正在保存…";
  try {
    syncDateFields(recordForm, { format: true });
    await saveRecordFromForm(recordForm);
    recordForm.reset();
    recordStatus.textContent = "已保存到本机 IndexedDB。";
    listShowAllInput.checked = true;
    showGradeListPage();
  } catch (error) {
    recordStatus.textContent = error.message;
  }
});

subjectGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-trend]");
  if (!button) return;
  openTrend(button.dataset.subject, button.dataset.openTrend);
});

gradeList.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-delete-record]");
  if (deleteButton) {
    event.stopPropagation();
    await deleteRecordWithConfirmation(deleteButton.dataset.deleteRecord);
    return;
  }

  const entry = event.target.closest("[data-record-id]");
  if (entry) showExamDetailPage(entry.dataset.recordId);
});

gradeList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const entry = event.target.closest("[data-record-id]");
  if (entry) showExamDetailPage(entry.dataset.recordId);
});

detailEditButton.addEventListener("click", () => {
  const recordId = viewingRecordId;
  if (!recordId) return;
  showGradeListPage({ remember: false, scroll: false, transition: false });
  openEditRecord(recordId);
});

detailBackButton.addEventListener("click", () => showGradeListPage());

shareExamButton.addEventListener("click", async () => {
  shareStatus.textContent = "正在生成考试长图…";
  try {
    await openGeneratedShare("exam");
  } catch (error) {
    shareStatus.textContent = `生成失败：${error.message}`;
  }
});

shareAnalysisButton.addEventListener("click", async () => {
  shareStatus.textContent = "正在生成分析长图…";
  try {
    await openGeneratedShare("analysis");
  } catch (error) {
    shareStatus.textContent = `生成失败：${error.message}`;
  }
});

shareDownload.addEventListener("click", async (event) => {
  if (!shareActionState || shareActionState.mode === shareActionModes.download) return;
  event.preventDefault();

  if (shareActionState.mode === shareActionModes.share) {
    await shareGeneratedPng();
    return;
  }

  promptLongPressSave();
});

shareModal.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-share]")) closeShareModal();
});
listShowAllInput.addEventListener("change", () => {
  pendingDeleteId = "";
  renderGradeList();
});

editPanel.addEventListener("click", (event) => {
  if (!event.target.closest("[data-cancel-edit]")) return;
  editingRecordId = "";
  editPanel.hidden = true;
  rememberActiveView(activeViews.list);
});

editPanel.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-edit-form]");
  if (!form) return;
  event.preventDefault();

  const status = editPanel.querySelector("[data-edit-status]");
  const existingRecord = sortedExams.find((exam) => exam.id === editingRecordId);
  status.textContent = "正在保存修改…";

  try {
    syncDateFields(form, { format: true });
    const savedRecord = await saveRecordFromForm(form, existingRecord);
    status.textContent = "已保存修改。";
    openEditRecord(savedRecord.id);
  } catch (error) {
    status.textContent = error.message;
  }
});

modalLayer.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-modal]")) closeTrend();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!shareModal.hidden) closeShareModal();
  if (!modalLayer.hidden) closeTrend();
  if (subjectsModalMode === "edit" && subjectsModal && !subjectsModal.hidden) closeSubjectsModal();
});

if (metricTabs) {
  metricTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-metric]");
    if (!button) return;
    modalState.metric = button.dataset.metric;
    metricButtons.forEach((metricButton) => metricButton.classList.toggle("is-active", metricButton === button));
    try {
      renderChart();
    } catch (error) {
      handleTrendRenderError(error, "切换趋势口径失败");
    }
  });
}

showAllInput.addEventListener("change", () => {
  modalState.showAll = showAllInput.checked;
  try {
    renderChart();
  } catch (error) {
    handleTrendRenderError(error, "切换趋势范围失败");
  }
});

exportRecordsButton.addEventListener("click", async () => {
  backupStatus.textContent = "正在整理 IndexedDB 记录…";
  try {
    await exportRecords();
  } catch (error) {
    backupStatus.textContent = `导出失败：${error.message}`;
  }
});

importRecordsButton.addEventListener("click", () => {
  importFileInput.click();
});

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files?.[0];
  if (!file) return;

  try {
    await importRecordsFromFile(file);
  } catch (error) {
    backupStatus.textContent = `导入失败：${error.message}`;
  } finally {
    importFileInput.value = "";
  }
});

["dragover", "drop"].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    event.preventDefault();
  });
});

backupPanel.addEventListener("dragenter", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  setBackupDropState(true);
});

backupPanel.addEventListener("dragover", (event) => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  setBackupDropState(true);
});

backupPanel.addEventListener("dragleave", (event) => {
  if (backupPanel.contains(event.relatedTarget)) return;
  setBackupDropState(false);
});

backupPanel.addEventListener("drop", async (event) => {
  event.preventDefault();
  setBackupDropState(false);
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  await importDroppedBackupFile(file);
});

async function requestPersistentStorage() {
  if (!window.isSecureContext || !navigator.storage?.persist) {
    console.info("Scornal storage persistence skipped outside a secure context.");
    return;
  }
  try {
    await navigator.storage.persist();
  } catch (error) {
    console.warn("Scornal storage persistence request failed", error);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const host = window.location.hostname;
  const isLocalDev = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (isLocalDev) {
    // 开发环境：注销 SW + 清掉旧缓存，避免缓存旧文件干扰调试
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("scornal-app-shell-")).map((key) => caches.delete(key)));
      }
    } catch (error) {
      console.warn("Scornal dev service worker cleanup failed", error);
    }
    return;
  }
  if (!window.isSecureContext) {
    console.info("Scornal service worker skipped outside a secure context.");
    return;
  }
  try {
    await navigator.serviceWorker.register(`./sw.js?v=${SERVICE_WORKER_VERSION}`, { scope: "./" });
  } catch (error) {
    console.warn("Scornal service worker registration failed", error);
  }
}

function restoreSessionView() {
  if (!hasEnteredThisSession()) return;

  app.classList.add("has-entered");
  const viewId = sessionStorage.getItem(SESSION_VIEW_KEY) || activeViews.dashboard;

  if (viewId === activeViews.add) {
    showAddPage({ remember: false, scroll: false, focus: false, transition: false });
    return;
  }

  if (viewId === activeViews.list) {
    showGradeListPage({ remember: false, scroll: false, transition: false });
    return;
  }

  if (viewId === activeViews.analysis) {
    showAnalysisPage({ remember: false, scroll: false, transition: false });
    return;
  }

  if (viewId === activeViews.profile) {
    showProfilePage({ remember: false, scroll: false, transition: false });
    return;
  }

  if (viewId === activeViews.detail) {
    const recordId = sessionStorage.getItem(SESSION_EDIT_RECORD_KEY);
    if (recordId && sortedExams.some((exam) => exam.id === recordId)) {
      showExamDetailPage(recordId, { remember: false, scroll: false, transition: false });
    } else {
      showGradeListPage({ remember: false, scroll: false, transition: false });
    }
    return;
  }

  if (viewId === activeViews.edit) {
    showGradeListPage({ remember: false, scroll: false, transition: false });
    const recordId = sessionStorage.getItem(SESSION_EDIT_RECORD_KEY);
    if (recordId && sortedExams.some((exam) => exam.id === recordId)) {
      openEditRecord(recordId, { remember: false, scroll: false, transition: false });
    } else {
      rememberActiveView(activeViews.list);
    }
    return;
  }

  showDashboardPage({ remember: false, scroll: false, transition: false });
}

async function initializeApp() {
  // 先开库：头像系统要用它读自定义头像。开库失败也不能白屏，
  // 此时降级为"只有内置头像"，成绩部分再单独报错。
  let databaseError = null;
  try {
    recordsDatabase = await openRecordsDatabase();
  } catch (error) {
    databaseError = error;
  }

  avatarSystem = await createAvatarSystem({
    readSettings,
    writeSettings,
    showModal: showLockingModal,
    hideModal: hideLockingModal,
    onApply: () => renderProfile(),
    database: recordsDatabase
  });
  renderStudentName();
  renderScoreFormRows();
  updateSubjectsSummary();
  renderComplianceInventory();
  renderComplianceValues();
  if (databaseError) throw databaseError;
  await refreshRecords();
  restoreSessionView();
  if (hasEnteredThisSession()) maybeShowSubjectOnboarding();
  requestPersistentStorage();
  registerServiceWorker();
}

initializeApp().catch((error) => {
  recordStatus.textContent = `读取 IndexedDB 失败：${error.message}`;
  listSummary.textContent = "读取本机记录失败。";
});
