// Service Worker 登録 (PWA)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration failed:', err));
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const chatEl = $('chat-messages');
const welcomeEl = $('welcome');
const userInput = $('user-input');
const sendBtn = $('send-btn');
const micBtn = $('mic-btn');
const imageUpload = $('image-upload');
const imagePreviewBar = $('image-preview-bar');
const previewImg = $('preview-img');
const clearImageBtn = $('clear-image-btn');
const voiceStatusBar = $('voice-status-bar');
const voiceStatusText = $('voice-status-text');
const stopVoiceBtn = $('stop-voice-btn');
const composerBox = $('composer-box');
const callBtnSide = $('call-btn-side');
const sidebar = $('sidebar');
const sidebarOverlay = $('sidebar-overlay');
const menuBtn = $('menu-btn');
const sidebarCloseBtn = $('sidebar-close-btn');
const newChatBtn = $('new-chat-btn');
const chatListEl = $('chat-list');
const settingsBtn = $('settings-btn');
const settingsModal = $('settings-modal');
const closeSettingsBtn = $('close-settings-btn');
const saveSettingsBtn = $('save-settings-btn');
const clearChatsBtn = $('clear-chats-btn');
const apiEndpointInput = $('api-endpoint');
const apiSecretInput = $('api-secret');
const koseiTelInput = $('kosei-tel');
const quickButtons = document.querySelectorAll('[data-prompt]');

// 危険度しきい値（バックエンド NOTIFY_AT と同じ）
const RISK_ALERT_AT = 60;
const HISTORY_TURNS = 8;      // Gemini に渡す直近のやり取り数
const POLL_EVERY_MS = 5000;   // 打ち切られた答えを取りに行く間隔
const POLL_MAX_MS = 4 * 60 * 1000; // 取りに行くのをやめるまで（GASの答えは10分取っておく）
const MAX_CHATS = 50;         // 端末に保存するチャット数
const IMAGE_MAX_PX = 1280;    // 送信前に縮小する最大辺

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
let chats = [];               // [{id, title, updated, messages:[{role:'user'|'model', text, hasImage, risk, kosei_reply, sos}]}]
let currentChatId = null;
let currentImageBase64 = null;
let currentMode = 'chat';     // 'chat' | 'ad_check'
let isRecording = false;
let recognition = null;
let busy = false;

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
function loadSettings() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('endpoint')) localStorage.setItem('gemini_api_endpoint', params.get('endpoint'));
  if (params.get('secret')) localStorage.setItem('gemini_api_secret', params.get('secret'));
  if (params.get('tel')) localStorage.setItem('kosei_tel', normalizeTel(params.get('tel')));
  if (params.toString() && window.history.replaceState) {
    // 合言葉をURLに残さない
    window.history.replaceState({}, '', window.location.pathname);
  }

  apiEndpointInput.value = localStorage.getItem('gemini_api_endpoint') || '';
  apiSecretInput.value = localStorage.getItem('gemini_api_secret') || '';
  updateCallButton();
}

function saveSettings() {
  localStorage.setItem('gemini_api_endpoint', apiEndpointInput.value.trim());
  localStorage.setItem('gemini_api_secret', apiSecretInput.value.trim());
  localStorage.setItem('kosei_tel', normalizeTel(koseiTelInput.value));
  updateCallButton();
  settingsModal.hidden = true;
}

/**
 * 洸晟から届いた設定リンク（?endpoint=...&secret=...&tel=...）を貼り付けて設定する。
 * iPhoneはホーム画面のアプリとSafariで保存場所が分かれるため、リンクを開くだけでは設定が引き継がれない。
 */
function applySetupText(text) {
  const status = $('setup-paste-status');
  const m = String(text || '').match(/https?:\/\/\S+/);
  let params = null;
  try { params = m ? new URL(m[0]).searchParams : null; } catch (_) {}
  if (!params || !params.get('endpoint') || !params.get('secret')) {
    status.textContent = '設定のリンクが見つかりませんでした。洸晟から届いたリンクをコピーしてから、もう一度押してください。';
    status.className = 'setup-paste-status ng';
    status.hidden = false;
    return false;
  }
  localStorage.setItem('gemini_api_endpoint', params.get('endpoint'));
  localStorage.setItem('gemini_api_secret', params.get('secret'));
  if (params.get('tel')) localStorage.setItem('kosei_tel', normalizeTel(params.get('tel')));
  apiEndpointInput.value = params.get('endpoint');
  apiSecretInput.value = params.get('secret');
  updateCallButton();
  $('setup-paste-area').value = '';
  status.textContent = '✅ 設定できました。このまま質問できます。';
  status.className = 'setup-paste-status ok';
  status.hidden = false;
  setTimeout(() => { settingsModal.hidden = true; status.hidden = true; }, 1500);
  return true;
}

