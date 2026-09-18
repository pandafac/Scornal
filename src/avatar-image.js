// 本机头像图片管线：校验 → 解码 → 方向修正 → 降采样 → 裁切 → 重编码
// 全部在浏览器本机完成，不上传任何数据。

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB
export const MAX_SOURCE_PIXELS = 40 * 1000 * 1000; // 4000 万像素
export const MAX_DECODE_EDGE = 4096; // 解码后先降采样到此边长以内
export const AVATAR_OUTPUT_SIZE = 512;
export const AVATAR_THUMB_SIZE = 128;

// 允许的图片类型。SVG 不在其中：SVG 可携带脚本，且不是位图头像。
const ACCEPTED = new Map([
  ["jpeg", { mime: "image/jpeg", label: "JPEG" }],
  ["png", { mime: "image/png", label: "PNG" }],
  ["webp", { mime: "image/webp", label: "WebP" }],
  ["avif", { mime: "image/avif", label: "AVIF" }],
  ["heic", { mime: "image/heic", label: "HEIC/HEIF" }],
  ["gif", { mime: "image/gif", label: "GIF" }]
]);

export const ACCEPT_ATTRIBUTE = "image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,image/gif";

export class AvatarImageError extends Error {
  constructor(code, message, hint = "") {
    super(message);
    this.name = "AvatarImageError";
    this.code = code;
    this.hint = hint;
  }
}

function bytesMatch(bytes, offset, signature) {
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function asciiAt(bytes, offset, length) {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] || 0);
  }
  return text;
}

