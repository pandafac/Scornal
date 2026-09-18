// 头像裁切编辑器。
// 坐标模型：裁切框固定在中心，图片在其后平移缩放；所有几何都在"旋转后的图片空间"里算。

import {
  createRotatedCanvas,
  renderCroppedAvatar,
  rotatedSize
} from "./avatar-image.js";

const MAX_ZOOM_FACTOR = 5;

export function createAvatarCropper(options = {}) {
  const root = document.querySelector("[data-avatar-cropper]");
  if (!root) throw new Error("找不到头像裁切编辑器节点");

  const canvas = root.querySelector("[data-cropper-canvas]");
  const context = canvas.getContext("2d");
  const stage = root.querySelector("[data-cropper-stage]");
  const zoomSlider = root.querySelector("[data-cropper-zoom]");
  const statusText = root.querySelector("[data-cropper-status]");
  const nameInput = root.querySelector("[data-cropper-name]");
  const frameOverlay = root.querySelector("[data-cropper-frame]");
  const confirmButton = root.querySelector("[data-cropper-confirm]");

  // working: 已摆正并降采样的原图画布；rotated: 叠加用户旋转后的画布
  let working = null;
  let rotated = null;
  let rotation = 0;
  let scale = 1;
  let minScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let viewport = 320;
  let busy = false;
  let lastFocused = null;
  const pointers = new Map();
  let pinchStart = null;

  function setStatus(message, tone = "info") {
    if (!statusText) return;
    statusText.textContent = message;
    statusText.dataset.tone = tone;
  }

  // 裁切框在旋转后图片空间里的边长（图片像素）
  function cropSizeInImage() {
    return viewport / scale;
  }

  // 保证图片始终盖满裁切框：任何一边都不允许露出空白。
  function clampOffsets() {
    const cropSize = cropSizeInImage();
    const maxX = Math.max(0, rotated.width - cropSize);
    const maxY = Math.max(0, rotated.height - cropSize);
    offsetX = Math.min(maxX, Math.max(0, offsetX));
    offsetY = Math.min(maxY, Math.max(0, offsetY));
  }

  function computeMinScale() {
    // 缩到最小时，短边刚好等于裁切框
    return viewport / Math.min(rotated.width, rotated.height);
  }

  function syncZoomSlider() {
    if (!zoomSlider) return;
    const maxScale = minScale * MAX_ZOOM_FACTOR;
    const ratio = maxScale > minScale ? (scale - minScale) / (maxScale - minScale) : 0;
    zoomSlider.value = String(Math.round(ratio * 100));
    zoomSlider.setAttribute("aria-valuetext", `放大 ${(scale / minScale).toFixed(1)} 倍`);
  }

  // 以某个屏幕点为锚缩放：手指/指针下的那块画面保持不动。
  function zoomTo(nextScale, anchor = null) {
    const maxScale = minScale * MAX_ZOOM_FACTOR;
    const clamped = Math.min(maxScale, Math.max(minScale, nextScale));
    if (clamped === scale) return;
    const anchorX = anchor ? anchor.x : viewport / 2;
    const anchorY = anchor ? anchor.y : viewport / 2;
    const imageX = offsetX + anchorX / scale;
    const imageY = offsetY + anchorY / scale;
    scale = clamped;
    offsetX = imageX - anchorX / scale;
    offsetY = imageY - anchorY / scale;
    clampOffsets();
    syncZoomSlider();
    render();
  }

  function render() {
    if (!rotated) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelSize = Math.round(viewport * ratio);
    // 宽高都要比对：canvas 默认就是 300x150，若只判断宽度，
    // 当 viewport 刚好是 300 时高度会一直停在 150，画面被压扁并截掉下半。
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }
    canvas.style.width = `${viewport}px`;
    canvas.style.height = `${viewport}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, viewport, viewport);
    context.fillStyle = "#fff8ea";
    context.fillRect(0, 0, viewport, viewport);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const cropSize = cropSizeInImage();
    context.drawImage(rotated.canvas, offsetX, offsetY, cropSize, cropSize, 0, 0, viewport, viewport);
  }

  function currentCrop() {
    const cropSize = cropSizeInImage();
    return {
      x: Math.round(offsetX),
      y: Math.round(offsetY),
      size: Math.round(Math.min(cropSize, Math.min(rotated.width, rotated.height)))
    };
  }

  function rebuildRotated() {
    rotated = createRotatedCanvas(working, rotation);
    minScale = computeMinScale();
    scale = Math.max(scale, minScale);
  }

  function resetView(keepRotation = false) {
    if (!keepRotation) rotation = 0;
    rebuildRotated();
    scale = minScale;
    // 默认取正中间：人脸通常在照片中部，比左上角起始更符合预期
    offsetX = (rotated.width - cropSizeInImage()) / 2;
    offsetY = (rotated.height - cropSizeInImage()) / 2;
    clampOffsets();
    syncZoomSlider();
    render();
  }

  function rotateBy(degrees) {
    const geometry = rotatedSize(working, rotation + degrees);
    rotation = geometry.rotate;
    rebuildRotated();
    // 旋转后重新居中，避免裁切框落到画面外
    offsetX = (rotated.width - cropSizeInImage()) / 2;
    offsetY = (rotated.height - cropSizeInImage()) / 2;
    clampOffsets();
    syncZoomSlider();
    render();
    setStatus(`已旋转到 ${rotation}°。`);
  }

  function stagePoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pointerCentroid() {
    const list = Array.from(pointers.values());
    const sum = list.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
    return { x: sum.x / list.length, y: sum.y / list.length };
  }

  function pointerSpread() {
    const list = Array.from(pointers.values());
    if (list.length < 2) return 0;
    return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  }

  function onPointerDown(event) {
    if (!rotated || busy) return;
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, stagePoint(event));
    if (pointers.size === 2) {
      pinchStart = { spread: pointerSpread(), scale, centroid: pointerCentroid() };
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId) || !rotated) return;
    event.preventDefault();
    const previous = pointers.get(event.pointerId);
    const current = stagePoint(event);
    pointers.set(event.pointerId, current);

    if (pointers.size >= 2) {
      // 双指：同时处理缩放与平移
      const spread = pointerSpread();
      const centroid = pointerCentroid();
      if (pinchStart && pinchStart.spread > 0 && spread > 0) {
        const target = pinchStart.scale * (spread / pinchStart.spread);
        zoomTo(target, centroid);
      }
      if (pinchStart) {
        const shiftX = centroid.x - pinchStart.centroid.x;
        const shiftY = centroid.y - pinchStart.centroid.y;
        offsetX -= shiftX / scale;
        offsetY -= shiftY / scale;
        pinchStart.centroid = centroid;
        clampOffsets();
        render();
      }
      return;
    }

    offsetX -= (current.x - previous.x) / scale;
    offsetY -= (current.y - previous.y) / scale;
    clampOffsets();
    render();
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = null;
  }

  function onWheel(event) {
    if (!rotated || busy) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 1.09 : 1 / 1.09;
    zoomTo(scale * step, stagePoint(event));
  }

  function onKeyDown(event) {
    if (!rotated) return;
    const nudge = event.shiftKey ? 24 : 8;
    const actions = {
      ArrowLeft: () => { offsetX -= nudge / scale; },
      ArrowRight: () => { offsetX += nudge / scale; },
      ArrowUp: () => { offsetY -= nudge / scale; },
      ArrowDown: () => { offsetY += nudge / scale; }
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
      clampOffsets();
      render();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(scale * 1.12);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomTo(scale / 1.12);
    }
  }

  function measureViewport() {
    const rect = stage?.getBoundingClientRect();
    const available = rect?.width ? Math.floor(rect.width) : 320;
    return Math.max(200, Math.min(available, 380));
  }

  function handleResize() {
    if (!rotated) return;
    const next = measureViewport();
    if (next === viewport) return;
    const centerX = offsetX + cropSizeInImage() / 2;
    const centerY = offsetY + cropSizeInImage() / 2;
    viewport = next;
    minScale = computeMinScale();
    scale = Math.max(scale, minScale);
    offsetX = centerX - cropSizeInImage() / 2;
    offsetY = centerY - cropSizeInImage() / 2;
    clampOffsets();
    syncZoomSlider();
    render();
  }

  // 实时把当前边框叠在裁切预览上，让用户在确认前就看到最终组合。
  function renderFramePreview() {
    if (!frameOverlay) return;
    frameOverlay.innerHTML = options.frameOverlayMarkup?.() || "";
  }

  function close(reason = "cancel") {
    options.hideModal?.(root);
    pointers.clear();
    pinchStart = null;
    working = null;
    rotated = null;
    busy = false;
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus({ preventScroll: true });
    }
    if (reason === "cancel") options.onCancel?.();
  }

  async function confirm() {
    if (!rotated || busy) return;
    busy = true;
    if (confirmButton) confirmButton.disabled = true;
    setStatus("正在生成头像…");
    try {
      const output = await renderCroppedAvatar(working, currentCrop(), rotation);
      const name = String(nameInput?.value || "").trim().slice(0, 16);
      await options.onConfirm?.({
        blob: output.blob,
        thumbBlob: output.thumbBlob,
        name: name || "我的照片",
        width: output.size,
        height: output.size
      });
      close("confirm");
    } catch (error) {
      // 图片管线与存储层的错误都带 hint，统一按可读文案展示（含存储空间不足）
      const message = typeof error?.hint === "string"
        ? `${error.message}${error.hint ? ` ${error.hint}` : ""}`
        : `头像生成失败：${error?.message || error}`;
      setStatus(message, "error");
    } finally {
      busy = false;
      if (confirmButton) confirmButton.disabled = false;
    }
  }

  // 由 avatar-system 在文件校验、解码完成后调用。
  function open({ workingCanvas, suggestedName, notice }) {
    working = workingCanvas;
    rotation = 0;
    lastFocused = document.activeElement;
    if (nameInput) nameInput.value = suggestedName || "我的照片";
    options.showModal?.(root);
    // 弹层显示后才能量到真实宽度
    viewport = measureViewport();
    resetView(false);
    renderFramePreview();
    setStatus(notice || "拖动调整位置，滑块或双指缩放。");
    root.querySelector("[data-cropper-first-focus]")?.focus({ preventScroll: true });
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);
  zoomSlider?.addEventListener("input", () => {
    const maxScale = minScale * MAX_ZOOM_FACTOR;
    zoomTo(minScale + (Number(zoomSlider.value) / 100) * (maxScale - minScale));
  });
  root.querySelector("[data-cropper-rotate-left]")?.addEventListener("click", () => rotateBy(-90));
  root.querySelector("[data-cropper-rotate-right]")?.addEventListener("click", () => rotateBy(90));
  root.querySelector("[data-cropper-reset]")?.addEventListener("click", () => {
    resetView(false);
    setStatus("已重置为初始状态。");
  });
  root.querySelector("[data-cropper-reselect]")?.addEventListener("click", () => options.onReselect?.());
  root.querySelectorAll("[data-cropper-cancel]").forEach((button) => button.addEventListener("click", () => close("cancel")));
  confirmButton?.addEventListener("click", confirm);
  window.addEventListener("resize", handleResize);
  document.addEventListener("keydown", (event) => {
    if (root.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close("cancel");
    }
  });

  return {
    open,
    close,
    isOpen: () => !root.hidden,
    refreshFramePreview: renderFramePreview,
    setStatus
  };
}