async function pasteSetupFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    applySetupText(text);
  } catch (_) {
    // クリップボードを読めない端末では、下の欄に長押しで貼ってもらう
    const status = $('setup-paste-status');
    status.textContent = '下の欄を長押しして「ペースト」を押してください。';
    status.className = 'setup-paste-status ng';
    status.hidden = false;
    $('setup-paste-area').focus();
  }
}

function normalizeTel(raw) {
  return String(raw || '').replace(/[^\d+]/g, '');
}

function getKoseiTel() {
  return localStorage.getItem('kosei_tel') || '';
}

function updateCallButton() {
  const tel = getKoseiTel();
  koseiTelInput.value = tel;
  [callBtnSide].forEach(btn => {
    if (tel) {
      btn.href = 'tel:' + tel;
      btn.hidden = false;
    } else {
      btn.hidden = true;
    }
  });
}

// ---------------------------------------------------------------------------
// チャット履歴（端末内に保存）
// ---------------------------------------------------------------------------
function loadChats() {
  try {
    chats = JSON.parse(localStorage.getItem('gemini_chats') || '[]');
    if (!Array.isArray(chats)) chats = [];
  } catch (_) {
    chats = [];
  }
}

function saveChats() {
  chats.sort((a, b) => b.updated - a.updated);
  if (chats.length > MAX_CHATS) chats = chats.slice(0, MAX_CHATS);
  try {
    localStorage.setItem('gemini_chats', JSON.stringify(chats));
  } catch (e) {
    console.warn('保存容量を超えたため古いチャットを削除します', e);
    chats = chats.slice(0, Math.max(1, Math.floor(chats.length / 2)));
    try { localStorage.setItem('gemini_chats', JSON.stringify(chats)); } catch (_) {}
  }
}

function currentChat() {
  return chats.find(c => c.id === currentChatId) || null;
}

function newChat() {
  currentChatId = null;
  renderChat();
  renderChatList();
  closeSidebar();
  userInput.focus();
}

function ensureChat(firstText) {
  let chat = currentChat();
  if (chat) return chat;
  chat = {
    id: 'c' + Date.now().toString(36),
    title: (firstText || '写真の相談').slice(0, 30),
    updated: Date.now(),
    messages: []
  };
  chats.unshift(chat);
  currentChatId = chat.id;
  return chat;
}

function openChat(id) {
  currentChatId = id;
  renderChat();
  renderChatList();
  closeSidebar();
}

function deleteChat(id) {
  if (!confirm('このチャットを消しますか？')) return;
  chats = chats.filter(c => c.id !== id);
  saveChats();
  if (currentChatId === id) currentChatId = null;
  renderChat();
  renderChatList();
}

function addMessage(msg) {
  const chat = ensureChat(msg.role === 'user' ? msg.text : '');
  chat.messages.push(msg);
  chat.updated = Date.now();
  saveChats();
  renderChatList();
  return msg;
}

function renderChatList() {
  chatListEl.innerHTML = '';
  if (!chats.length) {
    const p = document.createElement('p');
    p.className = 'chat-list-empty';
    p.textContent = 'まだチャットはありません';
    chatListEl.appendChild(p);
    return;
  }
  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = chat.title || '無題';
    const del = document.createElement('button');
    del.className = 'chat-del';
    del.textContent = '✕';
    del.title = 'このチャットを消す';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(chat.id); });
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener('click', () => openChat(chat.id));
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') openChat(chat.id); });
    chatListEl.appendChild(item);
  });
}

// 会話全体を描き直す
function renderChat() {
  const chat = currentChat();
  chatEl.querySelectorAll('.chat-inner').forEach(el => el.remove());
  if (!chat || !chat.messages.length) {
    welcomeEl.hidden = false;
    return;
  }
  welcomeEl.hidden = true;
  const inner = getChatInner();
  chat.messages.forEach(m => {
    if (m.role === 'user') inner.appendChild(buildUserMessage(m.text, m.image || null, m.hasImage));
    else inner.appendChild(buildModelMessage(m));
  });
  scrollToBottom();
}

