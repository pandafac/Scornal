// 统一身份头像渲染器 + 头像装扮面板。
// 所有位置（封面 / 首页 / 资料卡 / 详情 / 分享长图）都通过这里渲染，避免各页面各写一套。

import {
  drawVectorFrame, drawVectorFrameBackdrop, frameSvgMarkup,
  frameBackdropSvgMarkup, frameHasBackdrop, isStaticSize
} from "./avatar-frames.js";
import {
  ACCEPT_ATTRIBUTE,
  AvatarImageError,
  decodeToWorkingCanvas,
  validateSelectedFile
} from "./avatar-image.js";
import { createAvatarCropper } from "./avatar-cropper.js";
import { createAvatarStorage, isCustomAvatarId } from "./avatar-storage.js";

const CATALOG_URL = new URL("./assets/avatar-catalog.json", import.meta.url);
const DEFAULT_AVATAR_ID = "panda";
const DEFAULT_FRAME_ID = "none";
const CUSTOM_GROUP = "我的头像";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function assetUrl(path, base = CATALOG_URL) {
  return path ? new URL(path, base).href : "";
}

function resolveCatalog(rawCatalog) {
  const avatars = rawCatalog.avatars.map((avatar) => ({
    ...avatar,
    imageUrl: assetUrl(avatar.image),
    thumbUrl: assetUrl(avatar.thumb)
  }));
  const frames = rawCatalog.frames.map((frame) => {
    const rootUrl = assetUrl(frame.assetRoot);
    return {
      ...frame,
      parts: (frame.parts || []).map((part) => ({
        ...part,
        imageUrl: assetUrl(part.file, rootUrl)
      }))
    };
  });
  return { ...rawCatalog, avatars, frames };
}

// 兼容旧数据：settings.avatar 是 emoji 字符串时，映射到稳定的 avatarId。
// 第三个参数用于让"自定义头像"这种不在 catalog 里的 id 也能通过校验。
export function normalizeIdentitySettings(settings = {}, catalog, knownCustomIds = null) {
  const avatarsById = new Map(catalog.avatars.map((avatar) => [avatar.id, avatar]));
  const framesById = new Map(catalog.frames.map((frame) => [frame.id, frame]));
  const emojiByValue = new Map(
    catalog.avatars.filter((avatar) => avatar.type === "emoji").map((avatar) => [avatar.value, avatar])
  );
  const legacyAvatar = typeof settings.avatar === "string" ? emojiByValue.get(settings.avatar) : null;

  const customIsUsable = isCustomAvatarId(settings.avatarId)
    && (knownCustomIds ? knownCustomIds.has(settings.avatarId) : false);

  let avatarId;
  let avatarVariantId;
  if (customIsUsable) {
    avatarId = settings.avatarId;
    avatarVariantId = "local-photo-v1";
  } else {
    const avatar = avatarsById.get(settings.avatarId)
      || legacyAvatar
      || avatarsById.get(catalog.defaultAvatarId || DEFAULT_AVATAR_ID)
      || catalog.avatars[0];
    avatarId = avatar.id;
    avatarVariantId = avatar.avatarVariantId;
  }

  const frame = framesById.get(settings.frameId)
    || framesById.get(catalog.defaultFrameId || DEFAULT_FRAME_ID)
    || catalog.frames[0];

  const identity = { avatarId, frameId: frame.id, avatarVariantId };
  const needsMigration = settings.avatarId !== identity.avatarId
    || settings.frameId !== identity.frameId
    || settings.avatarVariantId !== identity.avatarVariantId;

  const emojiFallback = avatarsById.get(avatarId);
  return {
    identity,
    needsMigration,
    migratedSettings: {
      ...settings,
      ...identity,
      avatarSource: customIsUsable ? "local-album" : "builtin",
      avatar: emojiFallback?.type === "emoji"
        ? emojiFallback.value
        : (typeof settings.avatar === "string" ? settings.avatar : "🐣")
    }
  };
}

function avatarMediaMarkup(avatar, useThumb = false) {
  if (avatar.type === "emoji") {
    return `<span class="identity-avatar__emoji" aria-hidden="true">${escapeHtml(avatar.value)}</span>`;
  }
  const source = useThumb ? (avatar.thumbUrl || avatar.imageUrl) : avatar.imageUrl;
  return `<img class="identity-avatar__image" src="${escapeHtml(source)}" alt="" draggable="false" />`;
}

