import { useRef, useState } from 'react';
import pako from 'pako';
import { Html5Qrcode } from 'html5-qrcode';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';

import Tx from "./Tx.jsx"; 
import './App.css';

export default function App() {
  const [localSDPUrl, setLocalSDPUrl] = useState('');
  const [remoteSDP, setRemoteSDP] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Not connected');
  const [scanning, setScanning] = useState(false);
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(true);

  const pc = useRef(null);
  const dc = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStream = useRef(null);
  const qrScannerRef = useRef(null);

  const compress = (str) => btoa(String.fromCharCode(...pako.deflate(str)));
  const decompress = (base64) =>
    pako.inflate(Uint8Array.from(atob(base64), c => c.charCodeAt(0)), { to: 'string' });

  const uploadSDPToJsonBlob = async (compressedSDP) => {
    const res = await axios.post('https://jsonblob.com/api/jsonBlob', JSON.stringify({ sdp: compressedSDP }), {
      headers: { 'Content-Type': 'application/json' },
    });
    return res.headers.location.replace('http://', 'https://');
  };

  const createConnection = async () => {
    if (pc.current) return;

    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      alert('❌ Could not access camera/mic.');
      return;
    }

    pc.current = new RTCPeerConnection();
    localStream.current.getTracks().forEach(track => pc.current.addTrack(track, localStream.current));

    if (localVideoRef.current) localVideoRef.current.srcObject = localStream.current;

    pc.current.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
    };

    pc.current.onicecandidate = async (e) => {
      if (!e.candidate) {
        const sdp = JSON.stringify(pc.current.localDescription);
        const url = await uploadSDPToJsonBlob(compress(sdp));
        setLocalSDPUrl(url);
        setStatus('✅ Offer ready. Share the QR or link.');
      }
    };

    dc.current = pc.current.createDataChannel('chat');
    dc.current.onopen = () => setStatus('✅ Connected!');
    dc.current.onmessage = (e) => setMessages(m => [...m, { from: 'peer', text: e.data }]);

    const offer = await pc.current.createOffer();
    await pc.current.setLocalDescription(offer);
  };

  const setupAnswerer = async () => {
    pc.current = new RTCPeerConnection();

    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream.current.getTracks().forEach((track) => pc.current.addTrack(track, localStream.current));
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream.current;
      }
    } catch (err) {
      alert('❌ Could not access camera/mic.');
      return;
    }

    pc.current.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
    };

    pc.current.ondatachannel = (e) => {
      dc.current = e.channel;
      dc.current.onopen = () => setStatus('✅ Connected!');
      dc.current.onmessage = (e) => setMessages((m) => [...m, { from: 'peer', text: e.data }]);
    };

    pc.current.onicecandidate = async (e) => {
      if (!e.candidate) {
        const sdp = JSON.stringify(pc.current.localDescription);
        const url = await uploadSDPToJsonBlob(compress(sdp));
        setLocalSDPUrl(url);
        setStatus('✅ Answer ready. Share back.');
      }
    };
  };

  const handleRemoteSDP = async (inputVal) => {
    try {
      let compressed = (inputVal || remoteSDP).trim();
      if (!compressed) return;

      if (compressed.startsWith('http')) {
        const { data } = await axios.get(compressed);
        compressed = data.sdp;
      }

      const desc = JSON.parse(decompress(compressed));

      if (desc.type === 'answer' && pc.current?.signalingState !== 'have-local-offer') {
        throw new Error('Received answer before offer was made');
      }

      if (!pc.current && desc.type === 'offer') {
        await setupAnswerer();
      }

      await pc.current.setRemoteDescription(new RTCSessionDescription(desc));

      if (desc.type === 'offer') {
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
        setStatus('📡 Answer sent.');
      } else {
        setStatus('✅ Remote SDP set.');
      }
    } catch (e) {
      alert('❌ Invalid or corrupt SDP.');
      console.error(e);
    }
  };

  const sendMessage = () => {
    if (dc.current?.readyState === 'open') {
      dc.current.send(input);
      setMessages(m => [...m, { from: 'me', text: input }]);
      setInput('');
    }
  };

  const toggleMute = () => {
    localStream.current?.getAudioTracks().forEach(t => (t.enabled = !t.enabled));
    setMuted(m => !m);
  };

  const toggleVideo = () => {
    localStream.current?.getVideoTracks().forEach(t => (t.enabled = !t.enabled));
    setVideoOn(v => !v);
  };

  const startQRScan = async () => {
    const qrRegionId = 'qr-reader';
    if (!qrScannerRef.current) {
      qrScannerRef.current = new Html5Qrcode(qrRegionId);
    }

    try {
      await qrScannerRef.current.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
          if (!decodedText) return;
          stopQRScan();
          await handleRemoteSDP(decodedText);
        },
        (err) => {
          console.warn('QR decode error:', err);
        }
      );
      setScanning(true);
    } catch (err) {
      console.error('QR start failed:', err);
      setScanning(false);
    }
  };

  const stopQRScan = async () => {
    if (qrScannerRef.current) {
      try {
        await qrScannerRef.current.stop();
      } catch (e) {
        console.warn('QR scanner stop failed:', e);
      } finally {
        setScanning(false);
      }
    }
  };

  return (
    <div className="app-grid">
      <aside className="sidebar">
        <h1 className="logo">tx</h1>
        <Tx />
        <button onClick={createConnection}>Make Call</button>
        <button onClick={startQRScan}>📷 Scan QR</button>
        <button onClick={toggleMute}>{muted ? '🔊 Unmute' : '🔇 Mute'}</button>
        <button onClick={toggleVideo}>{videoOn ? '🙈 Hide Camera' : '📸 Show Camera'}</button>
        <p className="status">{status}</p>
      </aside>

      <main className="content">
        <div className="video-grid">
          <div className='localVideo'>
            <video ref={localVideoRef} autoPlay playsInline muted />
          </div>
          <div className='remoteVideo'>
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
        </div>

        <div className="chat-section">
          <div className="chat-box">
            {messages.map((msg, i) => (
              <div key={i}>
                <strong>{msg.from}:</strong> {msg.text}
              </div>
            ))}
          </div>
          <div className="chat-input">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message..."
              disabled={!dc.current || dc.current.readyState !== 'open'}
            />
            <button onClick={sendMessage}>Send</button>
          </div>
        </div>
      </main>

      <aside className="sdp-panel">
        {localSDPUrl && (
          <div>
            <h4>📤 Share this Link</h4>
            <textarea readOnly value={localSDPUrl} rows="2" />
            <div className="QrCode">
              <QRCodeSVG value={localSDPUrl} size={160} />
            </div>
          </div>
        )}

        <textarea
          value={remoteSDP}
          onChange={(e) => setRemoteSDP(e.target.value)}
          placeholder="Paste remote SDP URL..."
        />
        <button onClick={() => handleRemoteSDP()}>✅ Set Remote</button>
        <div id="qr-reader" className={scanning ? 'qr-visible' : 'qr-hidden'} />
      </aside>
    </div>
  );
}

