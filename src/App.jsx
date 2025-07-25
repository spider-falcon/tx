import { useRef, useState } from 'react';
import pako from 'pako';
import { Html5Qrcode } from 'html5-qrcode';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';

import './App.css';

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
    if (pc.current) {
      pc.current.close();
    }

    pc.current = new RTCPeerConnection();

    localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream.current.getTracks().forEach(track => {
      pc.current.addTrack(track, localStream.current);
    });

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream.current;
    }

    let remoteStreamSet = false;
    pc.current.ontrack = (e) => {
      if (!remoteStreamSet) {
        remoteStreamSet = true;
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = e.streams[0];
        }
      }
    };

    pc.current.onicecandidate = async (e) => {
      if (!e.candidate && isOfferer) {
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
      setStatus('Ready to receive offer.');
      pc.current.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };
    }
  };

  const setupDataChannel = (channel) => {
    dc.current = channel;
    dc.current.onopen = () => {
      setStatus('Connected ✅');
    };
    dc.current.onmessage = (e) => {
      setMessages(prev => [...prev, { from: 'peer', text: e.data }]);
    };
  };

  const handleRemoteSDP = async (input) => {
    try {
      let compressed = (input || remoteSDP).trim();
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
      const camTrack = localStream.current?.getVideoTracks()?.[0];
      if (sender && camTrack) {
        sender.replaceTrack(camTrack);
        if (localVideoRef.current) localVideoRef.current.srcObject = localStream.current;
      }
    };
  };

  const startQRScan = async () => {
    const qrRegionId = "qr-reader";
    setScanning(true);

    if (!qrScannerRef.current) {
      qrScannerRef.current = new Html5Qrcode(qrRegionId);
    }

    await qrScannerRef.current.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      async (decodedText) => {
        console.log("Scanned:", decodedText);
        setRemoteSDP(decodedText);
        setStatus('✅ QR scanned. Now setting Remote Description...');

        stopQRScan();

        await createConnection(false);
        await handleRemoteSDP(decodedText);
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
          <button onClick={() => createConnection(true)}>Make Connection</button>
          <button onClick={() => startQRScan()}>Scan & Join</button>
          <button onClick={startScreenShare}>🖥️ Share Screen</button>
        </div>
        <div className="status-box">
          <p><span className="status">{status}</span></p>
        </div>
      </aside>

      <main className="main-content">
        <section className="remote-sdp">
          <textarea
            placeholder="Paste compressed SDP or jsonblob link"
            value={remoteSDP}
            onChange={(e) => setRemoteSDP(e.target.value)}
            rows="4"
          />
          <div className="actions">
            <button onClick={() => createConnection(false)}>⬇️ Start Receiving</button>
            <button onClick={() => handleRemoteSDP()}>✅ Set Remote</button>
          </div>
          <div id="qr-reader" className={scanning ? 'qr-visible' : 'qr-hidden'} />
        </section>

        {localSDPUrl && (
          <section className="sdp-display">
            <h2>📄 Share This URL</h2>
            <textarea readOnly value={localSDPUrl} rows="2" />
            <div className='QRbackground'>
              <QRCodeSVG value={localSDPUrl} size={192} />
            </div>
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
