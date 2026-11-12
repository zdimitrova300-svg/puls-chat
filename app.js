(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);

  const els = {
    joinScreen: $('#joinScreen'),
    chatScreen: $('#chatScreen'),
    joinForm: $('#joinForm'),
    nameInput: $('#nameInput'),
    roomInput: $('#roomInput'),
    randomRoom: $('#randomRoom'),
    joinError: $('#joinError'),
    messages: $('#messages'),
    emptyState: $('#emptyState'),
    emptyRoomCode: $('#emptyRoomCode'),
    typingIndicator: $('#typingIndicator'),
    typingText: $('#typingText'),
    messageInput: $('#messageInput'),
    sendBtn: $('#sendBtn'),
    presenceLabel: $('#presenceLabel'),
    presenceDot: $('#presenceDot'),
    roomTitle: $('#roomTitle'),
    roomAvatar: $('#roomAvatar'),
    copyRoom: $('#copyRoom'),
    leaveBtn: $('#leaveBtn'),
    toast: $('#toast'),
  };

  const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';
  const CLIENT_ID = `puls-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
  const HISTORY_LIMIT = 100;
  const PEER_TIMEOUT = 100000;

  const state = {
    user: '',
    room: '',
    topic: '',
    client: null,
    hadTrouble: false,
    peers: new Map(),
    seen: new Set(),
    typingHideTimer: null,
    lastTypingSent: 0,
    toastTimer: null,
    beatTimer: null,
    pruneTimer: null,
  };

  const PALETTE = [
    ['#8b5cf6', '#5b7cfa'],
    ['#f472b6', '#a855f7'],
    ['#34d399', '#0ea5e9'],
    ['#fbbf24', '#f97316'],
    ['#38bdf8', '#6366f1'],
    ['#fb7185', '#f43f5e'],
    ['#a3e635', '#14b8a6'],
  ];

  const ROOM_WORDS = [
    'luna', 'more', 'veter', 'iskra', 'zvezda', 'planina',
    'gora', 'puls', 'valna', 'kometa', 'snezh', 'shtur',
  ];

  const remember = {
    read(key) {
      try {
        return localStorage.getItem(key) || '';
      } catch {
        return '';
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* хранилището не е достъпно */
      }
    },
  };

  function hashString(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function avatarGradient(name) {
    const [start, end] = PALETTE[hashString(name) % PALETTE.length];
    return `linear-gradient(135deg, ${start}, ${end})`;
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts
      .slice(0, 2)
      .map((part) => [...part][0])
      .join('')
      .toLocaleUpperCase('bg-BG');
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('bg-BG', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function makeId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function sanitizeRoom(raw) {
    return String(raw || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]/gu, '')
      .slice(0, 32);
  }

  function randomRoom() {
    const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
    return `${word}-${Math.floor(100 + Math.random() * 900)}`;
  }

  function showToast(text) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  function isNearBottom() {
    const el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function updateEmptyState() {
    const hasMessages = [...els.messages.children].some((child) => child.id !== 'emptyState');
    els.emptyState.hidden = hasMessages;
    els.emptyRoomCode.textContent = state.room;
  }

  function appendTextWithLinks(container, text) {
    const pattern = /(https?:\/\/[^\s]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text))) {
      if (match.index > lastIndex) {
        container.append(text.slice(lastIndex, match.index));
      }
      const link = document.createElement('a');
      link.href = match[0];
      link.textContent = match[0];
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      container.append(link);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      container.append(text.slice(lastIndex));
    }
  }

  function renderPresence() {
    const connected = Boolean(state.client && state.client.connected);

    if (!connected) {
      els.presenceDot.classList.add('solo');
      els.presenceLabel.textContent = state.hadTrouble
        ? 'Няма връзка — опитваме отново…'
        : 'Свързване…';
      return;
    }

    const names = [state.user, ...[...state.peers.values()].map((peer) => peer.user)];
    els.presenceDot.classList.toggle('solo', names.length < 2);
    els.presenceLabel.textContent = names.length < 2
      ? 'Само ти си тук — сподели кода'
      : `${names.length} онлайн · пишете на живо`;
    els.presenceLabel.title = names.join(', ');
  }

  function renderSystem(text) {
    if (!text) return;
    const row = document.createElement('div');
    row.className = 'system';
    row.textContent = text;
    const stick = isNearBottom();
    els.messages.append(row);
    updateEmptyState();
    if (stick) scrollToBottom();
  }

  function renderMessage(message) {
    if (!message || !message.id || state.seen.has(message.id)) return;
    state.seen.add(message.id);

    const mine = message.user === state.user;
    const article = document.createElement('article');
    article.className = `msg ${mine ? 'mine' : 'theirs'}`;

    if (!mine) {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.background = avatarGradient(message.user);
      avatar.textContent = initials(message.user);
      article.append(avatar);
    }

    const column = document.createElement('div');
    column.className = 'col';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    appendTextWithLinks(bubble, String(message.text || ''));
    column.append(bubble);

    const meta = document.createElement('div');
    meta.className = 'meta';

    if (!mine) {
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = message.user;
      meta.append(name);
    }

    const when = Number(message.time) || Date.now();
    const time = document.createElement('time');
    time.dateTime = new Date(when).toISOString();
    time.textContent = formatTime(when);
    meta.append(time);

    column.append(meta);
    article.append(column);

    const stick = isNearBottom();
    els.messages.append(article);
    updateEmptyState();
    if (stick) scrollToBottom();
  }

  function showTyping(name) {
    els.typingText.textContent = `${name} пише…`;
    els.typingIndicator.hidden = false;
    clearTimeout(state.typingHideTimer);
    state.typingHideTimer = setTimeout(() => {
      els.typingIndicator.hidden = true;
    }, 2400);
  }

  function resetMessages() {
    state.seen.clear();
    [...els.messages.children].forEach((child) => {
      if (child.id !== 'emptyState') child.remove();
    });
    els.emptyState.hidden = false;
  }

  function historyKey() {
    return `puls.history.${state.room}`;
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(historyKey());
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveMessage(message) {
    try {
      const list = loadHistory();
      if (list.some((item) => item && item.id === message.id)) return;
      list.push({
        id: message.id,
        user: message.user,
        text: message.text,
        time: message.time,
      });
      localStorage.setItem(historyKey(), JSON.stringify(list.slice(-HISTORY_LIMIT)));
    } catch {
      /* историята е по избор */
    }
  }

  function renderHistory() {
    const list = loadHistory();
    for (const item of list) {
      if (!item || !item.id || !item.text) continue;
      renderMessage({
        id: String(item.id),
        user: String(item.user || 'Гост'),
        text: String(item.text).slice(0, 2000),
        time: Number(item.time) || Date.now(),
      });
    }
    updateEmptyState();
    scrollToBottom();
  }

  function publishEvent(type, extra = null) {
    const client = state.client;
    if (!client || !client.connected) return false;

    const payload = { v: 1, type, from: CLIENT_ID, user: state.user, time: Date.now() };
    if (extra) Object.assign(payload, extra);

    client.publish(state.topic, JSON.stringify(payload), { qos: 0 });
    return true;
  }

  function handleIncoming(topic, payload) {
    if (topic !== state.topic) return;

    let data;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;

    const from = typeof data.from === 'string' ? data.from : '';
    if (!from || from === CLIENT_ID) return;

    const user = typeof data.user === 'string' && data.user.trim()
      ? data.user.trim().slice(0, 24)
      : 'Гост';
    const peer = state.peers.get(from);

    if (data.type === 'msg') {
      const id = typeof data.id === 'string' ? data.id : '';
      const text = typeof data.text === 'string' ? data.text.slice(0, 2000) : '';
      if (!id || !text) return;

      if (!peer) {
        state.peers.set(from, { user, lastSeen: Date.now() });
        renderPresence();
      } else {
        peer.lastSeen = Date.now();
      }

      if (state.seen.has(id)) return;

      const message = {
        id,
        user,
        text,
        time: Number(data.time) || Date.now(),
      };
      renderMessage(message);
      saveMessage(message);
      return;
    }

    if (data.type === 'typing') {
      if (!peer) return;
      peer.lastSeen = Date.now();
      showTyping(user);
      return;
    }

    if (data.type === 'join') {
      const isNew = !peer;
      state.peers.set(from, { user, lastSeen: Date.now() });
      if (isNew) {
        renderSystem(`${user} се присъедини към чата`);
        publishEvent('hi');
      }
      renderPresence();
      return;
    }

    if (data.type === 'hi') {
      const isNew = !peer;
      state.peers.set(from, { user, lastSeen: Date.now() });
      if (isNew) {
        renderSystem(`${user} се присъедини към чата`);
        renderPresence();
      }
      return;
    }

    if (data.type === 'leave') {
      if (peer) {
        state.peers.delete(from);
        renderSystem(`${peer.user || user} напусна чата`);
        renderPresence();
      }
      return;
    }

    if (data.type === 'beat') {
      const isNew = !peer;
      state.peers.set(from, { user, lastSeen: Date.now() });
      if (isNew) {
        renderSystem(`${user} се присъедини към чата`);
        renderPresence();
        publishEvent('hi');
      }
    }
  }

  function startTimers() {
    clearInterval(state.beatTimer);
    clearInterval(state.pruneTimer);

    state.beatTimer = setInterval(() => publishEvent('beat'), 12000);
    state.pruneTimer = setInterval(() => {
      const cutoff = Date.now() - PEER_TIMEOUT;
      let changed = false;

      for (const [id, peer] of state.peers) {
        if (peer.lastSeen < cutoff) {
          state.peers.delete(id);
          renderSystem(`${peer.user} напусна чата`);
          changed = true;
        }
      }

      if (changed) renderPresence();
    }, 15000);
  }

  function connect() {
    disconnect();
    state.peers.clear();
    state.hadTrouble = false;
    state.topic = `puls/chat/v1/${state.room}`;

    if (!window.mqtt) {
      showToast('Чат библиотеката не се зареди. Провери интернет връзката и презареди.');
      els.chatScreen.hidden = true;
      els.joinScreen.hidden = false;
      return;
    }

    renderPresence();

    const client = mqtt.connect(BROKER_URL, {
      clientId: CLIENT_ID,
      clean: true,
      keepalive: 20,
      reconnectPeriod: 3000,
      connectTimeout: 12000,
      will: {
        topic: state.topic,
        payload: JSON.stringify({
          v: 1,
          type: 'leave',
          from: CLIENT_ID,
          user: state.user,
          time: Date.now(),
        }),
        qos: 0,
        retain: false,
      },
    });

    state.client = client;

    client.on('connect', () => {
      state.hadTrouble = false;
      client.subscribe(state.topic, { qos: 0 }, (error) => {
        if (!error) publishEvent('join');
      });
      renderPresence();
    });

    client.on('message', handleIncoming);
    client.on('reconnect', renderPresence);
    client.on('close', renderPresence);
    client.on('offline', () => {
      state.hadTrouble = true;
      renderPresence();
    });
    client.on('error', () => {
      state.hadTrouble = true;
      renderPresence();
    });

    startTimers();
  }

  function disconnect() {
    clearInterval(state.beatTimer);
    clearInterval(state.pruneTimer);
    state.beatTimer = null;
    state.pruneTimer = null;

    const client = state.client;
    state.client = null;
    if (!client) return;

    try {
      if (client.connected) {
        client.publish(state.topic, JSON.stringify({
          v: 1,
          type: 'leave',
          from: CLIENT_ID,
          user: state.user,
          time: Date.now(),
        }), { qos: 0 });
      }
      client.end();
    } catch {
      /* вече е затворен */
    }
  }

  function startChat(name, room) {
    state.user = name;
    state.room = room;
    state.peers.clear();
    state.seen.clear();

    els.roomTitle.textContent = `#${room}`;
    els.roomAvatar.textContent = [...room][0]?.toLocaleUpperCase('bg-BG') || '#';
    els.emptyRoomCode.textContent = room;

    resetMessages();
    els.typingIndicator.hidden = true;
    renderHistory();

    els.joinScreen.hidden = true;
    els.chatScreen.hidden = false;

    try {
      history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(room)}`);
    } catch {
      /* историята на браузъра не е достъпна */
    }

    connect();
    setTimeout(() => els.messageInput.focus(), 60);
  }

  function leaveChat() {
    const lastRoom = state.room;
    disconnect();
    state.user = '';
    state.room = '';
    state.topic = '';
    state.peers.clear();
    state.seen.clear();
    resetMessages();
    els.typingIndicator.hidden = true;
    els.messageInput.value = '';
    autoGrow();

    els.chatScreen.hidden = true;
    els.joinScreen.hidden = false;
    els.nameInput.value = remember.read('puls.name');
    els.roomInput.value = lastRoom || randomRoom();
    els.nameInput.focus();
  }

  function autoGrow() {
    els.messageInput.style.height = 'auto';
    els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, 132)}px`;
  }

  function sendTypingPing() {
    if (!state.client || !state.client.connected) return;
    const now = Date.now();
    if (now - state.lastTypingSent < 1300) return;
    state.lastTypingSent = now;
    publishEvent('typing');
  }

  function sendMessage() {
    const text = els.messageInput.value.trim().slice(0, 2000);
    if (!text) return;

    const message = { id: makeId(), user: state.user, text, time: Date.now() };

    if (!publishEvent('msg', message)) {
      showToast('Няма връзка в момента — опитай след малко.');
      return;
    }

    els.messageInput.value = '';
    autoGrow();
    state.lastTypingSent = 0;
    renderMessage(message);
    saveMessage(message);
    els.messageInput.focus();
  }

  async function copyInvite() {
    const isFile = location.protocol === 'file:';
    const payload = isFile
      ? state.room
      : `${location.origin}${location.pathname}?room=${encodeURIComponent(state.room)}`;
    const successText = isFile
      ? 'Кодът е копиран — сподели го с приятел.'
      : 'Поканата е копирана — изпрати я на приятел.';

    try {
      await navigator.clipboard.writeText(payload);
      showToast(successText);
      return;
    } catch {
      /* опитваме резервен начин */
    }

    const helper = document.createElement('textarea');
    helper.value = payload;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();

    try {
      document.execCommand('copy');
      showToast(successText);
    } catch {
      showToast(`Код на стаята: ${state.room}`);
    }

    helper.remove();
  }

  els.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const name = els.nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 24);
    const room = sanitizeRoom(els.roomInput.value);
    els.joinError.hidden = true;

    if (!name) {
      els.joinError.textContent = 'Моля, въведи име.';
      els.joinError.hidden = false;
      els.nameInput.focus();
      return;
    }
    if (!room) {
      els.joinError.textContent = 'Моля, въведи код на стаята.';
      els.joinError.hidden = false;
      els.roomInput.focus();
      return;
    }

    els.roomInput.value = room;
    remember.write('puls.name', name);
    remember.write('puls.room', room);
    startChat(name, room);
  });

  els.randomRoom.addEventListener('click', () => {
    els.roomInput.value = randomRoom();
    els.roomInput.focus();
  });

  els.sendBtn.addEventListener('click', sendMessage);

  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  els.messageInput.addEventListener('input', () => {
    autoGrow();
    if (els.messageInput.value.trim()) sendTypingPing();
  });

  els.copyRoom.addEventListener('click', copyInvite);
  els.leaveBtn.addEventListener('click', leaveChat);

  window.addEventListener('pagehide', () => {
    const client = state.client;
    state.client = null;
    if (!client) return;
    try {
      client.end(true);
    } catch {
      /* вече е затворен */
    }
  });

  const inviteRoom = sanitizeRoom(new URLSearchParams(location.search).get('room') || '');
  els.nameInput.value = remember.read('puls.name');
  els.roomInput.value = inviteRoom || remember.read('puls.room') || randomRoom();
  autoGrow();
  els.nameInput.focus();
})();
