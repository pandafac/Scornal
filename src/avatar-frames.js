// 边框几何：一份声明，两种渲染。
// DOM 用内联 SVG（任意尺寸都清晰），分享长图用 Canvas + Path2D 复用同一份路径数据。

const FALLBACK_PALETTE = {
  ivory: "#fff8ea",
  paper: "#f4ece0",
  forest: "#386a59",
  coral: "#d56f59",
  slate: "#4b76a8",
  ochre: "#c58b2a",
  ink: "#3d3733"
};

// 每个装饰形状在 -1..1 的局部坐标里定义一次，SVG 与 Canvas 共用。
export const MARK_SHAPES = {
  leaf: {
    mode: "fill",
    d: "M0,-1 C0.62,-0.44 0.62,0.44 0,1 C-0.62,0.44 -0.62,-0.44 0,-1 Z"
  },
  star: {
    mode: "fill",
    d: "M0,-1 L0.247,-0.34 L0.951,-0.309 L0.399,0.13 L0.588,0.809 L0,0.42 L-0.588,0.809 L-0.399,0.13 L-0.951,-0.309 L-0.247,-0.34 Z"
  },
  sparkle: {
    mode: "fill",
    d: "M0,-1 Q0.17,-0.17 1,0 Q0.17,0.17 0,1 Q-0.17,0.17 -1,0 Q-0.17,-0.17 0,-1 Z"
  },
  tape: {
    mode: "fill",
    d: "M-1,-0.3 L1,-0.3 L0.9,-0.15 L1,0 L0.9,0.15 L1,0.3 L-1,0.3 L-0.9,0.15 L-1,0 L-0.9,-0.15 Z"
  },
  notch: {
    mode: "fill",
    d: "M-0.34,-1 L0.34,-1 L0.34,1 L-0.34,1 Z"
  },
  dot: {
    mode: "fill",
    d: "M0,-1 A1,1 0 1,1 0,1 A1,1 0 1,1 0,-1 Z"
  },
  postmark: {
    mode: "stroke",
    strokeWidth: 0.16,
    d: "M0,-1 A1,1 0 1,1 0,1 A1,1 0 1,1 0,-1 Z M0,-0.62 A0.62,0.62 0 1,1 0,0.62 A0.62,0.62 0 1,1 0,-0.62 Z"
  }
};

// 底部缎带 / 奖章飘带，直接定义在 0..100 的 viewBox 空间。
export const BANNER_PATHS = {
  ribbon: ["M24,78 L76,78 L70.5,84.6 L76,91.2 L24,91.2 L29.5,84.6 Z"],
  tails: [
    "M41.5,79 L48.6,85.4 L44.4,98.6 L36.2,91.6 Z",
    "M58.5,79 L51.4,85.4 L55.6,98.6 L63.8,91.6 Z"
  ]
};

export function resolveColor(token, palette = FALLBACK_PALETTE) {
  if (!token) return palette.ink || FALLBACK_PALETTE.ink;
  if (typeof token === "string" && token.startsWith("#")) return token;
  return palette[token] || FALLBACK_PALETTE[token] || token;
}

// 极坐标 → viewBox 坐标。角度 0 指向右侧，顺时针增加。
export function polarPoint(angle, radius) {
  const radians = (Number(angle) || 0) * Math.PI / 180;
  return {
    x: 50 + Math.cos(radians) * (Number(radius) || 0),
    y: 50 + Math.sin(radians) * (Number(radius) || 0)
  };
}

// 小尺寸下丢掉过细的装饰：40px 时 2% 的元素只有 0.8px，画出来只会变成脏点。
export function visibleMarks(frame, size) {
  return (frame?.marks || []).filter((mark) => !mark.minSize || size >= mark.minSize);
}

export function isStaticSize(frame, size) {
  return size < (frame?.motionMinSize || 96);
}

function attr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function ringSvg(ring, palette) {
  const color = resolveColor(ring.color, palette);
  const dash = ring.dash ? ` stroke-dasharray="${attr(ring.dash)}"` : "";
  return `<circle class="identity-frame__ring" cx="50" cy="50" r="${ring.r}" fill="none" stroke="${attr(color)}" stroke-width="${ring.width}" stroke-linecap="round" opacity="${ring.opacity ?? 1}"${dash} />`;
}

