const socket = io(window.APP_CONFIG?.socketUrl || undefined, {
  transports: ['websocket', 'polling']
});

// DOM
const landing = document.getElementById('landing');
const waitingPage = document.getElementById('waiting');
const chatRoom = document.getElementById('chatRoom');
const localVideo = document.getElementById('localVideo');
const videosArea = document.getElementById('videosArea');
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chatInput');
const waitingText = document.getElementById('waitingText');
const waitingSub = document.getElementById('waitingSub');
const roomTypeBadge = document.getElementById('roomTypeBadge');
const roomIdDisplay = document.getElementById('roomIdDisplay');

// State
let localStream = null;
let peers = new Map(); // peerId -> { pc, videoEl, tile }
let currentRoomId = null;
let currentMode = null; // '1v1' | 'group'
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let micEnabled = true;
let camEnabled = true;
const pendingCandidates = new Map();

// ===== Helpers =====
function showPage(page) {
  [landing, waitingPage, chatRoom].forEach(p => p.classList.remove('active'));
  page.classList.add('active');
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addChatMessage(text, isSent) {
  const div = document.createElement('div');
  div.className = `message ${isSent ? 'sent' : 'received'}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadIceServers() {
  try {
    const res = await fetch('/ice-servers');
    iceServers = await res.json();
    console.log('ICE servers loaded', iceServers);
  } catch (e) {
    console.warn('Using default STUN', e);
  }
}

async function getLocalStream() {
  if (localStream) return localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera and microphone require HTTPS or localhost.');
  }

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  // ჯერ ვცდილობთ კამერა + მიკროფონი
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: audioConstraints
    });
    camEnabled = true;
  } catch (err) {
    console.warn('Camera not available, trying audio only:', err.message);
    // მხოლოდ მიკროფონი
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: audioConstraints
      });
      camEnabled = false;
      // კამერის ღილაკი გამორთული მდგომარეობაში
      const camBtn = document.getElementById('btnCam');
      if (camBtn) {
        camBtn.classList.remove('active');
        camBtn.classList.add('muted');
        camBtn.innerHTML = '<i class="fas fa-video-slash"></i>';
        camBtn.title = 'კამერა არ არის';
      }
    } catch (audioErr) {
      console.error('Audio also failed:', audioErr);
      throw audioErr; // ორივე ვერ მოხერხდა
    }
  }

  localVideo.srcObject = localStream;
  return localStream;
}

function updateGrid() {
  const count = peers.size + 1; // + local
  videosArea.className = 'videos-area';
  if (count <= 1) videosArea.classList.add('grid-1');
  else if (count === 2) videosArea.classList.add('grid-2');
  else videosArea.classList.add('grid-4');
}

function createRemoteTile(peerId) {
  const tile = document.createElement('div');
  tile.className = 'video-tile remote';
  tile.id = `tile-${peerId}`;
  tile.innerHTML = `
    <video autoplay playsinline></video>
    <div class="tile-label"><i class="fas fa-user"></i> უცნობი</div>
    <button class="tile-status" type="button">უკავშირდება...</button>
  `;
  videosArea.appendChild(tile);
  const video = tile.querySelector('video');
  video.volume = 1;
  const status = tile.querySelector('.tile-status');
  const enableAudio = () => playRemoteVideo(video, status);
  video.addEventListener('click', enableAudio);
  status.addEventListener('click', enableAudio);
  updateGrid();
  return tile;
}

function playRemoteVideo(video, status) {
  video.muted = false;
  video.volume = 1;
  video.play().then(() => {
    if (status) {
      status.textContent = '';
      status.classList.remove('needs-audio');
    }
  }).catch(() => {
    if (status) {
      status.textContent = '🔊 ხმის ჩასართავად დააჭირე';
      status.classList.add('needs-audio');
    }
  });
}

function removeRemoteTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();
  updateGrid();
}

function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers });

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: peerId, data: { type: 'candidate', candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const video = tile.querySelector('video');
      if (e.streams[0]) {
        video.srcObject = e.streams[0];
      } else {
        const stream = video.srcObject || new MediaStream();
        stream.addTrack(e.track);
        video.srcObject = stream;
      }
      video.muted = false;
      video.volume = 1;
      const status = tile.querySelector('.tile-status');
      playRemoteVideo(video, status);
      e.track.onunmute = () => playRemoteVideo(video, status);
      console.log(`Remote ${peerId} track:`, e.track.kind, e.track.readyState, e.track.enabled);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`PC ${peerId} state:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      // optional cleanup
    }
  };

  peers.set(peerId, { pc });

  if (isInitiator) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('signal', {
          to: peerId,
          data: { type: 'offer', sdp: pc.localDescription }
        });
      })
      .catch(err => console.error('Offer error', err));
  }

  return pc;
}

