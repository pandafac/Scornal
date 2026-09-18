// 自定义头像存储层：Blob 存 IndexedDB，设置里只留轻量引用。
// 与成绩记录共用同一个数据库，升级时只新增 object store，不动 examRecords。

export const CUSTOM_AVATAR_STORE = "customAvatars";
export const CUSTOM_AVATAR_LIMIT = 6;
export const CUSTOM_AVATAR_PREFIX = "custom:";

export class AvatarStorageError extends Error {
  constructor(code, message, hint = "") {
    super(message);
    this.name = "AvatarStorageError";
    this.code = code;
    this.hint = hint;
  }
}

// 由 main.js 在 onupgradeneeded 里调用。只新增，不删除、不清空既有数据。
export function upgradeCustomAvatarStore(database) {
  if (!database.objectStoreNames.contains(CUSTOM_AVATAR_STORE)) {
    const store = database.createObjectStore(CUSTOM_AVATAR_STORE, { keyPath: "id" });
    store.createIndex("createdAt", "createdAt", { unique: false });
  }
}

export function isCustomAvatarId(id) {
  return typeof id === "string" && id.startsWith(CUSTOM_AVATAR_PREFIX);
}

function newCustomId() {
  const random = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return `${CUSTOM_AVATAR_PREFIX}${random}`;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function isQuotaError(error) {
  return error?.name === "QuotaExceededError"
    || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || /quota|storage/i.test(error?.message || "");
}

export function createAvatarStorage(database) {
  // id → objectURL。统一在这里发放和回收，避免各处随手 createObjectURL 造成泄漏。
  const urlCache = new Map();

  function releaseUrls(id) {
    const entry = urlCache.get(id);
    if (!entry) return;
    URL.revokeObjectURL(entry.image);
    if (entry.thumb && entry.thumb !== entry.image) URL.revokeObjectURL(entry.thumb);
    urlCache.delete(id);
  }

  function releaseAllUrls() {
    Array.from(urlCache.keys()).forEach(releaseUrls);
  }

  function attachUrls(record) {
    if (!record) return null;
    releaseUrls(record.id);
    const image = URL.createObjectURL(record.blob);
    const thumb = record.thumbBlob ? URL.createObjectURL(record.thumbBlob) : image;
    urlCache.set(record.id, { image, thumb });
    return {
      id: record.id,
      label: record.name,
      name: record.name,
      group: "我的头像",
      type: "custom",
      avatarVariantId: record.avatarVariantId || "local-photo-v1",
      alt: `${record.name}（本机照片头像）`,
      imageUrl: image,
      thumbUrl: thumb,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      bytes: (record.blob?.size || 0) + (record.thumbBlob?.size || 0),
      width: record.width,
      height: record.height,
      source: record.source || "local-album"
    };
  }

  async function listRecords() {
    const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readonly");
    const done = txDone(transaction);
    const records = await promisify(transaction.objectStore(CUSTOM_AVATAR_STORE).getAll());
    await done;
    return records.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async function list() {
    return (await listRecords()).map(attachUrls).filter(Boolean);
  }

  async function count() {
    const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readonly");
    const done = txDone(transaction);
    const total = await promisify(transaction.objectStore(CUSTOM_AVATAR_STORE).count());
    await done;
    return total;
  }

  async function getRecord(id) {
    const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readonly");
    const done = txDone(transaction);
    const record = await promisify(transaction.objectStore(CUSTOM_AVATAR_STORE).get(id));
    await done;
    return record || null;
  }

  // 新增一张自定义头像。达到上限时抛错，由 UI 提示删除或替换，绝不静默删除。
  async function add({ blob, thumbBlob, name, width, height, replaceId = null }) {
    if (!replaceId) {
      const total = await count();
      if (total >= CUSTOM_AVATAR_LIMIT) {
        throw new AvatarStorageError(
          "limit-reached",
          `自定义头像最多保存 ${CUSTOM_AVATAR_LIMIT} 张，现在已经存满了。`,
          "请先删除一张不用的头像，或选择替换其中一张。"
        );
      }
    }
    const now = new Date().toISOString();
    const existing = replaceId ? await getRecord(replaceId) : null;
    const record = {
      id: existing?.id || newCustomId(),
      name: String(name || "我的照片").trim().slice(0, 16) || "我的照片",
      blob,
      thumbBlob,
      width,
      height,
      source: "local-album",
      avatarVariantId: "local-photo-v1",
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    try {
      const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readwrite");
      const done = txDone(transaction);
      transaction.objectStore(CUSTOM_AVATAR_STORE).put(record);
      await done;
    } catch (error) {
      if (isQuotaError(error)) {
        throw new AvatarStorageError(
          "quota",
          "本机存储空间不足，头像没能保存。",
          "可以删除一些旧的自定义头像，或清理浏览器存储后重试。"
        );
      }
      throw new AvatarStorageError("write-failed", "头像保存失败。", error?.message || "");
    }
    return attachUrls(record);
  }

  async function rename(id, name) {
    const record = await getRecord(id);
    if (!record) throw new AvatarStorageError("not-found", "找不到这张自定义头像。");
    record.name = String(name || "").trim().slice(0, 16) || record.name;
    record.updatedAt = new Date().toISOString();
    const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readwrite");
    const done = txDone(transaction);
    transaction.objectStore(CUSTOM_AVATAR_STORE).put(record);
    await done;
    return attachUrls(record);
  }

  async function remove(id) {
    const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readwrite");
    const done = txDone(transaction);
    transaction.objectStore(CUSTOM_AVATAR_STORE).delete(id);
    await done;
    releaseUrls(id);
  }

  async function clear() {
    const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readwrite");
    const done = txDone(transaction);
    transaction.objectStore(CUSTOM_AVATAR_STORE).clear();
    await done;
    releaseAllUrls();
  }

  return {
    limit: CUSTOM_AVATAR_LIMIT,
    list,
    listRecords,
    count,
    getRecord,
    add,
    rename,
    remove,
    clear,
    releaseAllUrls,
    releaseUrls,
    serializeForBackup: () => serializeCustomAvatars(listRecords),
    restoreFromBackup: (entries, mode) => restoreCustomAvatars(database, entries, mode)
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("头像读取失败"));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mime) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime || "image/webp" });
}

