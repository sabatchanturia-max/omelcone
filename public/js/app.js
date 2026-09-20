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
const chatPanel = document.querySelector('.chat-panel');
const btnChatToggle = document.getElementById('btnChatToggle');
const btnChatClose = document.getElementById('btnChatClose');
const watchStage = document.getElementById('watchStage');
const youtubeUrlInput = document.getElementById('youtubeUrlInput');
const youtubePlayerEl = document.getElementById('youtubePlayer');

// State
let localStream = null;
let peers = new Map(); // peerId -> { pc, videoEl, tile }
let currentRoomId = null;
let currentMode = null; // '1v1' | 'group'
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let micEnabled = true;
let camEnabled = true;
let cameraFacingMode = 'user';
const pendingCandidates = new Map();
let youtubePlayer = null;
let youtubeProgressTimer = null;
let youtubeReadyResolve;
const youtubeReady = new Promise(resolve => { youtubeReadyResolve = resolve; });

window.onYouTubeIframeAPIReady = () => youtubeReadyResolve();

// ===== Helpers =====
function showPage(page) {
  [landing, waitingPage, chatRoom].forEach(p => p.classList.remove('active'));
  page.classList.add('active');
}

function extractYoutubeId(value) {
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
    if (url.hostname.includes('youtube.com')) return url.searchParams.get('v') || url.pathname.split('/').pop();
  } catch (error) {
    return null;
  }
  return null;
}

async function ensureYoutubePlayer(videoId) {
  await youtubeReady;
  if (!youtubePlayer) {
    youtubePlayer = new YT.Player('youtubePlayer', {
      videoId,
      playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1 },
      events: {
        onReady: () => {
          youtubePlayer.playVideo();
          startYoutubeProgress();
        }
      }
    });
  } else {
    youtubePlayer.loadVideoById(videoId);
  }
}

function setWatchMode(enabled) {
  if (watchStage) watchStage.classList.toggle('active', enabled);
  if (enabled) roomTypeBadge.textContent = 'Watch Together';
}

function stopYoutubePlayback() {
  if (!youtubePlayer) return;
  try {
    youtubePlayer.stopVideo();
    youtubePlayer.destroy();
  } catch (error) {
    console.warn('YouTube cleanup failed:', error.message);
  }
  youtubePlayer = null;
  if (youtubeProgressTimer) {
    clearInterval(youtubeProgressTimer);
    youtubeProgressTimer = null;
  }
  if (youtubePlayerEl) youtubePlayerEl.innerHTML = '';
  if (youtubeUrlInput) youtubeUrlInput.value = '';
}

function startYoutubeProgress() {
  if (youtubeProgressTimer) return;
  youtubeProgressTimer = setInterval(() => {
    if (!youtubePlayer || typeof youtubePlayer.getDuration !== 'function') return;
    const duration = youtubePlayer.getDuration();
    if (duration > 0) {
      const seek = document.getElementById('watchSeek');
      if (seek && document.activeElement !== seek) {
        seek.value = (youtubePlayer.getCurrentTime() / duration) * 100;
      }
    }
  }, 500);
}

function sendWatchControl(action, extra = {}) {
  if (currentMode !== 'watch') return;
  socket.emit('watch-control', { action, ...extra });
}

async function loadYoutubeVideo(videoId, broadcast = true) {
  if (!videoId) return;
  await ensureYoutubePlayer(videoId);
  if (broadcast) sendWatchControl('load', { videoId, time: 0, playing: true });
}