function handleSignal(from, data) {
  let entry = peers.get(from);

  if (data.type === 'offer') {
    if (!entry) {
      createRemoteTile(from);
      entry = { pc: createPeerConnection(from, false) };
      peers.set(from, entry);
    }
    const pc = entry.pc;
    pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(() => flushPendingCandidates(from, pc))
      .then(() => pc.createAnswer())
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        socket.emit('signal', {
          to: from,
          data: { type: 'answer', sdp: pc.localDescription }
        });
      })
      .catch(err => console.error('Answer error', err));
  } else if (data.type === 'answer') {
    if (entry) {
      entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(() => flushPendingCandidates(from, entry.pc))
        .catch(err => console.error('Set answer error', err));
    }
  } else if (data.type === 'candidate') {
    if (!entry || !entry.pc.remoteDescription) {
      const candidates = pendingCandidates.get(from) || [];
      candidates.push(data.candidate);
      pendingCandidates.set(from, candidates);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate))
      .catch(err => console.warn('ICE error', err));
  }
}

function flushPendingCandidates(peerId, pc) {
  const candidates = pendingCandidates.get(peerId) || [];
  pendingCandidates.delete(peerId);
  return Promise.all(candidates.map(candidate => pc.addIceCandidate(new RTCIceCandidate(candidate))));
}

function cleanupPeers() {
  peers.forEach(({ pc }, id) => {
    try { pc.close(); } catch (e) {}
    removeRemoteTile(id);
  });
  peers.clear();
  pendingCandidates.clear();
}

function leaveEverything() {
  cleanupPeers();
  currentRoomId = null;
  currentMode = null;
  messagesEl.innerHTML = '';
  if (localStream) {
    // keep stream for re-use if user starts again quickly
  }
  socket.emit('leave');
  showPage(landing);
}

// ===== UI Events =====
document.getElementById('btn1v1').onclick = async () => {
  try {
    await getLocalStream();
    await loadIceServers();
    currentMode = '1v1';
    showPage(waitingPage);
    waitingText.textContent = 'ვეძებთ პარტნიორს...';
    waitingSub.textContent = '1-ზე-1 რეჟიმი';
    socket.emit('join-queue', { mode: '1v1' });
  } catch (err) {
    alert('მიკროფონი მიუწვდომელია. გთხოვთ ნებართვა მიეცით (ან შეამოწმეთ რომ მიკროფონი დაკავშირებულია).');
    console.error(err);
  }
};

document.getElementById('btnGroup').onclick = async () => {
  try {
    await getLocalStream();
    await loadIceServers();
    currentMode = 'group';
    showPage(waitingPage);
    waitingText.textContent = 'ვეძებთ ჯგუფს...';
    waitingSub.textContent = '4 ადამიანამდე';
    socket.emit('join-queue', { mode: 'group' });
  } catch (err) {
    alert('მიკროფონი მიუწვდომელია. გთხოვთ ნებართვა მიეცით.');
  }
};

document.getElementById('btnCreate').onclick = async () => {
  try {
    await getLocalStream();
    await loadIceServers();
    currentMode = 'group';
    socket.emit('create-room');
  } catch (err) {
    alert('მიკროფონი მიუწვდომელია. გთხოვთ ნებართვა მიეცით.');
  }
};

document.getElementById('btnJoinCode').onclick = async () => {
  const code = document.getElementById('roomCodeInput').value.trim();
  if (!code) return;
  try {
    await getLocalStream();
    await loadIceServers();
    currentMode = 'group';
    socket.emit('join-room', { roomId: code });
  } catch (err) {
    alert('მიკროფონი მიუწვდომელია. გთხოვთ ნებართვა მიეცით.');
  }
};

document.getElementById('btnCancelWait').onclick = () => {
  socket.emit('leave');
  showPage(landing);
};

function doNext() {
  cleanupPeers();
  messagesEl.innerHTML = '';
  if (currentMode === '1v1') {
    showPage(waitingPage);
    waitingText.textContent = 'ვეძებთ ახალ პარტნიორს...';
    socket.emit('next');
    socket.emit('join-queue', { mode: '1v1' });
  } else {
    leaveEverything();
  }
}

