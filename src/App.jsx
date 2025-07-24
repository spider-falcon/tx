import { useRef, useState } from 'react';
import pako from 'pako';
import { Html5Qrcode } from 'html5-qrcode';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';

//import './App.css';

export default function App() {
  const [localSDPUrl, setLocalSDPUrl] = useState('');
  const [remoteSDP, setRemoteSDP] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Not connected');
  const [scanning, setScanning] = useState(false);

  const pc = useRef(null);
  const dc = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStream = useRef(null);
  const qrScannerRef = useRef(null);

  const compress = (str) => {
    const compressed = pako.deflate(str);
    return btoa(String.fromCharCode(...compressed));
  };

  const decompress = (base64) => {
    const binary = atob(base64);
    const uint8 = Uint8Array.from(binary, c => c.charCodeAt(0));
    return pako.inflate(uint8, { to: 'string' });
  };

  const uploadSDPToJsonBlob = async (compressedSDP) => {
    try {
      const response = await axios.post(
        'https://jsonblob.com/api/jsonBlob',
        JSON.stringify({ sdp: compressedSDP }),
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.headers.location.replace('http://', 'https://');
    } catch (error) {
      console.error('Failed to upload SDP:', error);
      return '';
    }
  };

  const createConnection = async (isOfferer) => {
    pc.current = new RTCPeerConnection();

    localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream.current.getTracks().forEach(track => {
      pc.current.addTrack(track, localStream.current);
    });

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream.current;
    }

    pc.current.ontrack = (e) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = e.streams[0];
      }
    };

    pc.current.onicecandidate = async (e) => {
      if (!e.candidate) {
        const sdp = JSON.stringify(pc.current.localDescription);
        const compressed = compress(sdp);
        const url = await uploadSDPToJsonBlob(compressed);
        setLocalSDPUrl(url);
      }
    };

    if (isOfferer) {
      setStatus('Offer created. Share SDP link with peer.');
      dc.current = pc.current.createDataChannel('chat');
      setupDataChannel(dc.current);
      const offer = await pc.current.createOffer();
      await pc.current.setLocalDescription(offer);
    } else {
      setStatus('Answer created. Send SDP link back to peer.');
      pc.current.ondatachannel = (event) => {
        dc.current = event.channel;
        setupDataChannel(dc.current);
      };
    }
  };

  const setupDataChannel = (channel) => {
    channel.onopen = () => setStatus('Connected ✅');
    channel.onmessage = (e) => {
      setMessages((prev) => [...prev, { from: 'peer', text: e.data }]);
    };
  };

  const handleRemoteSDP = async () => {
    try {
      let compressed = remoteSDP.trim();

      if (!compressed) return alert('❌ Remote SDP is empty!');

      if (compressed.startsWith('http')) {
        const { data } = await axios.get(compressed.replace('http://', 'https://'));
        if (!data?.sdp) throw new Error('Missing "sdp" field in blob');
        compressed = data.sdp;
      }

      const inflated = decompress(compressed);
      const desc = JSON.parse(inflated);

      if (!desc?.type || !desc?.sdp) throw new Error('Invalid SDP object');

      await pc.current.setRemoteDescription(new RTCSessionDescription(desc));

      if (desc.type === 'offer') {
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
        setStatus('📡 Answer sent.');
      } else {
        setStatus('✅ Remote description set.');
      }
    } catch (err) {
      alert('❌ Invalid SDP or QR code content!\n\n' + err.message);
      console.error(err);
    }
  };

  const sendMessage = () => {
    if (dc.current?.readyState === 'open' && input.trim()) {
      dc.current.send(input);
      setMessages((prev) => [...prev, { from: 'me', text: input }]);
      setInput('');
    }
  };

  const startScreenShare = async () => {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = pc.current.getSenders().find(s => s.track.kind === 'video');

    if (sender) sender.replaceTrack(screenTrack);
    if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;

    screenTrack.onended = () => {
      const camTrack = localStream.current.getVideoTracks()[0];
      if (sender) sender.replaceTrack(camTrack);
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream.current;
    };
  };

  const startQRScan = () => {
    const qrRegionId = "qr-reader";
    setScanning(true);

    if (!qrScannerRef.current) {
      qrScannerRef.current = new Html5Qrcode(qrRegionId);
    }

    qrScannerRef.current.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      (decodedText) => {
        setRemoteSDP(decodedText);
        setStatus('✅ QR scanned. Now click "Set Remote Description"');
        stopQRScan();
      },
      (err) => console.warn('QR scan error:', err)
    );
  };

  const stopQRScan = () => {
    if (qrScannerRef.current) {
      qrScannerRef.current.stop().then(() => setScanning(false));
    }
  };

  const isConnected = dc.current?.readyState === 'open';

  return (
    <div className="app-wrapper dark-theme">
      <aside className="sidebar">
        <h1 className="logo">tx</h1>
        <div className="sidebar-buttons">
          <button onClick={() => createConnection(true)}>🔵 Make Connection</button>
          <button onClick={() => createConnection(false)}>🟢 Get Connection</button>
          <button onClick={startScreenShare}>🖥️ Share Screen</button>
        </div>
        <div className="status-box">
          <p>Status: <span className="status">{status}</span></p>
        </div>
      </aside>

      <main className="main-content">
        <section className="remote-sdp">
          <h2>🔗 Remote SDP or Link</h2>
          <textarea
            placeholder="Paste compressed SDP or jsonblob link"
            value={remoteSDP}
            onChange={(e) => setRemoteSDP(e.target.value)}
            rows="4"
          />
          <div className="actions">
            <button onClick={handleRemoteSDP}>✅ Set Remote</button>
            <button onClick={startQRScan}>📷 Scan QR</button>
          </div>
          <div id="qr-reader" className={scanning ? 'qr-visible' : 'qr-hidden'} />
        </section>

        {localSDPUrl && (
          <section className="sdp-display">
            <h2>📄 Share This URL</h2>
            <textarea readOnly value={localSDPUrl} rows="2" />
            <QRCodeSVG value={localSDPUrl} size={192} />
          </section>
        )}

        <section className="video-grid">
          <div className="video-box">
            <h3>📹 Local</h3>
            <video ref={localVideoRef} autoPlay playsInline muted />
          </div>
          <div className="video-box">
            <h3>🖥️ Remote</h3>
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
        </section>

        <section className="chat-section">
          <h2>💬 Chat</h2>
          <div className="chat-box">
            {messages.map((msg, i) => (
              <div key={i}><strong>{msg.from}:</strong> {msg.text}</div>
            ))}
          </div>
          {isConnected && (
            <div className="chat-input">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type message..."
              />
              <button onClick={sendMessage}>Send</button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}