function pieceStyle(part) {
  return Object.entries({
    "--x": `${part.x}%`,
    "--y": `${part.y}%`,
    "--w": `${part.w}%`,
    "--h": `${part.h}%`,
    "--open-x": `${part.openX || 0}%`,
    "--open-y": `${part.openY || 0}%`,
    "--rx": `${part.rx || 0}deg`,
    "--ry": `${part.ry || 0}deg`,
    "--rz": `${part.rz || 0}deg`,
    "--pop-x": `${part.popX || 0}%`,
    "--pop-y": `${part.popY || 0}%`
  }).map(([key, value]) => `${key}:${value}`).join(";");
}

// 拆箱回应用真实插画切片；其余边框走矢量渲染。
function partsFrameMarkup(frame, size) {
  const showDetails = size >= (frame.detailMinSize || 96);
  const pieces = frame.parts.filter((part) => showDetails || part.role === "flap").map((part, index) => {
    const roleClass = part.role === "flap"
      ? "is-flap"
      : part.role === "emotion-small" ? "is-emotion is-small" : "is-emotion";
    return `<img class="identity-frame__piece ${roleClass} is-${escapeHtml(part.corner)}" data-frame-piece="${index}" src="${escapeHtml(part.imageUrl)}" alt="" draggable="false" style="${pieceStyle(part)}" />`;
  }).join("");
  return `<span class="identity-frame is-parts" aria-hidden="true" style="--frame-tempo:${frame.tempo || 16}s">${pieces}</span>`;
}

function frameMarkup(frame, palette, size) {
  if (!frame || frame.kind === "none") return "";
  if (frame.kind === "parts") return partsFrameMarkup(frame, size);
  return `<span class="identity-frame is-vector" aria-hidden="true">${frameSvgMarkup(frame, palette, size)}</span>`;
}

// 不透明底板要垫在头像下面，否则头像会被整块盖住。
function frameBackdrop(frame, palette) {
  if (!frameHasBackdrop(frame)) return "";
  return `<span class="identity-frame is-vector is-backdrop" aria-hidden="true">${frameBackdropSvgMarkup(frame, palette)}</span>`;
}

// 网格里的方向键导航
function nearestGridButton(event, selector) {
  const button = event.target.closest(selector);
  if (!button) return null;
  const grid = button.parentElement;
  const buttons = Array.from(grid.querySelectorAll(selector));
  const index = buttons.indexOf(button);
  if (index < 0) return null;
  const columnCount = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length);
  const movement = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -columnCount,
    ArrowDown: columnCount,
    Home: -index,
    End: buttons.length - index - 1
  }[event.key];
  if (!Number.isFinite(movement)) return null;
  event.preventDefault();
  return buttons[Math.max(0, Math.min(buttons.length - 1, index + movement))];
}