function getChatInner() {
  let inner = chatEl.querySelector('.chat-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'chat-inner';
    chatEl.appendChild(inner);
  }
  welcomeEl.hidden = true;
  return inner;
}

// ---------------------------------------------------------------------------
// サイドバー
// ---------------------------------------------------------------------------
function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.hidden = false;
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.hidden = true;
}

menuBtn.addEventListener('click', openSidebar);
sidebarCloseBtn.addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);
newChatBtn.addEventListener('click', newChat);

// ---------------------------------------------------------------------------
// 入力まわり
// ---------------------------------------------------------------------------
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
});

// 画像を取り込む（ファイル選択・貼り付け・ドロップ共通）。送信前に縮小する。
function attachImageFile(file, autoSend) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    downscaleImage(event.target.result, (dataUrl) => {
      currentImageBase64 = dataUrl;
      previewImg.src = dataUrl;
      imagePreviewBar.hidden = false;
      if (autoSend) sendMessage();
    });
  };
  reader.readAsDataURL(file);
}

function downscaleImage(dataUrl, cb) {
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, IMAGE_MAX_PX / Math.max(img.width, img.height));
    if (scale >= 1 && dataUrl.length < 1.5 * 1024 * 1024) return cb(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    cb(canvas.toDataURL('image/jpeg', 0.85));
  };
  img.onerror = () => cb(dataUrl);
  img.src = dataUrl;
}

imageUpload.addEventListener('change', (e) => {
  attachImageFile(e.target.files[0], currentMode === 'ad_check');
});

clearImageBtn.addEventListener('click', () => {
  currentImageBase64 = null;
  imageUpload.value = '';
  imagePreviewBar.hidden = true;
});

// パソコン: クリップボードから画像を貼り付け
document.addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      attachImageFile(item.getAsFile(), false);
      userInput.focus();
      return;
    }
  }
});

// パソコン: ドラッグ＆ドロップ
['dragenter', 'dragover'].forEach(ev => composerBox.addEventListener(ev, (e) => {
  e.preventDefault();
  composerBox.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => composerBox.addEventListener(ev, (e) => {
  e.preventDefault();
  composerBox.classList.remove('dragover');
}));
composerBox.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  attachImageFile(file, false);
});

// ワンタップ相談（初期画面のカード／入力欄上のチップ）
quickButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode || 'chat';
    userInput.value = btn.dataset.prompt || '';
    userInput.dispatchEvent(new Event('input'));
    if (currentImageBase64) {
      sendMessage();
    } else {
      userInput.focus();
      try {
        userInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
    }
  });
});

// ---------------------------------------------------------------------------
// 音声認識
// ---------------------------------------------------------------------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('recording');
    voiceStatusBar.hidden = false;
    voiceStatusText.textContent = 'お話しください…';
  };
  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      transcript += event.results[i][0].transcript;
    }
    if (transcript) {
      userInput.value = transcript;
      userInput.dispatchEvent(new Event('input'));
    }
  };
  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    stopRecognition();
  };
  recognition.onend = stopRecognition;
} else {
  micBtn.title = 'このブラウザは音声入力に対応していません';
}

function startRecognition() {
  if (!recognition) {
    alert('このブラウザは音声入力に対応していません。文字で入力してください。');
    return;
  }
  try { recognition.start(); } catch (err) { console.warn(err); }
}

function stopRecognition() {
  isRecording = false;
  micBtn.classList.remove('recording');
  voiceStatusBar.hidden = true;
  if (recognition) { try { recognition.stop(); } catch (_) {} }
}

micBtn.addEventListener('click', () => isRecording ? stopRecognition() : startRecognition());
stopVoiceBtn.addEventListener('click', stopRecognition);

// 読み上げ
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[⚠️🚨📞🆘💡🟡🟢]/g, ''));
    u.lang = 'ja-JP';
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 通信
// ---------------------------------------------------------------------------
function getConnection() {
  const endpoint = localStorage.getItem('gemini_api_endpoint');
  const secret = localStorage.getItem('gemini_api_secret');
  if (!endpoint) {
    settingsModal.hidden = false;
    return null;
  }
  return { endpoint, secret };
}