document.getElementById('btnNext').onclick = doNext;
document.getElementById('btnNextBottom').onclick = doNext;
document.getElementById('btnLeave').onclick = leaveEverything;
document.getElementById('btnLeaveBottom').onclick = leaveEverything;

document.addEventListener('click', () => {
  document.querySelectorAll('.video-tile.remote video').forEach(video => {
    playRemoteVideo(video, video.closest('.video-tile')?.querySelector('.tile-status'));
  });
}, { passive: true });

socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error.message);
  waitingSub.textContent = 'სერვერთან დაკავშირება ვერ მოხერხდა. სცადე თავიდან.';
});

document.getElementById('btnCopyCode').onclick = () => {
  if (currentRoomId) {
    navigator.clipboard.writeText(currentRoomId).then(() => {
      addSystemMessage('ოთახის კოდი დაკოპირდა: ' + currentRoomId);
    });
  }
};

// Mic / Cam
document.getElementById('btnMic').onclick = () => {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  const btn = document.getElementById('btnMic');
  btn.classList.toggle('active', micEnabled);
  btn.classList.toggle('muted', !micEnabled);
  btn.innerHTML = micEnabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
};

document.getElementById('btnCam').onclick = () => {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  const btn = document.getElementById('btnCam');
  btn.classList.toggle('active', camEnabled);
  btn.classList.toggle('muted', !camEnabled);
  btn.innerHTML = camEnabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
};

// Chat
document.getElementById('btnSend').onclick = sendChat;
chatInput.onkeypress = (e) => {
  if (e.key === 'Enter') sendChat();
};

function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg || !currentRoomId) return;
  socket.emit('chat', { message: msg });
  addChatMessage(msg, true);
  chatInput.value = '';
}

// ===== Socket events =====
socket.on('waiting', ({ mode, count }) => {
  if (mode === 'group' && count) {
    waitingSub.textContent = `რიგში: ${count}/4`;
  }
});

socket.on('matched', async ({ roomId, peers: peerList, type }) => {
  currentRoomId = roomId;
  currentMode = type;
  roomTypeBadge.textContent = type === '1v1' ? '1v1' : 'ჯგუფი';
  roomIdDisplay.textContent = roomId;
  showPage(chatRoom);
  messagesEl.innerHTML = '';
  addSystemMessage(type === '1v1' ? 'დაკავშირდა უცნობთან!' : `ოთახში ხარ: ${roomId}`);

  // Create connections to each peer
  // Decision who initiates: higher socket.id initiates to avoid glare
  for (const peerId of peerList) {
    if (!peers.has(peerId)) {
      createRemoteTile(peerId);
      const isInitiator = socket.id > peerId;
      createPeerConnection(peerId, isInitiator);
    }
  }
  updateGrid();
});

socket.on('room-created', ({ roomId }) => {
  currentRoomId = roomId;
  currentMode = 'group';
  roomTypeBadge.textContent = 'ჯგუფი';
  roomIdDisplay.textContent = roomId;
  showPage(chatRoom);
  messagesEl.innerHTML = '';
  addSystemMessage(`ოთახი შეიქმნა! კოდი: ${roomId} — გაუზიარე მეგობრებს`);
  updateGrid();
});

socket.on('peer-joined', ({ peerId }) => {
  if (!peers.has(peerId)) {
    createRemoteTile(peerId);
    // Existing users initiate to newcomer if their id is higher
    const isInitiator = socket.id > peerId;
    createPeerConnection(peerId, isInitiator);
    addSystemMessage('ახალი ადამიანი შემოვიდა');
  }
});

socket.on('peer-left', ({ peerId }) => {
  const entry = peers.get(peerId);
  if (entry) {
    try { entry.pc.close(); } catch (e) {}
    peers.delete(peerId);
  }
  removeRemoteTile(peerId);
  addSystemMessage('ვიღაცამ დატოვა ოთახი');
});

socket.on('signal', ({ from, data }) => {
  handleSignal(from, data);
});

socket.on('chat', ({ from, message }) => {
  addChatMessage(message, false);
});

socket.on('error-msg', ({ message }) => {
  alert(message);
  showPage(landing);
});

socket.on('left', () => {
  // already handled
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
  socket.emit('leave');
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  cleanupPeers();
});

// Initial
showPage(landing);
console.log('Ome Clone ready');
