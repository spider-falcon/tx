import { useEffect, useRef, useState } from "react";
import pako from "pako";
import { Html5Qrcode } from "html5-qrcode";
import { QRCodeSVG } from "qrcode.react";
import axios from "axios";

import Tx from "./Tx.jsx";
import "./App.css";
import {
  saveCall,
  saveChat,
  getRecentCalls,
  getChatHistory,
  saveFileMeta,
  getAlbums,
  saveAlbum,
  getFilesForAlbum,
  saveFileBlob,
  getFileBlob
} from "./db.js";

function uid() {
  return Math.random().toString(36).slice(2, 9);
}
function nowTs() {
  return Date.now();
}
function formatTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : "";
}
const CHUNK_SIZE = 64 * 1024; // 64KB chunks for data channel
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "👏"];

export default function App() {
  // state
  const [localSDPUrl, setLocalSDPUrl] = useState("");
  const [remoteSDP, setRemoteSDP] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("Not connected");
  const [scanning, setScanning] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(true);
  const [username, setUsername] = useState(() => localStorage.getItem("username") || "");
  const [recentCalls, setRecentCalls] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
  const [typingUsers, setTypingUsers] = useState({});
  const [connectionStats, setConnectionStats] = useState(null);
  const [cpuScore, setCpuScore] = useState(null);
  const [albums, setAlbums] = useState([]);
  const [activeAlbum, setActiveAlbum] = useState(null);
  const [fileTransfers, setFileTransfers] = useState({}); // id -> {progress, state, meta, error}
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");
  const [deletedUndoQueue, setDeletedUndoQueue] = useState({}); // id -> timeoutId
  const [connected, setConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // refs
  const pc = useRef(null);
  const dc = useRef(null);
  const localStream = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const qrScannerRef = useRef(null);
  const statsInterval = useRef(null);
  const lastStats = useRef({ timestamp: 0, bytesSent: 0, bytesReceived: 0 });
  const incomingFileBuffers = useRef({}); // transferId -> {meta, receivedBytes, buffers}
  const outgoingFileQueue = useRef({}); // transferId -> {file, meta, offset}
  const sendTypingTimeout = useRef(null);
  const screenSenderRef = useRef(null); // store the RTCRtpSender for screen share
  const originalVideoTrackRef = useRef(null);

  // init
  useEffect(() => {
    if (!username) {
      const name = prompt("Enter your username:") || `user_${uid()}`;
      setUsername(name);
      localStorage.setItem("username", name);
    }
    getRecentCalls().then(setRecentCalls);
    getChatHistory().then((h) => { if (h && h.length) setMessages(h[0].messages || []); });
    getAlbums().then(setAlbums);
    document.documentElement.setAttribute("data-theme", theme);

    // keyboard shortcuts
    const onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "b") { e.preventDefault(); toggleMute(); }
      if (e.ctrlKey && e.key.toLowerCase() === "e") { e.preventDefault(); toggleVideo(); }
      if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); scanning ? stopQRScan() : startQRScan(); }
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); runCpuBench(); }
      if (e.ctrlKey && e.key.toLowerCase() === "q") { e.preventDefault(); createConnection(); }
      if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); sendMessage(); }
      if (e.key === "Escape") { e.preventDefault(); endCall(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, []); // only once

  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // compression helpers
  const compress = (str) => btoa(String.fromCharCode(...pako.deflate(str)));
  const decompress = (base64) =>
    pako.inflate(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), { to: "string" });

  // upload sdp
  const uploadSDPToJsonBlob = async (compressedSDP) => {
    const res = await axios.post(
      "https://jsonblob.com/api/jsonBlob",
      JSON.stringify({ sdp: compressedSDP }),
      { headers: { "Content-Type": "application/json" } }
    );
    return res.headers.location.replace("http://", "https://");
  };

  // local stream helper
  const initLocalStream = async () => {
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream.current;
      return true;
    } catch {
      alert("❌ Camera/Microphone access denied.");
      return false;
    }
  };

  // common pc handlers
  const attachCommonHandlers = (pcInstance) => {
    pcInstance.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
    };
    pcInstance.oniceconnectionstatechange = () => {
      const s = pcInstance.iceConnectionState;
      setStatus((prev) => (s === "connected" ? "✅ Connected!" : prev));
      if (s === "connected") setConnected(true);
      if (s === "disconnected" || s === "failed") { setStatus("⚠️ Connection lost"); setConnected(false); }
    };
    pcInstance.onicecandidate = async (e) => {
      if (!e.candidate) {
        const sdp = JSON.stringify(pcInstance.localDescription);
        const url = await uploadSDPToJsonBlob(compress(sdp));
        setLocalSDPUrl(url);
        setStatus(pcInstance.signalingState === "stable" ? "✅ Answer ready. Share back." : "✅ Offer ready. Share QR or link.");
      }
    };
  };

  // data channel setup
  const setupDataChannel = (channel) => {
    channel.onopen = () => {
      setStatus("✅ Connected!");
      setConnected(true);
      sendSignal({ type: "presence", payload: { username } });
    };
    channel.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleSignal(msg);
      } catch {
        setMessages((m) => [...m, { id: uid(), from: "peer", type: "text", text: ev.data, ts: nowTs(), delivered: true }]);
      }
    };
    channel.onclose = () => { setStatus("📴 Data channel closed"); setConnected(false); };
  };

  // create caller
  const createConnection = async () => {
    if (pc.current) return;
    if (!(await initLocalStream())) return;
    pc.current = new RTCPeerConnection();
    attachCommonHandlers(pc.current);
    localStream.current.getTracks().forEach((t) => pc.current.addTrack(t, localStream.current));
    dc.current = pc.current.createDataChannel("chat");
    setupDataChannel(dc.current);
    const offer = await pc.current.createOffer();
    await pc.current.setLocalDescription(offer);
    startStats();
  };

  // setup answerer
  const setupAnswerer = async () => {
    if (pc.current) return;
    if (!(await initLocalStream())) return;
    pc.current = new RTCPeerConnection();
    attachCommonHandlers(pc.current);
    localStream.current.getTracks().forEach((t) => pc.current.addTrack(t, localStream.current));
    pc.current.ondatachannel = (e) => {
      dc.current = e.channel;
      setupDataChannel(dc.current);
    };
    startStats();
  };

  // handle remote SDP
  const handleRemoteSDP = async (inputVal) => {
    try {
      let compressed = (inputVal || remoteSDP).trim();
      if (!compressed) return;
      if (compressed.startsWith("http")) {
        const { data } = await axios.get(compressed);
        compressed = data.sdp;
      }
      const desc = JSON.parse(decompress(compressed));
      if (desc.type === "answer" && pc.current?.signalingState !== "have-local-offer") throw new Error("Received answer before offer.");
      if (!pc.current && desc.type === "offer") await setupAnswerer();
      await pc.current.setRemoteDescription(new RTCSessionDescription(desc));
      if (desc.type === "offer") {
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
        setStatus("📡 Answer sent.");
      } else setStatus("✅ Remote SDP set.");
    } catch (e) {
      alert("❌ Invalid SDP.");
      console.error(e);
    }
  };

  // structured message handler
  const handleSignal = async (msg) => {
    if (!msg || !msg.type) return;
    const { type, payload } = msg;

    if (type === "chat") {
      setMessages((m) => [...m, { ...payload, delivered: true }]);
      sendSignal({ type: "ack", payload: { id: payload.id } });
    } else if (type === "typing") {
      setTypingUsers((t) => ({ ...t, [payload.username]: Date.now() }));
      setTimeout(() => setTypingUsers((t) => { const copy = { ...t }; if (Date.now() - copy[payload.username] > 1400) delete copy[payload.username]; return copy; }), 1500);
    } else if (type === "reaction") {
      setMessages((m) => m.map((mm) => {
        if (mm.id !== payload.id) return mm;
        const counts = { ...(mm.reactions || {}) };
        counts[payload.reaction] = (counts[payload.reaction] || 0) + 1;
        return { ...mm, reactions: counts };
      }));
    } else if (type === "edit") {
      setMessages((m) => m.map((mm) => (mm.id === payload.id ? { ...mm, text: payload.text, edited: true } : mm)));
    } else if (type === "delete") {
      setMessages((m) => m.map((mm) => (mm.id === payload.id ? { ...mm, deleted: true } : mm)));
    } else if (type === "ack") {
      setMessages((m) => m.map((mm) => (mm.id === payload.id ? { ...mm, delivered: true } : mm)));
    } else if (type === "presence") {
      setStatus((s) => (s.includes(payload.username) ? s : `${s} · ${payload.username} online`));
    } else if (type === "file-meta") {
      // incoming file initialization
      const { transferId, meta, albumId } = payload;
      incomingFileBuffers.current[transferId] = { meta, receivedBytes: 0, buffers: [], albumId: albumId || null };
      setFileTransfers((t) => ({ ...t, [transferId]: { progress: 0, state: "receiving", meta } }));
      // reply ready
      sendSignal({ type: "file-ready", payload: { transferId } });
    } else if (type === "file-chunk") {
      const { transferId, chunkBase64 } = payload;
      const obj = incomingFileBuffers.current[transferId];
      if (!obj) return;
      const arr = Uint8Array.from(atob(chunkBase64), (c) => c.charCodeAt(0));
      obj.buffers.push(arr.buffer);
      obj.receivedBytes += arr.byteLength;
      const prog = Math.round((obj.receivedBytes / obj.meta.size) * 100);
      setFileTransfers((t) => ({ ...t, [transferId]: { ...(t[transferId] || {}), progress: prog } }));
      // if complete
      if (obj.receivedBytes >= obj.meta.size) {
        const blob = new Blob(obj.buffers, { type: obj.meta.type });
        // save blob to IndexedDB and create album entry
        const fileId = await saveFileBlob({ id: uid(), name: obj.meta.name, type: obj.meta.type, size: obj.meta.size, ts: nowTs() }, blob);
        // add to shared album default if not provided
        let albumId = obj.albumId || payload.albumId || null;
        if (!albumId) {
          const newAlbum = { id: `shared_${uid()}`, name: "Shared Album", owner: payload.from || "peer", ts: nowTs() };
          await saveAlbum(newAlbum);
          setAlbums(await getAlbums());
          albumId = newAlbum.id;
        }
        await saveFileMeta(fileId, albumId);
        setFileTransfers((t) => ({ ...t, [transferId]: { ...(t[transferId] || {}), progress: 100, state: "done", fileId } }));
        delete incomingFileBuffers.current[transferId];
        // notify user (more helpful message)
        setMessages((m) => [...m, { id: uid(), from: "system", type: "system", text: `Received file "${obj.meta.name}" (${Math.round(obj.meta.size/1024)} KB). Click download in Transfers to save.`, ts: nowTs() }]);
      }
    } else if (type === "file-ready") {
      // remote ready to receive; start sending chunks
      const { transferId } = payload;
      sendPendingChunks(transferId);
    } else if (type === "album-sync") {
      const { album } = payload;
      await saveAlbum(album);
      setAlbums(await getAlbums());
    } else if (type === "control") {
      // control commands: remote can request actions (mute/video/screen)
      const { cmd } = payload;
      if (cmd === "mute") toggleMute();
      if (cmd === "video-off") toggleVideo();
      if (cmd === "clear-chat") setMessages([]);
    }
  };

  const sendSignal = (obj) => {
    if (dc.current?.readyState === "open") {
      try { dc.current.send(JSON.stringify(obj)); } catch (e) { console.warn("sendSignal", e); }
    }
  };

  // chat actions
  const sendMessage = (text = input) => {
    if (!text?.trim() || dc.current?.readyState !== "open") return;
    const msgObj = { id: uid(), from: username || "me", type: "text", text: text.trim(), ts: nowTs(), delivered: false };
    setMessages((m) => [...m, msgObj]);
    sendSignal({ type: "chat", payload: msgObj });
    setInput(""); // clear input after send
  };

  const sendTyping = () => {
    if (dc.current?.readyState !== "open") return;
    if (sendTypingTimeout.current) clearTimeout(sendTypingTimeout.current);
    sendSignal({ type: "typing", payload: { username } });
    sendTypingTimeout.current = setTimeout(() => {/* idle */}, 1200);
  };

  const sendReaction = (id, reaction) => {
    // local optimistic update
    setMessages((m) => m.map((mm) => {
      if (mm.id !== id) return mm;
      const counts = { ...(mm.reactions || {}) };
      counts[reaction] = (counts[reaction] || 0) + 1;
      return { ...mm, reactions: counts };
    }));
    sendSignal({ type: "reaction", payload: { id, reaction } });
  };

  const startEdit = (msg) => {
    setEditingId(msg.id);
    setEditingText(msg.text || "");
  };
  const saveEdit = (id) => {
    if (!editingText) { setEditingId(null); return; }
    setMessages((m) => m.map((mm) => (mm.id === id ? { ...mm, text: editingText, edited: true } : mm)));
    sendSignal({ type: "edit", payload: { id, text: editingText } });
    setEditingId(null);
    setEditingText("");
  };

  const softDelete = (id) => {
    setMessages((m) => m.map((mm) => (mm.id === id ? { ...mm, deleted: true } : mm)));
    sendSignal({ type: "delete", payload: { id } });
    // allow undo for 6s
    const undoId = setTimeout(() => {
      setDeletedUndoQueue((q) => {
        const copy = { ...q }; delete copy[id]; return copy;
      });
    }, 6000);
    setDeletedUndoQueue((q) => ({ ...q, [id]: undoId }));
  };
  const undoDelete = (id) => {
    if (deletedUndoQueue[id]) {
      clearTimeout(deletedUndoQueue[id]);
      setDeletedUndoQueue((q) => { const c = { ...q }; delete c[id]; return c; });
      setMessages((m) => m.map((mm) => (mm.id === id ? { ...mm, deleted: false } : mm)));
      // no signal needed — keep it local
    }
  };

  const openFile = async (fileMeta) => {
    try {
      const blob = await getFileBlob(fileMeta.id || fileMeta.fileId || fileMeta.key);
      if (!blob) return alert("File not available locally.");
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    } catch (e) {
      console.error(e);
      alert("Failed to open file.");
    }
  };

  // controls
  const toggleMute = () => { localStream.current?.getAudioTracks().forEach((t) => (t.enabled = !t.enabled)); setMuted((m) => !m); };
  const toggleVideo = () => { localStream.current?.getVideoTracks().forEach((t) => (t.enabled = !t.enabled)); setVideoOn((v) => !v); };

  // send a control command to peer (they will perform same action if using same app)
  const sendControl = (cmd) => { sendSignal({ type: 'control', payload: { cmd } }); };

  const endCall = () => {
    dc.current?.close(); pc.current?.close(); localStream.current?.getTracks().forEach((t) => t.stop());
    localVideoRef.current && (localVideoRef.current.srcObject = null);
    remoteVideoRef.current && (remoteVideoRef.current.srcObject = null);
    saveCall({ remoteSDP, status, video: videoOn, muted, username });
    saveChat({ username, messages });
    pc.current = null; dc.current = null; stopStats();
    setConnected(false);
    setStatus("📴 Call ended");
  };

  // screen share (local)
  const startScreenShare = async () => {
    if (!pc.current) return alert('Not in call');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      // replace sender track
      const sender = pc.current.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        originalVideoTrackRef.current = sender.track;
        sender.replaceTrack(track);
        screenSenderRef.current = sender;
        track.onended = () => {
          // restore
          if (originalVideoTrackRef.current) sender.replaceTrack(originalVideoTrackRef.current);
        };
      }
    } catch (e) { console.warn('screen share failed', e); }
  };

  // copy to clipboard
  const copyToClipboard = async (text) => { try { await navigator.clipboard.writeText(text); setStatus("Link copied to clipboard"); } catch { setStatus("Copy failed"); } };

  // stats
  const startStats = () => {
    stopStats();
    lastStats.current = { timestamp: performance.now(), bytesSent: 0, bytesReceived: 0 };
    statsInterval.current = setInterval(async () => {
      if (!pc.current) return;
      const stats = await pc.current.getStats();
      let outBytes = 0, inBytes = 0, rtt = null, packetsLost = 0;
      stats.forEach((report) => {
        if (report.type === "outbound-rtp") { if (report.bytesSent) outBytes = report.bytesSent; if (typeof report.packetsLost === "number") packetsLost += report.packetsLost; }
        if (report.type === "inbound-rtp") { if (report.bytesReceived) inBytes = report.bytesReceived; if (typeof report.packetsLost === "number") packetsLost += report.packetsLost; }
        if (report.type === "candidate-pair" && report.currentRoundTripTime) rtt = report.currentRoundTripTime;
      });
      const now = performance.now(); const dt = (now - lastStats.current.timestamp) / 1000 || 1;
      const upKbps = Math.max(0, Math.round(((outBytes - lastStats.current.bytesSent) * 8) / 1000 / dt));
      const downKbps = Math.max(0, Math.round(((inBytes - lastStats.current.bytesReceived) * 8) / 1000 / dt));
      lastStats.current = { timestamp: now, bytesSent: outBytes, bytesReceived: inBytes };
      setConnectionStats({ upKbps, downKbps, rtt: rtt ? Math.round(rtt * 1000) + " ms" : "n/a", packetsLost });
    }, 1500);
  };
  const stopStats = () => { if (statsInterval.current) clearInterval(statsInterval.current); };

  // qr
  const startQRScan = async () => {
    const qrRegionId = "qr-reader";
    if (!qrScannerRef.current) qrScannerRef.current = new Html5Qrcode(qrRegionId);
    try {
      await qrScannerRef.current.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
          if (!decodedText) return;
          stopQRScan();
          await handleRemoteSDP(decodedText);
        },
        (err) => console.warn("QR decode error:", err)
      );
      setScanning(true);
    } catch (err) { console.error("QR start failed:", err); setScanning(false); }
  };
  const stopQRScan = async () => { try { await qrScannerRef.current?.stop(); } catch (e) { console.warn("QR scanner stop failed:", e); } finally { setScanning(false); } };

  // cpu bench
  const runCpuBench = async () => {
    const iterations = 300000;
    const start = performance.now();
    let x = 0;
    for (let i = 0; i < iterations; i++) x += Math.sin(i) * Math.tan(i + 1);
    const dur = performance.now() - start;
    const opsPerMs = iterations / dur;
    const score = Math.round(opsPerMs * 1000);
    setCpuScore(score);
  };

  // FILE TRANSFER: prepare and send
  const sendFile = async (file, albumId = null) => {
    if (!dc.current || dc.current.readyState !== "open") { alert("Data channel not open"); return; }
    if (file.size > 100 * 1024 * 1024) { alert("Max file size 100MB"); return; }
    const transferId = `tx_${uid()}`;
    const meta = { name: file.name, size: file.size, type: file.type, ts: nowTs() };
    outgoingFileQueue.current[transferId] = { file, meta, offset: 0 };
    setFileTransfers((t) => ({ ...t, [transferId]: { progress: 0, state: "waiting", meta } }));
    sendSignal({ type: "file-meta", payload: { transferId, meta, albumId } });
    // will wait for file-ready message before sending chunks
  };

  const sendPendingChunks = async (transferId) => {
    const q = outgoingFileQueue.current[transferId];
    if (!q) return;
    const { file } = q;
    const reader = new FileReader();
    let offset = q.offset;
    const sendChunk = (chunk) => {
      const base64 = btoa(String.fromCharCode(...new Uint8Array(chunk)));
      sendSignal({ type: "file-chunk", payload: { transferId, chunkBase64: base64 } });
      offset += chunk.byteLength;
      outgoingFileQueue.current[transferId].offset = offset;
      const prog = Math.round((offset / file.size) * 100);
      setFileTransfers((t) => ({ ...t, [transferId]: { ...(t[transferId] || {}), progress: prog, state: "sending", meta: t[transferId]?.meta || q.meta } }));
    };
    try {
      while (offset < file.size) {
        const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
        const chunk = await new Promise((res, rej) => {
          reader.onload = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsArrayBuffer(slice);
        });
        while (dc.current.bufferedAmount > 512 * 1024) {
          await new Promise((r) => setTimeout(r, 100));
        }
        sendChunk(chunk);
      }
      setFileTransfers((t) => ({ ...t, [transferId]: { ...(t[transferId] || {}), progress: 100, state: "done" } }));
      const savedId = await saveFileMeta({ id: transferId, name: file.name, type: file.type, size: file.size, ts: nowTs() }, activeAlbum || null);
      // keep outgoingFileQueue entry ephemeral
      delete outgoingFileQueue.current[transferId];
      setMessages((m) => [...m, { id: uid(), from: "system", type: "system", text: `Sent file "${file.name}"`, ts: nowTs() }]);
    } catch (e) {
      console.error("sendPendingChunks failed", e);
      setFileTransfers((t) => ({ ...t, [transferId]: { ...(t[transferId] || {}), state: "error", error: e.message } }));
    }
  };

  // UI file input handler: ensure files are handled one by one (already awaited in loop)
  const handleFileInput = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) await sendFile(f, activeAlbum);
    e.target.value = "";
  };

  // load albums
  const reloadAlbums = async () => setAlbums(await getAlbums());

  // set active album
  const createAlbum = async () => {
    const name = prompt("Album name") || `Album ${uid()}`;
    const album = { id: `alb_${uid()}`, name, owner: username, ts: nowTs() };
    await saveAlbum(album);
    await reloadAlbums();
    setActiveAlbum(album.id);
    shareAlbum(album);
  };

  // fetch files for album
  const openAlbum = async (albumId) => {
    setActiveAlbum(albumId);
    const files = await getFilesForAlbum(albumId);
    setMessages((m) => [...m, { id: uid(), from: "system", type: "system", text: `Opened album with ${files.length} files`, ts: nowTs() }]);
  };

  // send album metadata to peer
  const shareAlbum = (album) => {
    sendSignal({ type: "album-sync", payload: { album } });
  };

  // autosave chats
  useEffect(() => {
    const t = setInterval(() => { saveChat({ username, messages }); }, 10000);
    return () => clearInterval(t);
  }, [messages, username]);

  // helper: set remote from textarea
  const handleSetRemoteFromInput = () => handleRemoteSDP(remoteSDP);

  // retry transfer
  const retryTransfer = (transferId) => {
    const q = outgoingFileQueue.current[transferId];
    if (q) sendPendingChunks(transferId);
    else {
      // attempt re-read from saved meta if present (best-effort)
      setFileTransfers((t) => ({ ...t, [transferId]: { ...(t[transferId] || {}), state: "error" } }));
    }
  };

  // download helper for receiver
  const downloadFile = async (fileId, name) => {
    try {
      const blob = await getFileBlob(fileId);
      if (!blob) return alert('File not found');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { console.error(e); alert('Download failed'); }
  };

  // UI: hide side panels while connected to avoid overflow on small devices
  const renderSidebar = () => (
    <aside className="sidebar glass-panel">
      <h1 className="logo">tx</h1>
      <Tx />
      <button onClick={createConnection}>📞 Make Call (Ctrl+Q)</button>
      <button onClick={scanning ? stopQRScan : startQRScan}>{scanning ? "✖ Stop Scan (Ctrl+K)" : "📷 Scan QR (Ctrl+K)"}</button>
      <button onClick={() => { toggleMute(); sendControl('mute'); }}>{muted ? "🔊 Unmute (Ctrl+B)" : "🔇 Mute (Ctrl+B)"}</button>
      <button onClick={() => { toggleVideo(); sendControl('video-off'); }}>{videoOn ? "🙈 Hide Camera (Ctrl+E)" : "📸 Show Camera (Ctrl+E)"}</button>
      <button onClick={endCall}>❌ End Call (Esc)</button>
      <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>🌓 Toggle Theme</button>
      <button onClick={() => setShowSettings((s) => !s)}>⚙️ Settings</button>
      <p className="status">{status}</p>

      {connectionStats && (
        <div className="stats">
          <div>Up: {connectionStats.upKbps} kbps</div>
          <div>Down: {connectionStats.downKbps} kbps</div>
          <div>RTT: {connectionStats.rtt}</div>
          <div>Lost: {connectionStats.packetsLost}</div>
        </div>
      )}

      <div className="perf">
        <div>CPU score: {cpuScore ?? "n/a"} (Run Ctrl+S)</div>
        <button onClick={runCpuBench}>Run CPU Benchmark (Ctrl+S)</button>
      </div>

      <div className="file-controls" style={{ marginTop: 12 }}>
        <div>Albums</div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={createAlbum}>+ New Album</button>
          <button onClick={reloadAlbums}>Refresh</button>
        </div>
        <div style={{ marginTop: 8 }}>
          {albums.map((a) => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
              <div style={{ cursor: "pointer" }} onClick={() => openAlbum(a.id)}>{a.name}</div>
              <div>
                <button onClick={() => { setActiveAlbum(a.id); shareAlbum(a); }}>Share</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showSettings && (
        <div style={{ marginTop: 12 }}>
          <h4>Settings</h4>
          <div>
            <label>Username: <input value={username} onChange={(e) => { setUsername(e.target.value); localStorage.setItem('username', e.target.value); }} /></label>
          </div>
          <div style={{ marginTop: 8 }}>
            <button onClick={() => { setMessages([]); sendControl('clear-chat'); }}>Clear Chat (local + remote)</button>
          </div>
        </div>
      )}
    </aside>
  );

  return (
    <div className="app-grid">
      {/* show sidebar only when NOT connected to reduce overflow on small screens */}
      {!connected && renderSidebar()}

      <main className="content">
        <div className="video-grid" style={{ position: 'relative' }}>
          {/* Remote large when connected */}
          <div className="video-wrapper" style={{ flex: connected ? 2 : 1, minHeight: 280 }}>
            <video ref={remoteVideoRef} autoPlay playsInline style={{ width: '100%', height: '100%', background: '#000' }} />
            <span className="video-label">{connected ? (/* prefer showing peer name when available */ 'Peer') : 'Peer'}</span>

            {/* overlay controls on remote video */}
            {connected && (
              <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', gap: 8, zIndex: 20 }}>
                <button onClick={() => { toggleMute(); sendControl('mute'); }}>{muted ? 'Unmute' : 'Mute'}</button>
                <button onClick={() => { toggleVideo(); sendControl('video-off'); }}>{videoOn ? 'Hide Camera' : 'Show Camera'}</button>
                <button onClick={startScreenShare}>Share Screen</button>
                <button onClick={endCall}>End Call</button>
              </div>
            )}
          </div>

          {/* local small picture-in-picture */}
          <div className="video-wrapper" style={{ width: connected ? 200 : 'auto', height: connected ? 140 : 'auto', position: connected ? 'absolute' : 'relative', right: connected ? 12 : 'auto', bottom: connected ? 12 : 'auto', zIndex: connected ? 30 : 'auto', border: connected ? '2px solid rgba(255,255,255,0.6)' : undefined }}>
            <video ref={localVideoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            <span className="video-label">{username || 'Me'}</span>
          </div>
        </div>

        <div className="chat-section glass-panel">
          <div className="chat-box">
            {messages.length === 0 && <p>No messages yet</p>}
            {messages.map((msg, i) => (
              <div key={msg.id || i} className={`chat-message ${msg.deleted ? "deleted" : ""}`}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div>
                    <strong>{msg.from}</strong>
                    <small style={{ marginLeft: 8 }}>{formatTime(msg.ts)}</small>
                    {msg.edited && <small> · edited</small>}
                    <small style={{ marginLeft: 8, opacity: 0.7 }}>{msg.type || "text"}</small>
                  </div>
                  <div style={{ opacity: 0.85 }}>{msg.from === username ? "you" : ""}</div>
                </div>

                {/* message body or inline edit */}
                <div style={{ marginTop: 8 }}>
                  {editingId === msg.id ? (
                    <>
                      <input
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveEdit(msg.id); }}
                      />
                      <button onClick={() => saveEdit(msg.id)}>Save</button>
                      <button onClick={() => { setEditingId(null); setEditingText(""); }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      {msg.deleted ? (
                        <em>message deleted</em>
                      ) : msg.type === "file" ? (
                        <div>
                          <div style={{ fontWeight: 600 }}>{msg.fileName || msg.text}</div>
                          <div style={{ marginTop: 6 }}>
                            <button onClick={() => openFile(msg)}>Open</button>
                            <button onClick={() => setMessages((m) => m.map(mm => mm.id === msg.id ? { ...mm, pinned: !mm.pinned } : mm))}>
                              {msg.pinned ? "Unpin" : "Pin"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>{msg.text}</div>
                      )}
                    </>
                  )}
                </div>

                {/* actions */}
                <div className="chat-actions" style={{ marginTop: 8 }}>
                  {!msg.deleted && REACTIONS.map((r) => <button key={r} onClick={() => sendReaction(msg.id, r)}>{r}</button>)}
                  {!msg.deleted && msg.from === username && <button onClick={() => startEdit(msg)}>✏️ Edit</button>}
                  {!msg.deleted && <button onClick={() => { if (confirm("Delete message?")) softDelete(msg.id); }}>🗑️ Delete</button>}
                  {msg.deleted && deletedUndoQueue[msg.id] && <button onClick={() => undoDelete(msg.id)}>↶ Undo</button>}
                  <div style={{ marginLeft: 8 }} className="reaction">
                    {msg.reactions && Object.entries(msg.reactions).map(([r, c]) => <span key={r} title={r} style={{ marginRight: 6 }}>{r}{c}</span>)}
                  </div>
                  <div style={{ marginLeft: 8 }} className="delivered">{msg.delivered ? "✓" : "…"}</div>
                </div>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              {Object.keys(typingUsers).length > 0 && <small>{Object.keys(typingUsers).join(", ")} typing…</small>}
            </div>
          </div>

          <div className="chat-input">
            <input
              type="text"
              value={input}
              onChange={(e) => { setInput(e.target.value); sendTyping(); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Message... (Enter to send, Shift+Enter newline) or Ctrl+Enter"
              disabled={!dc.current || dc.current.readyState !== "open"}
            />
            <button onClick={() => sendMessage()} disabled={!input.trim() || !(dc.current?.readyState === "open")}>Send</button>
            <label style={{ marginLeft: 8 }}>
              <input type="file" multiple onChange={handleFileInput} />
            </label>
          </div>

          <div style={{ marginTop: 10 }}>
            <h4>Transfers</h4>
            {Object.entries(fileTransfers).map(([id, t]) => (
              <div key={id} style={{ marginTop: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>{t.meta?.name || id} — {t.progress}% — {t.state}</div>
                  <div>
                    {t.state === "error" && <button onClick={() => retryTransfer(id)}>Retry</button>}
                    {t.state !== "done" && t.state !== "error" && <button onClick={() => setFileTransfers((ft)=>({...ft,[id]:{...(ft[id]||{}),state:'cancelled'}}))}>Cancel</button>}
                    {t.state === 'done' && t.fileId && <button onClick={() => downloadFile(t.fileId, t.meta?.name)}>Download</button>}
                  </div>
                </div>
                <progress value={t.progress} max="100" style={{ width: "100%" }} />
                {t.error && <div style={{ color: "salmon" }}>{t.error}</div>}
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Show SDP panel if not connected OR a local SDP URL exists (so user can copy/scan) */}
      {(!connected || localSDPUrl) && (
        <aside className="sdp-panel glass-panel">
          {localSDPUrl && (
            <div>
              <h4>📤 Share this Link</h4>
              <textarea readOnly value={localSDPUrl} rows="2" />
              <div className="QrCode"><QRCodeSVG value={localSDPUrl} size={160} /></div>
              <div style={{ marginTop: 8 }}>
                <button onClick={() => { copyToClipboard(localSDPUrl); setStatus('Link copied'); }}>Copy Link</button>
                <button onClick={() => setLocalSDPUrl("")} style={{ marginLeft: 8 }}>Dismiss</button>
              </div>
            </div>
          )}
          <textarea
            value={remoteSDP}
            onChange={(e) => setRemoteSDP(e.target.value)}
            placeholder="Paste remote SDP URL..."
          />
          <button onClick={handleSetRemoteFromInput}>✅ Set Remote</button>
          <div id="qr-reader" className={scanning ? "qr-visible" : "qr-hidden"} />
        </aside>
      )}

      {!connected && (
        <aside className="call-history glass-panel">
          <h4>📞 Recent Calls</h4>
          <ul>
            {recentCalls.map((call, i) => (
              <li key={i}>
                <strong>{call.username || "Anonymous"}</strong>
                <br />
                {new Date(call.timestamp).toLocaleString()}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