function newRequestId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// 打ち切られた質問の答えを、GASが作り終えるまで取りに行く（最大4分）
async function waitForAnswer(conn, rid) {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_EVERY_MS));
    try {
      const data = await postToBackend(conn, { type: 'poll', rid: rid });
      if (data && data.ok) return data;
    } catch (e) {
      console.warn('poll error:', e);
    }
  }
  return null;
}

async function postToBackend(conn, payload) {
  const res = await fetch(conn.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GAS CORS対策でtext/plain
    body: JSON.stringify(Object.assign({
      secret: conn.secret,
      source: isDesktop() ? 'pc_web' : 'iphone_pwa',
      timestamp: new Date().toISOString()
    }, payload))
  });
  return res.json();
}

function isDesktop() {
  return window.matchMedia('(min-width: 900px)').matches;
}

// Gemini に渡す直近の会話（文字のみ）
function buildHistory() {
  const chat = currentChat();
  if (!chat) return [];
  return chat.messages
    .filter(m => m.text && !m.sos)
    .slice(-HISTORY_TURNS * 2)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'model', text: String(m.text).slice(0, 1500) }));
}

async function sendMessage() {
  if (busy) return;
  const text = userInput.value.trim();
  const image = currentImageBase64;
  if (!text && !image) return;
  // 写真つきは詐欺広告チェックモードで判定する（サジェストなしでも判定が出るように）
  const mode = image ? 'ad_check' : currentMode;

  const conn = getConnection();
  if (!conn) return;

  const history = buildHistory();

  // 画面に描画 ＆ 保存（画像は保存容量のため本文には残さない）
  const inner = getChatInner();
  inner.appendChild(buildUserMessage(text, image, !!image));
  addMessage({ role: 'user', text: text, hasImage: !!image, mode: mode });
  scrollToBottom();

  userInput.value = '';
  userInput.style.height = 'auto';
  clearImageBtn.click();
  stopRecognition();
  currentMode = 'chat';

  busy = true;
  sendBtn.disabled = true;
  const loading = buildLoading();
  inner.appendChild(loading);
  scrollToBottom();

  const rid = newRequestId();
  try {
    let data;
    try {
      data = await postToBackend(conn, { question: text, image: image, mode: mode, history: history, rid: rid });
    } catch (firstErr) {
      // Geminiが混んでいるとGASが1分を超え、iPhoneが先に通信を打ち切る。GASは答えを作り続けるので取りに行く
      console.warn('Send error, waiting for answer:', firstErr);
      setLoadingLabel(loading, 'お返事を待っています…');
      data = await waitForAnswer(conn, rid);
      if (!data) throw firstErr;
    }
    loading.remove();
    if (data.ok) {
      if (data.kosei_tel && !getKoseiTel()) {
        localStorage.setItem('kosei_tel', normalizeTel(data.kosei_tel));
        updateCallButton();
      }
      const msg = addMessage({ role: 'model', text: data.answer, risk: data.risk || 0, kosei_reply: data.kosei_reply || null });
      inner.appendChild(buildModelMessage(msg));
    } else {
      const msg = addMessage({ role: 'model', text: 'うまく受け取れませんでした。もう一度お試しください。', risk: 0 });
      inner.appendChild(buildModelMessage(msg));
    }
  } catch (err) {
    console.error('Send error:', err);
    loading.remove();
    const msg = addMessage({ role: 'model', text: 'お返事を受け取れませんでした。エラーが出ました。少し待ってからもう一度お試しください。\nそれでもだめなときは、洸晟に連絡してください。', risk: 0 });
    inner.appendChild(buildModelMessage(msg));
  } finally {
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }
}