function markSvg(mark, palette, index) {
  const shape = MARK_SHAPES[mark.type];
  if (!shape) return "";
  const point = polarPoint(mark.angle, mark.r);
  const scale = (Number(mark.size) || 6) / 2;
  const color = resolveColor(mark.color, palette);
  const paint = shape.mode === "stroke"
    ? `fill="none" stroke="${attr(color)}" stroke-width="${shape.strokeWidth || 0.16}" vector-effect="non-scaling-stroke"`
    : `fill="${attr(color)}"`;
  const transform = `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) rotate(${mark.rotate || 0}) scale(${scale.toFixed(3)})`;
  return `<path class="identity-frame__mark is-${attr(mark.type)}" data-mark="${index}" style="--mark-delay:${mark.delay || 0}s" d="${shape.d}" ${paint} opacity="${mark.opacity ?? 1}" transform="${transform}" />`;
}

function plateSvg(plate, palette) {
  const radius = plate.radius ?? 12;
  const stroke = plate.stroke
    ? ` stroke="${attr(resolveColor(plate.stroke, palette))}" stroke-width="${plate.strokeWidth ?? 1.4}"`
    : "";
  return `<rect class="identity-frame__plate" x="3" y="3" width="94" height="94" rx="${radius}" ry="${radius}" fill="${attr(resolveColor(plate.fill, palette))}"${stroke} opacity="${plate.opacity ?? 1}" />`;
}

// 邮票齿孔：沿圆环打一圈与卡片同色的小圆，视觉上把描边"咬"出缺口。
function scallopSvg(scallop, palette) {
  const color = resolveColor(scallop.color, palette);
  const count = Math.max(4, Number(scallop.count) || 24);
  const dots = [];
  for (let index = 0; index < count; index += 1) {
    const point = polarPoint((360 / count) * index, scallop.r);
    dots.push(`<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${(scallop.size || 2.4) / 2}" fill="${attr(color)}" />`);
  }
  return `<g class="identity-frame__scallop">${dots.join("")}</g>`;
}

function notchesSvg(notches, palette) {
  const color = resolveColor(notches.color, palette);
  const count = Math.max(4, Number(notches.count) || 12);
  const shape = MARK_SHAPES.notch;
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (360 / count) * index;
    const point = polarPoint(angle, notches.r);
    const scale = (notches.size || 3.2) / 2;
    items.push(`<path d="${shape.d}" fill="${attr(color)}" opacity="${notches.opacity ?? 0.8}" transform="translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) rotate(${(angle + 90).toFixed(1)}) scale(${scale.toFixed(3)})" />`);
  }
  return `<g class="identity-frame__notches">${items.join("")}</g>`;
}

function bannerSvg(banner, palette) {
  const paths = BANNER_PATHS[banner.type];
  if (!paths) return "";
  const color = resolveColor(banner.color, palette);
  const accent = resolveColor(banner.accent, palette);
  const body = paths.map((d, index) => `<path d="${d}" fill="${attr(color)}" stroke="${attr(accent)}" stroke-width="0.9" opacity="${banner.opacity ?? 0.96}" data-banner="${index}" />`).join("");
  return `<g class="identity-frame__banner is-${attr(banner.type)}">${body}</g>`;
}

// 底板（plate）是不透明的，必须画在头像下面，否则会把头像整块盖掉。
// 因此边框拆成两层：backdrop 走头像之前，overlay 走头像之后。
export function frameHasBackdrop(frame) {
  return Boolean(frame && frame.kind === "vector" && frame.plate);
}

export function frameBackdropSvgMarkup(frame, palette) {
  if (!frameHasBackdrop(frame)) return "";
  return `<svg class="identity-frame__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">${plateSvg(frame.plate, palette)}</svg>`;
}

// 生成一个边框的内联 SVG。size 只用于决定要不要简化，几何本身与尺寸无关。
export function frameSvgMarkup(frame, palette, size) {
  if (!frame || frame.kind !== "vector") return "";
  const layers = [];
  (frame.rings || []).forEach((ring) => layers.push(ringSvg(ring, palette)));
  if (frame.scallop) layers.push(scallopSvg(frame.scallop, palette));
  if (frame.notches) layers.push(notchesSvg(frame.notches, palette));
  if (frame.banner) layers.push(bannerSvg(frame.banner, palette));
  visibleMarks(frame, size).forEach((mark, index) => layers.push(markSvg(mark, palette, index)));
  return `<svg class="identity-frame__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">${layers.join("")}</svg>`;
}

// —— Canvas 渲染（分享长图用，一律画静态完成态）——
// Path2D 直接吃 SVG path 字符串，所以 MARK_SHAPES 不需要为 Canvas 再写一份几何。

