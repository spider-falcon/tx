import { useRef, useState } from 'react';
import pako from 'pako';
import { Html5Qrcode } from 'html5-qrcode';
import { QRCodeSVG } from 'qrcode.react';
import axios from 'axios';

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
      return response.headers.location;
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
        const { data } = await axios.get(compressed);
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
    <div style={{ padding: 20, fontFamily: 'Arial' }}>
      <h2>🌐 WebRTC + QR Code Signaling</h2>
      <p><b>Status:</b> {status}</p>

      <div style={{ marginBottom: 10 }}>
        <button onClick={() => createConnection(true)}>🔵 Create Offer</button>
        <button onClick={() => createConnection(false)} style={{ marginLeft: 10 }}>🟢 Create Answer</button>
        <button onClick={startScreenShare} style={{ marginLeft: 10 }}>🖥️ Share Screen</button>
      </div>

      <label><b>Paste or Scan Remote SDP / URL:</b></label><br />
      <textarea
        placeholder="Paste compressed SDP or jsonblob link"
        value={remoteSDP}
        onChange={(e) => setRemoteSDP(e.target.value)}
        rows="4"
        cols="80"
      /><br />
      <button onClick={handleRemoteSDP}>✅ Set Remote Description</button>
      <button onClick={startQRScan} style={{ marginLeft: 10 }}>📷 Scan QR</button>

      <div id="qr-reader" style={{ width: 300, marginTop: 10 }} hidden={!scanning}></div>

      <h4>📄 Your Compressed SDP URL (Share):</h4>
      <textarea readOnly value={localSDPUrl} rows="2" cols="80" />
      {localSDPUrl && (
        <div style={{ marginTop: 10 }}>
          <QRCodeSVG value={localSDPUrl} size={256} />
        </div>
      )}

      <hr />
      <h4>📹 Local Video</h4>
      <video ref={localVideoRef} autoPlay playsInline muted width="300" />

      <h4>🖥️ Remote Video</h4>
      <video ref={remoteVideoRef} autoPlay playsInline width="300" />

      <hr />
      <h4>💬 Chat</h4>
      <div style={{ border: '1px solid gray', padding: 10, minHeight: 100, maxHeight: 200, overflowY: 'auto' }}>
        {messages.map((msg, i) => (
          <div key={i}><b>{msg.from}:</b> {msg.text}</div>
        ))}
      </div>

      {isConnected && (
        <div style={{ marginTop: 10 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type message..."
            style={{ width: 300, padding: 6 }}
          />
          <button onClick={sendMessage} style={{ marginLeft: 10 }}>Send</button>
        </div>
      )}
    </div>
  );
}