// 洸晟へ即時通報（Gemini を通さず Discord / メールへ）
async function sendSOS() {
  if (!confirm('洸晟にすぐ知らせますか？')) return;
  const conn = getConnection();
  if (!conn) return;

  const chat = currentChat();
  const lastUser = chat ? [...chat.messages].reverse().find(m => m.role === 'user') : null;
  const inner = getChatInner();
  const loading = buildLoading('洸晟に知らせています…');
  inner.appendChild(loading);
  scrollToBottom();

  try {
    const data = await postToBackend(conn, { type: 'sos', question: lastUser ? lastUser.text : '' });
    loading.remove();
    const msg = addMessage({
      role: 'model',
      text: data.ok ? (data.answer || '洸晟に知らせました。連絡が来るまで、何もせずにお待ちください。') : '知らせることができませんでした。📞 ボタンから電話してください。',
      risk: 0,
      sos: data.ok
    });
    inner.appendChild(buildModelMessage(msg));
  } catch (err) {
    console.error('SOS error:', err);
    loading.remove();
    const msg = addMessage({ role: 'model', text: '知らせることができませんでした。📞 ボタンから電話してください。', risk: 0 });
    inner.appendChild(buildModelMessage(msg));
  } finally {
    scrollToBottom();
  }
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------
function buildUserMessage(text, imageSrc, hasImage) {
  const div = document.createElement('div');
  div.className = 'message user';
  let inner = '<div class="msg-body">';
  if (imageSrc) inner += `<img src="${imageSrc}" class="msg-image" alt="添付画像">`;
  else if (hasImage) inner += '<p class="msg-image-note">📷 写真を送りました</p>';
  if (text) inner += `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  inner += '</div>';
  div.innerHTML = inner;
  return div;
}

function buildModelMessage(m) {
  const isRisk = (m.risk || 0) >= RISK_ALERT_AT;
  const div = document.createElement('div');
  div.className = 'message model';

  let body = `<img src="assets/icon.svg" class="avatar" alt="">`;
  body += `<div class="msg-body${isRisk ? ' risk' : ''}${m.sos ? ' sos-done' : ''}">`;
  body += '<div class="msg-card">';
  if (isRisk) body += '<span class="tag danger">⚠️ 注意が必要です</span>';
  if (m.sos) body += '<span class="tag safe">🆘 洸晟に知らせました</span>';
  body += `<p>${escapeHtml(m.text).replace(/\n/g, '<br>')}</p>`;

  if (m.kosei_reply) {
    body += `<div class="kosei-box"><span class="tag safe">洸晟からのメッセージ</span><p>${escapeHtml(m.kosei_reply).replace(/\n/g, '<br>')}</p></div>`;
  }

  if (isRisk) {
    const tel = getKoseiTel();
    body += '<div class="alert-actions">';
    if (tel) body += `<a class="big-call-btn" href="tel:${escapeHtml(tel)}">📞 洸晟に電話する</a>`;
    body += '<button class="big-sos-btn" type="button">🆘 洸晟にすぐ知らせる</button>';
    body += '</div>';
  }
  body += '</div>'; // msg-card
  body += '<div class="msg-tools"><button class="speak-btn" type="button">🔊 読み上げ</button></div>';
  body += '</div>';
  div.innerHTML = body;

  const sosBtn = div.querySelector('.big-sos-btn');
  if (sosBtn) sosBtn.addEventListener('click', sendSOS);
  div.querySelector('.speak-btn').addEventListener('click', () => speak(m.text));

  if (isRisk && navigator.vibrate) {
    try { navigator.vibrate([200, 100, 200]); } catch (_) {}
  }
  return div;
}

function buildLoading(label = '考えています…') {
  const div = document.createElement('div');
  div.className = 'message model';
  div.innerHTML = `<img src="assets/icon.svg" class="avatar" alt=""><div class="msg-body"><p class="loading-text">${escapeHtml(label)}</p></div>`;
  return div;
}

function setLoadingLabel(div, label) {
  const p = div.querySelector('.loading-text');
  if (p) p.textContent = label;
}

function scrollToBottom() {
  requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------
sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

settingsBtn.addEventListener('click', () => { settingsModal.hidden = false; closeSidebar(); });
closeSettingsBtn.addEventListener('click', () => { settingsModal.hidden = true; });
saveSettingsBtn.addEventListener('click', saveSettings);
$('paste-setup-btn').addEventListener('click', pasteSetupFromClipboard);
$('setup-paste-area').addEventListener('input', e => {
  if (/https?:\/\//.test(e.target.value)) applySetupText(e.target.value);
});
clearChatsBtn.addEventListener('click', () => {
  if (!confirm('この端末に保存されたチャット履歴をすべて消しますか？')) return;
  chats = [];
  currentChatId = null;
  saveChats();
  renderChat();
  renderChatList();
  settingsModal.hidden = true;
});

// ---------------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------------
loadSettings();
loadChats();
currentChatId = null; // 起動時は新しいチャットから（履歴はサイドバーから開ける）
renderChat();
renderChatList();