function roundedRectPath(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export async function createAvatarSystem(options) {
  const response = await fetch(CATALOG_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`头像目录读取失败：HTTP ${response.status}`);
  const catalog = resolveCatalog(await response.json());
  const palette = catalog.palette || {};
  const builtinById = new Map(catalog.avatars.map((avatar) => [avatar.id, avatar]));
  const framesById = new Map(catalog.frames.map((frame) => [frame.id, frame]));
  const imagePromises = new Map();

  // 自定义头像存在 IndexedDB，运行时并进查找表；设置里只存 avatarId 引用。
  const storage = options.database ? createAvatarStorage(options.database) : null;
  let customAvatars = [];

  const studio = document.querySelector("[data-avatar-studio]");
  const preview = document.querySelector("[data-avatar-studio-preview]");
  const previewLabel = document.querySelector("[data-avatar-studio-label]");
  const avatarGroups = document.querySelector("[data-avatar-catalog-groups]");
  const frameGrid = document.querySelector("[data-frame-catalog-grid]");
  const fileInput = document.querySelector("[data-avatar-file-input]");
  const studioStatus = document.querySelector("[data-avatar-studio-status]");
  const tabButtons = Array.from(document.querySelectorAll("[data-avatar-studio-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-avatar-studio-panel]"));

  let currentIdentity;
  let draftIdentity;
  let lastFocusedElement = null;

  if (fileInput) fileInput.setAttribute("accept", ACCEPT_ATTRIBUTE);

  function customIds() {
    return new Set(customAvatars.map((avatar) => avatar.id));
  }

  function lookupAvatar(id) {
    return builtinById.get(id) || customAvatars.find((avatar) => avatar.id === id) || null;
  }

  function safeAvatar(id) {
    return lookupAvatar(id)
      || builtinById.get(catalog.defaultAvatarId || DEFAULT_AVATAR_ID)
      || catalog.avatars[0];
  }

  function safeFrame(id) {
    return framesById.get(id) || framesById.get(DEFAULT_FRAME_ID) || catalog.frames[0];
  }

  async function reloadCustomAvatars() {
    if (!storage) return;
    customAvatars = await storage.list();
  }

  function setStudioStatus(message, tone = "info") {
    if (!studioStatus) return;
    studioStatus.textContent = message || "";
    studioStatus.dataset.tone = tone;
  }

  function normalizeIdentity(settings, persistMigration = true) {
    const normalized = normalizeIdentitySettings(settings, catalog, customIds());
    if (persistMigration && normalized.needsMigration) {
      options.writeSettings(normalized.migratedSettings);
    }
    return normalized.identity;
  }

  // 唯一的头像渲染入口。size 决定是否简化装饰与是否允许动效。
  function identityMarkup(identity = currentIdentity, config = {}) {
    const avatar = safeAvatar(identity.avatarId);
    const frame = safeFrame(identity.frameId);
    const size = Number(config.size) || 56;
    const requested = config.motion || "static";
    // 小尺寸一律静态：动效在 40px 上只会变成抖动的噪点。
    const motion = isStaticSize(frame, size) ? "static" : requested;
    const hasFrame = frame.kind !== "none";
    const label = `${avatar.label}${hasFrame ? `，${frame.label}边框` : ""}`;
    const classes = [
      "identity-avatar",
      hasFrame ? "has-frame" : "has-no-frame",
      `is-${motion}-motion`,
      avatar.type === "custom" ? "is-custom-avatar" : ""
    ].filter(Boolean).join(" ");
    const style = [
      `--avatar-size:${size}px`,
      `--avatar-inset:${((frame.avatarInset ?? 0) * 100).toFixed(2)}%`,
      `--avatar-radius:${((frame.avatarRadius ?? 0.5) * 100).toFixed(2)}%`
    ].join(";");
    return `<span class="${classes}" style="${style}" role="img" aria-label="${escapeHtml(label)}" data-avatar-id="${escapeHtml(avatar.id)}" data-frame-id="${escapeHtml(frame.id)}">${frameBackdrop(frame, palette)}<span class="identity-avatar__crop">${avatarMediaMarkup(avatar, Boolean(config.thumb))}</span>${frameMarkup(frame, palette, size)}</span>`;
  }

  function renderSlots() {
    document.querySelectorAll("[data-identity-avatar-slot]").forEach((slot) => {
      slot.innerHTML = identityMarkup(currentIdentity, {
        size: Number(slot.dataset.avatarSize) || 56,
        motion: slot.dataset.avatarMotion || "static",
        thumb: slot.dataset.avatarThumb === "true"
      });
    });
  }

  function optionMarkup(avatar) {
    const selected = avatar.id === draftIdentity.avatarId;
    return `<button type="button" class="avatar-catalog-option" data-avatar-choice="${escapeHtml(avatar.id)}" aria-label="选择${escapeHtml(avatar.label)}" aria-pressed="${selected}">${avatarMediaMarkup(avatar, true)}<span>${escapeHtml(avatar.label)}</span></button>`;
  }

  function customGroupMarkup() {
    const limit = storage?.limit ?? 6;
    const full = customAvatars.length >= limit;
    const cards = customAvatars.map((avatar) => {
      const selected = avatar.id === draftIdentity.avatarId;
      return `<div class="custom-avatar-card${selected ? " is-selected" : ""}">
        <button type="button" class="avatar-catalog-option" data-avatar-choice="${escapeHtml(avatar.id)}" aria-label="使用${escapeHtml(avatar.label)}" aria-pressed="${selected}">${avatarMediaMarkup(avatar, true)}<span>${escapeHtml(avatar.label)}</span></button>
        <div class="custom-avatar-actions">
          <button type="button" class="text-button" data-avatar-rename="${escapeHtml(avatar.id)}" aria-label="重命名${escapeHtml(avatar.label)}">重命名</button>
          <button type="button" class="text-button is-danger" data-avatar-delete="${escapeHtml(avatar.id)}" aria-label="删除${escapeHtml(avatar.label)}">删除</button>
        </div>
      </div>`;
    }).join("");
    const hint = full
      ? `<p class="avatar-group-hint">已存满 ${limit} 张。要再添加，请先删除或替换一张。</p>`
      : `<p class="avatar-group-hint">最多保存 ${limit} 张，照片只留在这台设备上。</p>`;
    return `<section class="avatar-catalog-group">
      <h4>${CUSTOM_GROUP}</h4>
      <div class="custom-avatar-grid" role="group" aria-label="我的头像">
        ${cards}
        <button type="button" class="avatar-add-button" data-pick-avatar-file aria-label="从相册选择照片">
          <span class="avatar-add-icon" aria-hidden="true">＋</span>
          <span>从相册选择</span>
        </button>
      </div>
      ${hint}
    </section>`;
  }

  function renderAvatarGroups() {
    const grouped = new Map();
    catalog.avatars.forEach((avatar) => {
      if (!grouped.has(avatar.group)) grouped.set(avatar.group, []);
      grouped.get(avatar.group).push(avatar);
    });
    const builtinSections = Array.from(grouped.entries()).map(([group, avatars]) => `
      <section class="avatar-catalog-group">
        <h4>${escapeHtml(group)}</h4>
        <div class="avatar-catalog-grid" role="group" aria-label="${escapeHtml(group)}">
          ${avatars.map(optionMarkup).join("")}
        </div>
      </section>
    `).join("");
    avatarGroups.innerHTML = (storage ? customGroupMarkup() : "") + builtinSections;
  }

  function renderFrameGrid() {
    frameGrid.innerHTML = catalog.frames.map((frame) => {
      const frameIdentity = { ...draftIdentity, frameId: frame.id };
      return `<button type="button" class="frame-catalog-option" data-frame-choice="${escapeHtml(frame.id)}" aria-label="选择${escapeHtml(frame.label)}" aria-pressed="${frame.id === draftIdentity.frameId}">${identityMarkup(frameIdentity, { size: 72, motion: "static", thumb: true })}<span><strong>${escapeHtml(frame.label)}</strong><small>${escapeHtml(frame.description)}</small></span></button>`;
    }).join("");
  }

  function renderDraft() {
    const avatar = safeAvatar(draftIdentity.avatarId);
    const frame = safeFrame(draftIdentity.frameId);
    preview.innerHTML = identityMarkup(draftIdentity, { size: 160, motion: "preview" });
    previewLabel.textContent = `${avatar.label} · ${frame.label}`;
    renderAvatarGroups();
    renderFrameGrid();
  }

  function selectTab(tabId) {
    tabButtons.forEach((button) => {
      const selected = button.dataset.avatarStudioTab === tabId;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.avatarStudioPanel !== tabId;
    });
  }

  async function openStudio() {
    await reloadCustomAvatars();
    draftIdentity = { ...currentIdentity };
    lastFocusedElement = document.activeElement;
    renderDraft();
    selectTab("avatar");
    setStudioStatus("");
    options.showModal(studio);
    tabButtons[0]?.focus({ preventScroll: true });
  }

  // 关闭 / Escape / 取消都要丢弃草稿，恢复到原组合。
  function closeStudio() {
    options.hideModal(studio);
    draftIdentity = { ...currentIdentity };
    setStudioStatus("");
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
      lastFocusedElement.focus({ preventScroll: true });
    }
  }

  async function applyDraft() {
    const avatar = safeAvatar(draftIdentity.avatarId);
    const settings = options.readSettings();
    const isCustom = avatar.type === "custom";
    currentIdentity = {
      avatarId: avatar.id,
      frameId: safeFrame(draftIdentity.frameId).id,
      avatarVariantId: isCustom ? "local-photo-v1" : avatar.avatarVariantId
    };
    options.writeSettings({
      ...settings,
      ...currentIdentity,
      avatarSource: isCustom ? "local-album" : "builtin",
      avatar: avatar.type === "emoji"
        ? avatar.value
        : (typeof settings.avatar === "string" ? settings.avatar : "🐣")
    });
    await resourcesFor(currentIdentity);
    renderSlots();
    options.onApply?.(currentIdentity);
    closeStudio();
  }

  function restoreDefaults() {
    draftIdentity = {
      avatarId: catalog.defaultAvatarId || DEFAULT_AVATAR_ID,
      frameId: catalog.defaultFrameId || DEFAULT_FRAME_ID,
      avatarVariantId: safeAvatar(catalog.defaultAvatarId || DEFAULT_AVATAR_ID).avatarVariantId
    };
    renderDraft();
    setStudioStatus("已恢复默认头像与边框，确认后生效。");
  }

  let cropper = null;
  let replaceTargetId = null;

  function ensureCropper() {
    if (cropper) return cropper;
    cropper = createAvatarCropper({
      showModal: options.showModal,
      hideModal: options.hideModal,
      // 裁切时实时显示当前草稿边框，所见即所得
      frameOverlayMarkup: () => {
        const frame = safeFrame(draftIdentity?.frameId);
        return frame.kind === "none" ? "" : frameMarkup(frame, palette, 320);
      },
      onReselect: () => pickFile(replaceTargetId),
      onCancel: () => setStudioStatus("已取消，头像没有改动。"),
      onConfirm: async ({ blob, thumbBlob, name, width, height }) => {
        const saved = await storage.add({ blob, thumbBlob, name, width, height, replaceId: replaceTargetId });
        replaceTargetId = null;
        await reloadCustomAvatars();
        draftIdentity.avatarId = saved.id;
        draftIdentity.avatarVariantId = "local-photo-v1";
        renderDraft();
        setStudioStatus(`已添加「${saved.label}」，点"应用"后生效。`, "success");
      }
    });
    return cropper;
  }

  // 只在用户点击后调用，交给系统选择器；应用只能读到用户本次选中的文件。
  function pickFile(replaceId = null) {
    if (!fileInput) return;
    // 先在入口挡住上限，避免让用户白裁一遍才被拒绝。storage.add 里仍有兜底检查。
    if (!replaceId && storage && customAvatars.length >= storage.limit) {
      setStudioStatus(
        `自定义头像最多保存 ${storage.limit} 张，现在已经存满了。请先删除一张，或在已有头像上选择替换。`,
        "error"
      );
      return;
    }
    replaceTargetId = replaceId;
    fileInput.value = "";
    fileInput.click();
  }

  async function handleFileSelection(file) {
    // 用户在系统选择器里取消：什么都不做，不报错、不改头像。
    if (!file) return;
    setStudioStatus("正在读取图片…");
    try {
      const validation = await validateSelectedFile(file);
      const working = await decodeToWorkingCanvas(file, validation);
      const notes = [];
      if (validation.mismatched) notes.push("文件后缀与实际格式不一致，已按实际格式处理。");
      if (working.downsampled) notes.push(`原图 ${working.sourceWidth}×${working.sourceHeight}，已安全缩小后再编辑。`);
      ensureCropper().open({
        workingCanvas: working,
        suggestedName: replaceTargetId
          ? (customAvatars.find((avatar) => avatar.id === replaceTargetId)?.label || "我的照片")
          : "我的照片",
        notice: notes.length ? notes.join(" ") : `已读取 ${validation.label} 图片，拖动调整位置。`
      });
      setStudioStatus("");
    } catch (error) {
      replaceTargetId = null;
      if (error instanceof AvatarImageError) {
        setStudioStatus(`${error.message}${error.hint ? ` ${error.hint}` : ""}`, "error");
      } else {
        setStudioStatus(`读取失败：${error?.message || error}`, "error");
      }
    }
  }

  async function renameCustomAvatar(id) {
    const avatar = customAvatars.find((item) => item.id === id);
    if (!avatar) return;
    const next = window.prompt("给这张头像起个名字", avatar.label);
    if (next === null) return;
    const trimmed = String(next).trim();
    if (!trimmed) {
      setStudioStatus("名字不能为空，没有改动。", "error");
      return;
    }
    await storage.rename(id, trimmed);
    await reloadCustomAvatars();
    renderDraft();
    setStudioStatus(`已改名为「${trimmed}」。`, "success");
  }

  // 删除当前正在用的头像后，自动落回安全默认头像，不留下空白状态。
  async function deleteCustomAvatar(id) {
    const avatar = customAvatars.find((item) => item.id === id);
    if (!avatar) return;
    if (!window.confirm(`删除「${avatar.label}」？这张照片会从本机移除，不可恢复。`)) return;
    await storage.remove(id);
    await reloadCustomAvatars();
    const fallbackId = catalog.defaultAvatarId || DEFAULT_AVATAR_ID;
    if (draftIdentity.avatarId === id) {
      draftIdentity.avatarId = fallbackId;
      draftIdentity.avatarVariantId = safeAvatar(fallbackId).avatarVariantId;
    }
    if (currentIdentity.avatarId === id) {
      currentIdentity = {
        ...currentIdentity,
        avatarId: fallbackId,
        avatarVariantId: safeAvatar(fallbackId).avatarVariantId
      };
      const settings = options.readSettings();
      options.writeSettings({ ...settings, ...currentIdentity, avatarSource: "builtin" });
      await resourcesFor(currentIdentity);
      renderSlots();
    }
    renderDraft();
    setStudioStatus(`已删除「${avatar.label}」。`, "success");
  }

  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (!imagePromises.has(url)) {
      imagePromises.set(url, new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`头像素材读取失败：${url}`));
        image.src = url;
      }));
    }
    return imagePromises.get(url);
  }

  async function canvasIdentityResources(identity = currentIdentity) {
    const avatar = safeAvatar(identity.avatarId);
    const frame = safeFrame(identity.frameId);
    const avatarImage = avatar?.imageUrl ? await loadImage(avatar.imageUrl) : null;
    const frameImages = new Map();
    if (frame?.kind === "parts") {
      await Promise.all(frame.parts.map(async (part) => frameImages.set(part.imageUrl, await loadImage(part.imageUrl))));
    }
    return { avatarImage, frameImages };
  }

  async function resourcesFor(identity = currentIdentity) {
    const resources = await canvasIdentityResources(identity);
    const avatar = safeAvatar(identity.avatarId);
    const frame = safeFrame(identity.frameId);
    if (avatar) avatar._canvasImage = resources.avatarImage;
    if (frame?.kind === "parts") {
      frame.parts.forEach((part) => { part._canvasImage = resources.frameImages.get(part.imageUrl); });
    }
    return resources;
  }

  // 分享长图：一律画静态完成态，不带动画中间帧。
  function drawCanvasIdentity(context, config = {}) {
    const identity = config.identity || currentIdentity;
    const avatar = safeAvatar(identity.avatarId);
    const frame = safeFrame(identity.frameId);
    const x = config.x || 0;
    const y = config.y || 0;
    const size = config.size || 56;
    const hasFrame = frame.kind !== "none";
    const cropInset = hasFrame ? size * (frame.avatarInset ?? 0.14) : 0;
    const cropSize = size - cropInset * 2;

    // 与 DOM 同序：先底板，再头像，最后装饰。
    drawVectorFrameBackdrop(context, frame, { x, y, size, palette });

    context.save();
    context.beginPath();
    roundedRectPath(context, x + cropInset, y + cropInset, cropSize, cropSize, cropSize * (frame.avatarRadius ?? 0.5));
    context.clip();
    context.fillStyle = palette.ivory || "#fff8ea";
    context.fillRect(x + cropInset, y + cropInset, cropSize, cropSize);
    if (avatar.type === "emoji") {
      context.font = `${Math.round(cropSize * 0.62)}px "Segoe UI Emoji", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(avatar.value, x + size / 2, y + size / 2 + cropSize * 0.03);
    } else {
      const image = config.avatarImage || avatar._canvasImage;
      if (image) context.drawImage(image, x + cropInset, y + cropInset, cropSize, cropSize);
    }
    context.restore();

    if (!hasFrame) return;
    if (frame.kind === "vector") {
      drawVectorFrame(context, frame, { x, y, size, palette });
      return;
    }
    frame.parts.forEach((part) => {
      const image = part._canvasImage || config.frameImages?.get(part.imageUrl);
      if (!image) return;
      // 用"打开完成"的位移，画出边框的完成态
      const completionX = part.role === "flap" ? (part.openX || 0) : (part.popX || 0);
      const completionY = part.role === "flap" ? (part.openY || 0) : (part.popY || 0);
      const partX = x + size * (part.x + completionX) / 100;
      const partY = y + size * (part.y + completionY) / 100;
      const partWidth = size * part.w / 100;
      const partHeight = size * part.h / 100;
      context.save();
      context.translate(partX + partWidth / 2, partY + partHeight / 2);
      context.rotate((part.rz || 0) * Math.PI / 180);
      context.drawImage(image, -partWidth / 2, -partHeight / 2, partWidth, partHeight);
      context.restore();
    });
  }

  document.querySelectorAll("[data-open-avatar-studio]").forEach((button) => button.addEventListener("click", () => { openStudio(); }));
  document.querySelectorAll("[data-close-avatar-studio], [data-cancel-avatar-studio]").forEach((button) => button.addEventListener("click", closeStudio));
  document.querySelector("[data-apply-avatar-studio]")?.addEventListener("click", () => { applyDraft(); });
  document.querySelector("[data-restore-avatar-default]")?.addEventListener("click", restoreDefaults);
  tabButtons.forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.avatarStudioTab)));
  fileInput?.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    handleFileSelection(file);
  });

  avatarGroups.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-pick-avatar-file]");
    if (pick) {
      pickFile(null);
      return;
    }
    const rename = event.target.closest("[data-avatar-rename]");
    if (rename) {
      renameCustomAvatar(rename.dataset.avatarRename);
      return;
    }
    const remove = event.target.closest("[data-avatar-delete]");
    if (remove) {
      deleteCustomAvatar(remove.dataset.avatarDelete);
      return;
    }
    const choice = event.target.closest("[data-avatar-choice]");
    if (!choice) return;
    draftIdentity.avatarId = choice.dataset.avatarChoice;
    draftIdentity.avatarVariantId = safeAvatar(draftIdentity.avatarId).avatarVariantId || "local-photo-v1";
    renderDraft();
    avatarGroups.querySelector(`[data-avatar-choice="${draftIdentity.avatarId}"]`)?.focus({ preventScroll: true });
  });

  frameGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-frame-choice]");
    if (!button) return;
    draftIdentity.frameId = button.dataset.frameChoice;
    renderDraft();
    cropper?.refreshFramePreview();
    frameGrid.querySelector(`[data-frame-choice="${draftIdentity.frameId}"]`)?.focus({ preventScroll: true });
  });

  avatarGroups.addEventListener("keydown", (event) => nearestGridButton(event, "[data-avatar-choice]")?.focus({ preventScroll: true }));
  frameGrid.addEventListener("keydown", (event) => nearestGridButton(event, "[data-frame-choice]")?.focus({ preventScroll: true }));

  // 桌面端轻微指针视差；触屏与 reduced-motion 下不启用。
  studio.addEventListener("pointermove", (event) => {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const avatar = preview.querySelector(".identity-avatar");
    if (!avatar) return;
    const rect = avatar.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const ny = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    avatar.style.setProperty("--parallax-x", `${(nx * 2).toFixed(2)}px`);
    avatar.style.setProperty("--parallax-y", `${(ny * 2).toFixed(2)}px`);
  });
  studio.addEventListener("pointerleave", () => {
    const avatar = preview.querySelector(".identity-avatar");
    avatar?.style.removeProperty("--parallax-x");
    avatar?.style.removeProperty("--parallax-y");
  });

  document.addEventListener("keydown", (event) => {
    if (studio.hidden) return;
    if (event.key === "Escape") closeStudio();
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.target.closest("[data-avatar-studio-tab]")) {
      event.preventDefault();
      const next = event.key === "ArrowRight" ? 1 : -1;
      const index = tabButtons.indexOf(event.target);
      const target = tabButtons[(index + next + tabButtons.length) % tabButtons.length];
      target.focus();
      selectTab(target.dataset.avatarStudioTab);
    }
  });

  await reloadCustomAvatars();
  currentIdentity = normalizeIdentity(options.readSettings());
  draftIdentity = { ...currentIdentity };
  await resourcesFor(currentIdentity);
  renderSlots();

  const api = {
    catalog,
    palette,
    getIdentity: () => ({ ...currentIdentity }),
    identityMarkup,
    renderSlots,
    openStudio,
    closeStudio,
    prepareCanvasIdentity: resourcesFor,
    drawCanvasIdentity,
    getAvatar: (id) => safeAvatar(id),
    getFrame: (id) => safeFrame(id),
    listCustomAvatars: () => customAvatars.map((avatar) => ({ ...avatar })),
    reloadCustomAvatars: async () => {
      await reloadCustomAvatars();
      currentIdentity = normalizeIdentity(options.readSettings());
      await resourcesFor(currentIdentity);
      renderSlots();
    },
    storage
  };
  window.scornalAvatarSystem = api;
  return api;
}
