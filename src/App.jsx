import { useRef, useState } from 'react';

export default function App() {
  const [localSDP, setLocalSDP] = useState('');
  const [remoteSDP, setRemoteSDP] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Not connected');

  const pc = useRef(null);
  const dc = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStream = useRef(null);

  const createConnection = async (isOfferer) => {
    pc.current = new RTCPeerConnection();

    // Get camera + mic
    localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream.current.getTracks().forEach((track) => {
      pc.current.addTrack(track, localStream.current);
    });

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream.current;
    }

    pc.current.onicecandidate = (e) => {
      if (!e.candidate) {
        setLocalSDP(JSON.stringify(pc.current.localDescription, null, 2));
      }
    };

    pc.current.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    if (isOfferer) {
      setStatus('Offer created. Share SDP with peer.');
      dc.current = pc.current.createDataChannel('chat');
      setupDataChannel(dc.current);
      const offer = await pc.current.createOffer();
      await pc.current.setLocalDescription(offer);
    } else {
      setStatus('Answer created. Send SDP back to peer.');
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
      const desc = JSON.parse(remoteSDP);
      await pc.current.setRemoteDescription(new RTCSessionDescription(desc));
      if (desc.type === 'offer') {
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
      }
    } catch (err) {
      alert('❌ Invalid SDP! Make sure you pasted a full JSON object.');
      console.error(err);
    }
  };

  const sendMessage = () => {
    if (dc.current && input.trim()) {
      dc.current.send(input);
      setMessages((prev) => [...prev, { from: 'me', text: input }]);
      setInput('');
    }
  };

  const startScreenShare = async () => {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];

    const sender = pc.current.getSenders().find(s => s.track.kind === 'video');
    if (sender) {
      sender.replaceTrack(screenTrack);
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = screenStream;
    }

    screenTrack.onended = () => {
      // Revert to webcam after screen share ends
      const camTrack = localStream.current.getVideoTracks()[0];
      if (sender) {
        sender.replaceTrack(camTrack);
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream.current;
      }
    };
  };

  const isConnected = dc.current && dc.current.readyState === 'open';

  return (
    <div style={{ padding: 20, fontFamily: 'Arial, sans-serif' }}>
      <h2>🌐 WebRTC Chat + Video + Screen Share</h2>
      <p><b>Status:</b> {status}</p>

      <button onClick={() => createConnection(true)}>🔵 Create Offer</button>
      <button onClick={() => createConnection(false)} style={{ marginLeft: 10 }}>🟢 Create Answer</button>
      <button onClick={startScreenShare} style={{ marginLeft: 10 }}>🖥️ Share Screen</button>

      <br /><br />
      <label><b>Paste Remote SDP:</b></label><br />
      <textarea
        placeholder="Paste the peer's full JSON SDP here"
        value={remoteSDP}
        onChange={(e) => setRemoteSDP(e.target.value)}
        rows="8"
        cols="80"
      />
      <br />
      <button onClick={handleRemoteSDP}>✅ Set Remote Description</button>

      <h4>📄 Your SDP (copied automatically):</h4>
      <textarea readOnly value={localSDP} rows="8" cols="80" />

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
            placeholder="Type a message"
            style={{ width: 300, padding: '6px' }}
          />
          <button onClick={sendMessage} style={{ marginLeft: 10 }}>Send</button>
        </div>
      )}
    </div>
  );
}