// 只序列化裁切后的成品，不含原始照片，也不含任何 EXIF/GPS 元数据。
async function serializeCustomAvatars(listRecords) {
  const records = await listRecords();
  return Promise.all(records.map(async (record) => ({
    id: record.id,
    name: record.name,
    width: record.width,
    height: record.height,
    source: record.source || "local-album",
    avatarVariantId: record.avatarVariantId || "local-photo-v1",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    mime: record.blob?.type || "image/webp",
    thumbMime: record.thumbBlob?.type || "image/webp",
    imageBase64: await blobToBase64(record.blob),
    thumbBase64: record.thumbBlob ? await blobToBase64(record.thumbBlob) : null
  })));
}

export function validateCustomAvatarBackup(entries) {
  if (!Array.isArray(entries)) throw new Error("备份中的自定义头像格式不正确。");
  if (entries.length > CUSTOM_AVATAR_LIMIT) {
    throw new Error(`备份中的自定义头像超过 ${CUSTOM_AVATAR_LIMIT} 张上限。`);
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`第 ${index + 1} 张自定义头像格式不正确。`);
    if (typeof entry.imageBase64 !== "string" || !entry.imageBase64) {
      throw new Error(`第 ${index + 1} 张自定义头像缺少图片数据。`);
    }
    const mime = String(entry.mime || "image/webp");
    if (!/^image\/(webp|png|jpeg)$/.test(mime)) {
      throw new Error(`第 ${index + 1} 张自定义头像的图片类型不受支持。`);
    }
    return entry;
  });
}

// 先在内存里完成解码，全部成功后再一次性写库；任何一张有问题就整批不写。
async function restoreCustomAvatars(database, entries, mode = "merge") {
  const validated = validateCustomAvatarBackup(entries);
  const now = new Date().toISOString();
  const records = validated.map((entry) => ({
    id: isCustomAvatarId(entry.id) ? entry.id : newCustomId(),
    name: String(entry.name || "我的照片").trim().slice(0, 16) || "我的照片",
    blob: base64ToBlob(entry.imageBase64, entry.mime),
    thumbBlob: entry.thumbBase64 ? base64ToBlob(entry.thumbBase64, entry.thumbMime) : null,
    width: Number(entry.width) || 512,
    height: Number(entry.height) || 512,
    source: entry.source === "local-album" ? "local-album" : "local-album",
    avatarVariantId: "local-photo-v1",
    createdAt: entry.createdAt || now,
    updatedAt: now
  }));

  const transaction = database.transaction(CUSTOM_AVATAR_STORE, "readwrite");
  const store = transaction.objectStore(CUSTOM_AVATAR_STORE);
  const done = txDone(transaction);
  if (mode === "replace") store.clear();
  records.forEach((record) => store.put(record));
  await done;
  return records.length;
}