function applyWatchState(state) {
  if (!state?.videoId) return;
  ensureYoutubePlayer(state.videoId).then(() => {
    if (typeof state.time === 'number') youtubePlayer.seekTo(state.time, true);
    if (state.playing) youtubePlayer.playVideo();
    else youtubePlayer.pauseVideo();
  });
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
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: cameraFacingMode },
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
    <audio autoplay></audio>
    <div class="tile-label"><i class="fas fa-user"></i> უცნობი</div>
    <div class="tile-status">უკავშირდება...</div>
  `;
  videosArea.appendChild(tile);
  const video = tile.querySelector('video');
  const audio = tile.querySelector('audio');
  video.muted = true;
  video.volume = 1;
  video.addEventListener('click', () => playRemoteVideo(video));
  audio.volume = 1;
  updateGrid();
  return tile;
}

function playRemoteVideo(video) {
  video.volume = 1;
  return video.play().catch(error => console.warn('Remote audio autoplay blocked:', error.message));
}

function playRemoteAudio(audio) {
  audio.muted = false;
  audio.volume = 1;
  return audio.play().catch(error => console.warn('Remote audio autoplay blocked:', error.message));
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
      const audio = tile.querySelector('audio');
      if (e.streams[0]) {
        video.srcObject = e.streams[0];
        audio.srcObject = e.streams[0];
      } else {
        const stream = video.srcObject || new MediaStream();
        stream.addTrack(e.track);
        video.srcObject = stream;
        audio.srcObject = stream;
      }
      const status = tile.querySelector('.tile-status');
      if (status) status.textContent = '';
      playRemoteVideo(video);
      playRemoteAudio(audio);
      e.track.onunmute = () => {
        playRemoteVideo(video);
        playRemoteAudio(audio);
      };
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
  stopYoutubePlayback();
  setWatchMode(false);
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

document.getElementById('btnWatch').onclick = async () => {
  try {
    await getLocalStream();
    await loadIceServers();
    currentMode = 'watch';
    showPage(waitingPage);
    waitingText.textContent = 'ვეძებთ Watch Together პარტნიორს...';
    waitingSub.textContent = 'შემთხვევითი 1-ზე-1 ოთახი';
    socket.emit('join-queue', { mode: 'watch' });
  } catch (err) {
    alert('კამერისა და მიკროფონის ჩართვა ვერ მოხერხდა.');
  }
};

document.getElementById('btnCancelWait').onclick = () => {
  socket.emit('leave');
  showPage(landing);
};

function doNext() {
  cleanupPeers();
  messagesEl.innerHTML = '';
  if (currentMode === '1v1' || currentMode === 'watch') {
    const nextMode = currentMode;
    stopYoutubePlayback();
    showPage(waitingPage);
    waitingText.textContent = nextMode === 'watch'
      ? 'ვეძებთ ახალ Watch Together პარტნიორს...'
      : 'ვეძებთ ახალ პარტნიორს...';
    waitingSub.textContent = nextMode === 'watch' ? 'შემთხვევითი 1-ზე-1 ოთახი' : '1-ზე-1 რეჟიმი';
    socket.emit('next');
    socket.emit('join-queue', { mode: nextMode });
  } else {
    leaveEverything();
  }
}

document.getElementById('btnNext').onclick = doNext;
document.getElementById('btnNextBottom').onclick = doNext;
document.getElementById('btnLeave').onclick = leaveEverything;
document.getElementById('btnLeaveBottom').onclick = leaveEverything;

document.getElementById('btnLoadYoutube').onclick = () => {
  const videoId = extractYoutubeId(youtubeUrlInput.value.trim());
  if (!videoId) {
    addSystemMessage('ჩასვი სწორი YouTube URL.');
    return;
  }
  loadYoutubeVideo(videoId);
};
document.getElementById('btnWatchPlay').onclick = () => {
  if (!youtubePlayer) return;
  youtubePlayer.playVideo();
  sendWatchControl('play', { time: youtubePlayer.getCurrentTime(), playing: true });
};
document.getElementById('btnWatchPause').onclick = () => {
  if (!youtubePlayer) return;
  youtubePlayer.pauseVideo();
  sendWatchControl('pause', { time: youtubePlayer.getCurrentTime(), playing: false });
};
document.getElementById('btnWatchSync').onclick = () => {
  if (!youtubePlayer) return;
  sendWatchControl('sync', { time: youtubePlayer.getCurrentTime(), playing: true });
};
document.getElementById('btnWatchBack').onclick = () => seekYoutube(-10);
document.getElementById('btnWatchForward').onclick = () => seekYoutube(10);
document.getElementById('watchVolume').oninput = (event) => {
  if (!youtubePlayer) return;
  youtubePlayer.setVolume(Number(event.target.value));
  youtubePlayer.unMute();
  document.getElementById('btnWatchMute').innerHTML = '<i class="fas fa-volume-high"></i>';
};
document.getElementById('btnWatchMute').onclick = () => {
  if (!youtubePlayer) return;
  if (youtubePlayer.isMuted()) {
    youtubePlayer.unMute();
    youtubePlayer.setVolume(Number(document.getElementById('watchVolume').value));
    document.getElementById('btnWatchMute').innerHTML = '<i class="fas fa-volume-high"></i>';
  } else {
    youtubePlayer.mute();
    document.getElementById('btnWatchMute').innerHTML = '<i class="fas fa-volume-xmark"></i>';
  }
};
document.getElementById('btnWatchFullscreen').onclick = () => {
  youtubePlayerEl?.requestFullscreen?.();
};
document.getElementById('watchSeek').oninput = (event) => {
  if (!youtubePlayer) return;
  const duration = youtubePlayer.getDuration();
  if (!duration) return;
  const time = (Number(event.target.value) / 100) * duration;
  youtubePlayer.seekTo(time, true);
  sendWatchControl('sync', { time, playing: true });
};

function seekYoutube(seconds) {
  if (!youtubePlayer) return;
  const time = Math.max(0, youtubePlayer.getCurrentTime() + seconds);
  youtubePlayer.seekTo(time, true);
  sendWatchControl('sync', { time, playing: true });
}

function setChatOpen(isOpen) {
  if (!chatPanel) return;
  chatPanel.classList.toggle('open', isOpen);
  if (btnChatToggle) {
    btnChatToggle.classList.toggle('active', isOpen);
    btnChatToggle.title = isOpen ? 'ჩატის დახურვა' : 'ჩატის გახსნა';
  }
}

btnChatToggle?.addEventListener('click', () => setChatOpen(!chatPanel.classList.contains('open')));
btnChatClose?.addEventListener('click', () => setChatOpen(false));

document.addEventListener('click', () => {
  document.querySelectorAll('.video-tile.remote video').forEach(video => {
    playRemoteVideo(video);
  });
  document.querySelectorAll('.video-tile.remote audio').forEach(audio => {
    playRemoteAudio(audio);
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

document.getElementById('btnFlipCam').onclick = async () => {
  if (!localStream || !localStream.getVideoTracks().length) return;

  const previousTrack = localStream.getVideoTracks()[0];
  const nextFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';
  const wasEnabled = previousTrack.enabled;

  try {
    const replacementStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: nextFacingMode },
      audio: false
    });
    const replacementTrack = replacementStream.getVideoTracks()[0];
    replacementTrack.enabled = wasEnabled;

    peers.forEach(({ pc }) => {
      const sender = pc.getSenders().find(item => item.track?.kind === 'video');
      if (sender) sender.replaceTrack(replacementTrack).catch(error => console.warn('Camera switch failed:', error));
    });

    localStream.removeTrack(previousTrack);
    localStream.addTrack(replacementTrack);
    previousTrack.stop();
    localVideo.srcObject = localStream;
    cameraFacingMode = nextFacingMode;
  } catch (error) {
    console.error('Camera flip failed:', error);
  }
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

socket.on('matched', async ({ roomId, peers: peerList, type, media }) => {
  currentRoomId = roomId;
  currentMode = type;
  setWatchMode(type === 'watch');
  roomTypeBadge.textContent = type === 'watch' ? 'Watch Together' : (type === '1v1' ? '1v1' : 'ჯგუფი');
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
  if (type === 'watch') applyWatchState(media);
});

socket.on('room-created', ({ roomId, type }) => {
  currentRoomId = roomId;
  currentMode = type || 'group';
  setWatchMode(currentMode === 'watch');
  roomTypeBadge.textContent = currentMode === 'watch' ? 'Watch Together' : 'ჯგუფი';
  roomIdDisplay.textContent = roomId;
  showPage(chatRoom);
  messagesEl.innerHTML = '';
  addSystemMessage(`ოთახი შეიქმნა! კოდი: ${roomId} — გაუზიარე მეგობრებს`);
  updateGrid();
});

socket.on('watch-control', ({ action, videoId, time, playing }) => {
  if (currentMode !== 'watch') return;
  if (action === 'load') {
    youtubeUrlInput.value = `https://www.youtube.com/watch?v=${videoId}`;
    applyWatchState({ videoId, time, playing });
    return;
  }
  if (!youtubePlayer) return;
  if (typeof time === 'number') youtubePlayer.seekTo(time, true);
  if (playing || action === 'play' || action === 'sync') youtubePlayer.playVideo();
  if (action === 'pause') youtubePlayer.pauseVideo();
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