function pathFor(d) {
  return new Path2D(d);
}

function canvasRoundedRect(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawMark(context, mark, palette, unit) {
  const shape = MARK_SHAPES[mark.type];
  if (!shape) return;
  const point = polarPoint(mark.angle, mark.r);
  const scale = ((Number(mark.size) || 6) / 2) * unit;
  const color = resolveColor(mark.color, palette);
  context.save();
  context.globalAlpha = mark.opacity ?? 1;
  context.translate(point.x * unit, point.y * unit);
  context.rotate(((mark.rotate || 0) * Math.PI) / 180);
  context.scale(scale, scale);
  const path = pathFor(shape.d);
  if (shape.mode === "stroke") {
    context.strokeStyle = color;
    context.lineWidth = shape.strokeWidth || 0.16;
    context.stroke(path);
  } else {
    context.fillStyle = color;
    context.fill(path);
  }
  context.restore();
}

// 只画底板。Canvas 侧同样要先底板、再头像、最后装饰，才和 DOM 层序一致。
export function drawVectorFrameBackdrop(context, frame, config) {
  if (!frameHasBackdrop(frame)) return;
  const palette = config.palette || FALLBACK_PALETTE;
  const unit = (config.size || 56) / 100;
  context.save();
  context.translate(config.x || 0, config.y || 0);
  const radius = (frame.plate.radius ?? 12) * unit;
  canvasRoundedRect(context, 3 * unit, 3 * unit, 94 * unit, 94 * unit, radius);
  context.globalAlpha = frame.plate.opacity ?? 1;
  context.fillStyle = resolveColor(frame.plate.fill, palette);
  context.fill();
  if (frame.plate.stroke) {
    context.strokeStyle = resolveColor(frame.plate.stroke, palette);
    context.lineWidth = (frame.plate.strokeWidth ?? 1.4) * unit;
    context.stroke();
  }
  context.globalAlpha = 1;
  context.restore();
}

// 把一个 vector 边框的装饰层画到 canvas 的 (x, y, size) 方框里。
export function drawVectorFrame(context, frame, config) {
  if (!frame || frame.kind !== "vector") return;
  const palette = config.palette || FALLBACK_PALETTE;
  const size = config.size || 56;
  const unit = size / 100; // viewBox 单位 → 画布像素
  context.save();
  context.translate(config.x || 0, config.y || 0);

  (frame.rings || []).forEach((ring) => {
    context.save();
    context.globalAlpha = ring.opacity ?? 1;
    context.strokeStyle = resolveColor(ring.color, palette);
    context.lineWidth = ring.width * unit;
    context.lineCap = "round";
    if (ring.dash) {
      context.setLineDash(String(ring.dash).split(/[\s,]+/).map((value) => Number(value) * unit));
    }
    context.beginPath();
    context.arc(50 * unit, 50 * unit, ring.r * unit, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  });

  if (frame.scallop) {
    const count = Math.max(4, Number(frame.scallop.count) || 24);
    context.fillStyle = resolveColor(frame.scallop.color, palette);
    for (let index = 0; index < count; index += 1) {
      const point = polarPoint((360 / count) * index, frame.scallop.r);
      context.beginPath();
      context.arc(point.x * unit, point.y * unit, ((frame.scallop.size || 2.4) / 2) * unit, 0, Math.PI * 2);
      context.fill();
    }
  }

  if (frame.notches) {
    const count = Math.max(4, Number(frame.notches.count) || 12);
    const shape = MARK_SHAPES.notch;
    for (let index = 0; index < count; index += 1) {
      const angle = (360 / count) * index;
      drawMark(context, {
        type: "notch",
        angle,
        r: frame.notches.r,
        size: frame.notches.size || 3.2,
        rotate: angle + 90,
        color: frame.notches.color,
        opacity: frame.notches.opacity ?? 0.8
      }, palette, unit);
      void shape;
    }
  }

  if (frame.banner) {
    const paths = BANNER_PATHS[frame.banner.type] || [];
    context.save();
    context.globalAlpha = frame.banner.opacity ?? 0.96;
    context.scale(unit, unit);
    context.fillStyle = resolveColor(frame.banner.color, palette);
    context.strokeStyle = resolveColor(frame.banner.accent, palette);
    context.lineWidth = 0.9;
    paths.forEach((d) => {
      const path = pathFor(d);
      context.fill(path);
      context.stroke(path);
    });
    context.restore();
  }

  visibleMarks(frame, size).forEach((mark) => drawMark(context, mark, palette, unit));
  context.restore();
}
