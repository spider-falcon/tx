// db.js - IndexedDB helper for chats, calls, albums, files and blobs
const DB_NAME = "webrtc_local";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("calls")) db.createObjectStore("calls", { keyPath: "timestamp" });
      if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "timestamp" });
      if (!db.objectStoreNames.contains("albums")) db.createObjectStore("albums", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) {
        const store = db.createObjectStore("files", { keyPath: "id" });
        store.createIndex("albumId", "albumId", { unique: false });
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs"); // key provided manually
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Calls */
export async function saveCall(callData) {
  const db = await openDB();
  const tx = db.transaction("calls", "readwrite");
  const store = tx.objectStore("calls");
  const item = { ...callData, timestamp: callData.timestamp || Date.now() };
  store.put(item);
  return promisifyRequest(tx);
}

export async function getRecentCalls(limit = 10) {
  const db = await openDB();
  const store = db.transaction("calls", "readonly").objectStore("calls");
  const all = await promisifyRequest(store.getAll());
  return (all || []).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/* Chats */
export async function saveChat(chatData) {
  const db = await openDB();
  const tx = db.transaction("chats", "readwrite");
  const store = tx.objectStore("chats");
  const item = { ...chatData, timestamp: chatData.timestamp || Date.now() };
  store.put(item);
  return promisifyRequest(tx);
}

export async function getChatHistory(limit = 10) {
  const db = await openDB();
  const store = db.transaction("chats", "readonly").objectStore("chats");
  const all = await promisifyRequest(store.getAll());
  return (all || []).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

/* Albums */
export async function saveAlbum(album) {
  const db = await openDB();
  const tx = db.transaction("albums", "readwrite");
  const store = tx.objectStore("albums");
  const item = { ...album, ts: album.ts || Date.now() };
  store.put(item);
  await promisifyRequest(tx);
  return item.id;
}

export async function getAlbums() {
  const db = await openDB();
  const store = db.transaction("albums", "readonly").objectStore("albums");
  const all = await promisifyRequest(store.getAll());
  return all || [];
}

/* Files metadata */
export async function saveFileMeta(metaOrId, albumId = null) {
  const db = await openDB();
  const tx = db.transaction("files", "readwrite");
  const store = tx.objectStore("files");

  if (typeof metaOrId === "string") {
    // update existing meta's albumId or ts
    const id = metaOrId;
    const existing = await promisifyRequest(store.get(id));
    const updated = { ...(existing || { id }), albumId: albumId ?? existing?.albumId ?? null, ts: Date.now(), ...(existing || {}) };
    store.put(updated);
    await promisifyRequest(tx);
    return updated.id;
  } else if (typeof metaOrId === "object" && metaOrId !== null) {
    const meta = { ...metaOrId };
    if (albumId) meta.albumId = albumId;
    meta.ts = meta.ts || Date.now();
    if (!meta.id) meta.id = meta.id || Math.random().toString(36).slice(2, 9);
    store.put(meta);
    await promisifyRequest(tx);
    return meta.id;
  } else {
    throw new Error("saveFileMeta: invalid arguments");
  }
}

export async function getFilesForAlbum(albumId) {
  const db = await openDB();
  const tx = db.transaction("files", "readonly");
  const store = tx.objectStore("files");
  // try to use index if exists
  if (store.indexNames && store.indexNames.contains("albumId")) {
    const idx = store.index("albumId");
    const req = idx.getAll(IDBKeyRange.only(albumId));
    const res = await promisifyRequest(req);
    return res || [];
  } else {
    const all = await promisifyRequest(store.getAll());
    return (all || []).filter((f) => f.albumId === albumId);
  }
}

/* Blobs (binary content) */
// Accepts either (id, blob) or (metaObject, blob)
// If metaObject provided it must contain an `id` property or one will be created.
export async function saveFileBlob(metaOrId, blob) {
  const db = await openDB();
  const tx = db.transaction(["blobs", "files"], "readwrite");
  const blobs = tx.objectStore("blobs");
  const files = tx.objectStore("files");

  let id;
  if (typeof metaOrId === "string") {
    id = metaOrId;
  } else if (typeof metaOrId === "object" && metaOrId !== null) {
    id = metaOrId.id || Math.random().toString(36).slice(2, 9);
    // also store metadata into files store (non-blocking but part of same tx)
    const meta = { ...metaOrId, id, ts: metaOrId.ts || Date.now() };
    files.put(meta);
  } else {
    throw new Error("saveFileBlob: invalid first argument");
  }

  blobs.put(blob, id);
  await promisifyRequest(tx);
  return id;
}

export async function getFileBlob(id) {
  const db = await openDB();
  const store = db.transaction("blobs", "readonly").objectStore("blobs");
  const res = await promisifyRequest(store.get(id));
  return res || null;
}

/* optional utility: delete file (meta + blob) */
export async function deleteFile(id) {
  const db = await openDB();
  const tx = db.transaction(["files", "blobs"], "readwrite");
  tx.objectStore("files").delete(id);
  tx.objectStore("blobs").delete(id);
  await promisifyRequest(tx);
  return true;
}
