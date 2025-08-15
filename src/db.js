// db.js - IndexedDB helper for chats, calls, albums, files and blobs
// Improved and extended: safer transaction promisification, additional helpers

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
        try {
          store.createIndex("albumId", "albumId", { unique: false });
        } catch (e) {
          // ignore if index exists in some browsers
        }
      }
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs"); // key provided manually
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// promisify individual requests (IDBRequest)
function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// promisify a transaction's completion
function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/* Calls */
export async function saveCall(callData) {
  const db = await openDB();
  const tx = db.transaction("calls", "readwrite");
  const store = tx.objectStore("calls");
  const item = { ...callData, timestamp: callData.timestamp || Date.now() };
  store.put(item);
  await promisifyTransaction(tx);
  return item.timestamp;
}

export async function getRecentCalls(limit = 10) {
  const db = await openDB();
  const store = db.transaction("calls", "readonly").objectStore("calls");
  const all = await promisifyRequest(store.getAll());
  return (all || []).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function clearCalls() {
  const db = await openDB();
  const tx = db.transaction("calls", "readwrite");
  tx.objectStore("calls").clear();
  await promisifyTransaction(tx);
  return true;
}

/* Chats */
export async function saveChat(chatData) {
  const db = await openDB();
  const tx = db.transaction("chats", "readwrite");
  const store = tx.objectStore("chats");
  const item = { ...chatData, timestamp: chatData.timestamp || Date.now() };
  store.put(item);
  await promisifyTransaction(tx);
  return item.timestamp;
}

export async function getChatHistory(limit = 10) {
  const db = await openDB();
  const store = db.transaction("chats", "readonly").objectStore("chats");
  const all = await promisifyRequest(store.getAll());
  // return most recent first
  return (all || []).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function clearChats() {
  const db = await openDB();
  const tx = db.transaction("chats", "readwrite");
  tx.objectStore("chats").clear();
  await promisifyTransaction(tx);
  return true;
}

/* Albums */
export async function saveAlbum(album) {
  const db = await openDB();
  const tx = db.transaction("albums", "readwrite");
  const store = tx.objectStore("albums");
  const item = { ...album, ts: album.ts || Date.now() };
  store.put(item);
  await promisifyTransaction(tx);
  return item.id;
}

export async function getAlbums() {
  const db = await openDB();
  const store = db.transaction("albums", "readonly").objectStore("albums");
  const all = await promisifyRequest(store.getAll());
  return all || [];
}

export async function deleteAlbum(id) {
  const db = await openDB();
  const tx = db.transaction(["albums", "files"], "readwrite");
  tx.objectStore("albums").delete(id);
  // optionally clear albumId on files (keep files but detach)
  try {
    const filesStore = tx.objectStore("files");
    const allFiles = await new Promise((res, rej) => { const r = filesStore.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    for (const f of allFiles) {
      if (f.albumId === id) {
        f.albumId = null;
        filesStore.put(f);
      }
    }
  } catch (e) {
    // ignore best-effort
  }
  await promisifyTransaction(tx);
  return true;
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
    await promisifyTransaction(tx);
    return updated.id;
  } else if (typeof metaOrId === "object" && metaOrId !== null) {
    const meta = { ...metaOrId };
    if (albumId) meta.albumId = albumId;
    meta.ts = meta.ts || Date.now();
    if (!meta.id) meta.id = meta.id || Math.random().toString(36).slice(2, 9);
    store.put(meta);
    await promisifyTransaction(tx);
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

export async function getFileMeta(id) {
  const db = await openDB();
  const store = db.transaction("files", "readonly").objectStore("files");
  const meta = await promisifyRequest(store.get(id));
  return meta || null;
}

export async function getAllFiles() {
  const db = await openDB();
  const store = db.transaction("files", "readonly").objectStore("files");
  const all = await promisifyRequest(store.getAll());
  return all || [];
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
  await promisifyTransaction(tx);
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
  await promisifyTransaction(tx);
  return true;
}

// convenience: clear all stored data (useful during development)
export async function clearAllData() {
  const db = await openDB();
  const tx = db.transaction(["calls", "chats", "albums", "files", "blobs"], "readwrite");
  for (const storeName of ["calls", "chats", "albums", "files", "blobs"]) tx.objectStore(storeName).clear();
  await promisifyTransaction(tx);
  return true;
}