// 只看文件真实字节签名，不相信扩展名，也不只相信 file.type。
export function sniffFormat(bytes) {
  if (bytes.length < 12) return null;
  if (bytesMatch(bytes, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (bytesMatch(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "webp";
  if (asciiAt(bytes, 0, 3) === "GIF") return "gif";
  if (asciiAt(bytes, 4, 4) === "ftyp") {
    const brand = asciiAt(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "heim", "heis", "hevm", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

// 识别被伪装成图片的危险内容（SVG / HTML / 脚本 / 压缩包等）。
export function sniffHostileFormat(bytes) {
  const head = asciiAt(bytes, 0, Math.min(bytes.length, 256)).trim().toLowerCase();
  if (head.startsWith("<?xml") || head.includes("<svg")) return "SVG 矢量图";
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "HTML 网页";
  if (head.startsWith("<?php") || head.startsWith("#!")) return "脚本文件";
  if (bytesMatch(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return "压缩包";
  if (bytesMatch(bytes, 0, [0x25, 0x50, 0x44, 0x46])) return "PDF 文档";
  if (bytesMatch(bytes, 0, [0x4d, 0x5a])) return "可执行程序";
  return null;
}

// —— EXIF 方向 ——
// 手机竖拍 JPEG 常把方向记在 EXIF Orientation 里，像素本身是横的。
// 浏览器的 createImageBitmap({imageOrientation:"from-image"}) 会自动处理；
// 这里额外解析一次，用于 <img> 回退路径以及旋转量的显式校正。
export function readJpegOrientation(bytes) {
  if (!bytesMatch(bytes, 0, [0xff, 0xd8])) return 1;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2) break;
    if (marker === 0xe1 && asciiAt(bytes, offset + 4, 4) === "Exif") {
      const tiff = offset + 10;
      if (tiff + 8 > bytes.length) return 1;
      const little = asciiAt(bytes, tiff, 2) === "II";
      const u16 = (at) => (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
      const u32 = (at) => (little
        ? bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)
        : (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
      const ifdOffset = u32(tiff + 4);
      const ifd = tiff + ifdOffset;
      if (ifd + 2 > bytes.length) return 1;
      const entryCount = u16(ifd);
      for (let index = 0; index < entryCount; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > bytes.length) break;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) break; // 进入图像数据
    offset += 2 + segmentLength;
  }
  return 1;
}

// EXIF orientation → 需要补的旋转角与镜像
export function orientationTransform(orientation) {
  switch (orientation) {
    case 2: return { rotate: 0, flipX: true };
    case 3: return { rotate: 180, flipX: false };
    case 4: return { rotate: 180, flipX: true };
    case 5: return { rotate: 90, flipX: true };
    case 6: return { rotate: 90, flipX: false };
    case 7: return { rotate: 270, flipX: true };
    case 8: return { rotate: 270, flipX: false };
    default: return { rotate: 0, flipX: false };
  }
}

function formatBytes(value) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(value / 1024))}KB`;
}

// 第一道闸：文件大小 + 字节签名 + MIME 交叉校验。
export async function validateSelectedFile(file) {
  if (!file) throw new AvatarImageError("no-file", "没有读取到文件。");
  if (file.size === 0) {
    throw new AvatarImageError("empty", "这个文件是空的，读不到图片内容。", "请换一张图片试试。");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AvatarImageError(
      "too-large",
      `图片有 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_FILE_BYTES)} 上限。`,
      "可以先用手机相册的编辑功能裁小一点，或换一张。"
    );
  }

  const headBuffer = await file.slice(0, 4096).arrayBuffer().catch(() => null);
  if (!headBuffer) {
    throw new AvatarImageError("unreadable", "这个文件读不出来。", "文件可能已被移动或损坏。");
  }
  const head = new Uint8Array(headBuffer);

  const hostile = sniffHostileFormat(head);
  if (hostile) {
    throw new AvatarImageError("rejected-format", `这是${hostile}，不能用作头像。`, "请选择 JPEG、PNG、WebP 等照片文件。");
  }

  const format = sniffFormat(head);
  if (!format) {
    const claimed = file.type || "未知类型";
    throw new AvatarImageError(
      "unsupported",
      `无法识别的图片格式（${claimed}）。`,
      "支持 JPEG、PNG、WebP、AVIF，以及浏览器能解码的 HEIC。"
    );
  }

  const accepted = ACCEPTED.get(format);
  // file.type 与真实签名冲突时以签名为准，但仍提示一次，便于排查伪装文件。
  const mismatched = Boolean(file.type) && file.type !== accepted.mime
    && !(format === "heic" && file.type === "image/heif");

  return { format, label: accepted.label, mime: accepted.mime, head, mismatched };
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    throw new AvatarImageError("no-canvas", "浏览器画布不可用，无法处理图片。");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

// <img> 回退解码路径（个别浏览器 createImageBitmap 对 HEIC 支持不同）
function decodeViaImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "sync";
    const cleanup = () => URL.revokeObjectURL(url);
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        cleanup();
        reject(new AvatarImageError("decode-failed", "图片解码后尺寸为 0，文件可能已损坏。"));
        return;
      }
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, cleanup, orientationApplied: false });
    };
    image.onerror = () => {
      cleanup();
      reject(new AvatarImageError(
        "decode-failed",
        "这张图片无法解码。",
        "文件可能已损坏，或当前浏览器不支持这种格式（例如部分 HEIC）。"
      ));
    };
    image.src = url;
  });
}

// 解码 + 安全降采样。返回一个已按 EXIF 摆正的离屏画布，避免后续反复处理巨图。
export async function decodeToWorkingCanvas(file, validation) {
  let decoded = null;
  if (typeof createImageBitmap === "function") {
    try {
      // from-image 让浏览器直接按 EXIF 摆正像素
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      decoded = { source: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close?.(), orientationApplied: true };
    } catch {
      decoded = null;
    }
  }
  if (!decoded) decoded = await decodeViaImageElement(file);

  const { source, width, height, cleanup, orientationApplied } = decoded;

  if (width * height > MAX_SOURCE_PIXELS) {
    cleanup();
    const megapixels = (width * height / 1e6).toFixed(0);
    throw new AvatarImageError(
      "too-many-pixels",
      `图片有 ${width}×${height}（约 ${megapixels} 百万像素），超出可安全处理的范围。`,
      "请先在相册里导出一张小一些的版本。"
    );
  }

  // 未由浏览器摆正时，自己补 EXIF 旋转（仅 JPEG 有此问题）
  let rotate = 0;
  let flipX = false;
  if (!orientationApplied && validation?.format === "jpeg") {
    const transform = orientationTransform(readJpegOrientation(validation.head));
    rotate = transform.rotate;
    flipX = transform.flipX;
  }

  const swapped = rotate === 90 || rotate === 270;
  const orientedWidth = swapped ? height : width;
  const orientedHeight = swapped ? width : height;

  // 降采样到 MAX_DECODE_EDGE 以内，防止手机浏览器内存崩溃
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(orientedWidth, orientedHeight));
  const targetWidth = Math.max(1, Math.round(orientedWidth * scale));
  const targetHeight = Math.max(1, Math.round(orientedHeight * scale));

  try {
    const { canvas, context } = createCanvas(targetWidth, targetHeight);
    context.save();
    context.translate(targetWidth / 2, targetHeight / 2);
    if (rotate) context.rotate((rotate * Math.PI) / 180);
    if (flipX) context.scale(-1, 1);
    const drawWidth = swapped ? targetHeight : targetWidth;
    const drawHeight = swapped ? targetWidth : targetHeight;
    context.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    context.restore();
    return {
      canvas,
      width: targetWidth,
      height: targetHeight,
      sourceWidth: orientedWidth,
      sourceHeight: orientedHeight,
      downsampled: scale < 1
    };
  } catch (error) {
    if (error instanceof AvatarImageError) throw error;
    throw new AvatarImageError("out-of-memory", "处理这张图片时内存不足。", "请换一张尺寸小一些的照片。");
  } finally {
    cleanup();
  }
}

function encodeCanvas(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new AvatarImageError("encode-failed", "头像编码失败。", "请重试或换一张图片。"));
    }, mime, quality);
  });
}

async function encodeBest(canvas) {
  // 优先 WebP（同画质体积更小）；不支持时回退 PNG。
  const webp = await encodeCanvas(canvas, "image/webp", 0.92).catch(() => null);
  if (webp && webp.type === "image/webp" && webp.size > 0) return webp;
  return encodeCanvas(canvas, "image/png");
}

export function normalizeRotation(rotate) {
  return ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;
}

// 旋转后的图片尺寸。裁切框坐标一律定义在「旋转后」的图片空间里，
// 这样 UI 的拖动边界和最终输出用的是同一套几何。
export function rotatedSize(working, rotate) {
  const normalized = normalizeRotation(rotate);
  const swapped = normalized === 90 || normalized === 270;
  return {
    width: swapped ? working.height : working.width,
    height: swapped ? working.width : working.height,
    rotate: normalized,
    swapped
  };
}

// 把工作画布整体旋转成一张新画布，几何只在这里算一次。
export function createRotatedCanvas(working, rotate) {
  const geometry = rotatedSize(working, rotate);
  const { canvas, context } = createCanvas(geometry.width, geometry.height);
  context.save();
  context.translate(geometry.width / 2, geometry.height / 2);
  if (geometry.rotate) context.rotate((geometry.rotate * Math.PI) / 180);
  context.drawImage(working.canvas, -working.width / 2, -working.height / 2);
  context.restore();
  return { canvas, width: geometry.width, height: geometry.height };
}

// 大比例缩小时逐级减半，避免一次性 8 倍缩放造成锯齿与细节丢失。
function drawDownscaled(target, source, sx, sy, sourceSize, outputSize) {
  let current = source;
  let cropX = sx;
  let cropY = sy;
  let cropSize = sourceSize;
  while (cropSize / 2 >= outputSize) {
    const halfSize = Math.round(cropSize / 2);
    const { canvas: step, context: stepContext } = createCanvas(halfSize, halfSize);
    stepContext.drawImage(current, cropX, cropY, cropSize, cropSize, 0, 0, halfSize, halfSize);
    current = step;
    cropX = 0;
    cropY = 0;
    cropSize = halfSize;
  }
  target.drawImage(current, cropX, cropY, cropSize, cropSize, 0, 0, outputSize, outputSize);
}

// 把裁切结果渲染成统一方形头像。
// crop 为「旋转后图片空间」中的正方形区域，rotate 是用户额外旋转的 90 度倍数。
export async function renderCroppedAvatar(working, crop, rotate = 0) {
  const size = AVATAR_OUTPUT_SIZE;
  const rotated = createRotatedCanvas(working, rotate);
  const { canvas, context } = createCanvas(size, size);
  // 铺一层象牙白底：透明 PNG 头像在浅色卡片上才不会出现黑边。
  context.fillStyle = "#fff8ea";
  context.fillRect(0, 0, size, size);
  drawDownscaled(context, rotated.canvas, crop.x, crop.y, crop.size, size);

  const { canvas: thumbCanvas, context: thumbContext } = createCanvas(AVATAR_THUMB_SIZE, AVATAR_THUMB_SIZE);
  thumbContext.fillStyle = "#fff8ea";
  thumbContext.fillRect(0, 0, AVATAR_THUMB_SIZE, AVATAR_THUMB_SIZE);
  drawDownscaled(thumbContext, canvas, 0, 0, size, AVATAR_THUMB_SIZE);

  // Canvas 重新编码，EXIF / GPS / 拍摄设备等元数据不会写入输出结果。
  const [blob, thumbBlob] = await Promise.all([encodeBest(canvas), encodeBest(thumbCanvas)]);
  return { blob, thumbBlob, size, thumbSize: AVATAR_THUMB_SIZE, type: blob.type };
}
