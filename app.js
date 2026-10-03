// Service Worker 登録 (PWA)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration failed:', err));
}

// DOM要素
const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const micBtn = document.getElementById('mic-btn');
const imageUpload = document.getElementById('image-upload');
const imagePreviewBar = document.getElementById('image-preview-bar');
const previewImg = document.getElementById('preview-img');
const clearImageBtn = document.getElementById('clear-image-btn');
const voiceStatusBar = document.getElementById('voice-status-bar');
const voiceStatusText = document.getElementById('voice-status-text');
const stopVoiceBtn = document.getElementById('stop-voice-btn');
const callBtn = document.getElementById('call-btn');
const welcomeCallHint = document.getElementById('welcome-call-hint');
const quickChips = document.querySelectorAll('.quick-chip');

// 設定モーダル
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const apiEndpointInput = document.getElementById('api-endpoint');
const apiSecretInput = document.getElementById('api-secret');
const koseiTelInput = document.getElementById('kosei-tel');

// 危険度しきい値（バックエンド NOTIFY_AT と同じ）
const RISK_ALERT_AT = 60;

// 状態管理
let currentImageBase64 = null;
let currentMode = 'chat'; // 'chat' | 'ad_check'
let isRecording = false;
let recognition = null;
let lastUserText = '';

// ---------- 設定 ----------

// 設定のロード & URLパラメータ自動適用
function loadSettings() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('endpoint')) localStorage.setItem('gemini_api_endpoint', params.get('endpoint'));
  if (params.get('secret')) localStorage.setItem('gemini_api_secret', params.get('secret'));
  if (params.get('tel')) localStorage.setItem('kosei_tel', normalizeTel(params.get('tel')));

  apiEndpointInput.value = localStorage.getItem('gemini_api_endpoint') || '';
  apiSecretInput.value = localStorage.getItem('gemini_api_secret') || '';
  koseiTelInput.value = localStorage.getItem('kosei_tel') || '';
  updateCallButton();
}

function saveSettings() {
  localStorage.setItem('gemini_api_endpoint', apiEndpointInput.value.trim());
  localStorage.setItem('gemini_api_secret', apiSecretInput.value.trim());
  localStorage.setItem('kosei_tel', normalizeTel(koseiTelInput.value));
  updateCallButton();
  settingsModal.hidden = true;
  alert('設定を保存しました！');
}

function normalizeTel(raw) {
  return String(raw || '').replace(/[^\d+]/g, '');
}

function getKoseiTel() {
  return localStorage.getItem('kosei_tel') || '';
}

// 📞ボタンは電話番号が設定されているときだけ表示
function updateCallButton() {
  const tel = getKoseiTel();
  koseiTelInput.value = tel;
  if (tel) {
    callBtn.href = 'tel:' + tel;
    callBtn.hidden = false;
    welcomeCallHint.hidden = false;
  } else {
    callBtn.hidden = true;
    welcomeCallHint.hidden = true;
  }
}

// ---------- 入力まわり ----------

// 自動リサイズ textarea
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
});

// 画像添付ハンドラ
imageUpload.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    currentImageBase64 = event.target.result;
    previewImg.src = currentImageBase64;
    imagePreviewBar.hidden = false;
    // ワンタップ相談（詐欺広告チェック）中は、写真を選んだら自動で送信
    if (currentMode === 'ad_check') sendMessage();
  };
  reader.readAsDataURL(file);
});

clearImageBtn.addEventListener('click', () => {
  currentImageBase64 = null;
  imageUpload.value = '';
  imagePreviewBar.hidden = true;
});

// ワンタップ相談ボタン（詐欺広告チェックなど）
quickChips.forEach(chip => {
  chip.addEventListener('click', () => {
    currentMode = chip.dataset.mode || 'chat';
    userInput.value = chip.dataset.prompt || '';
    userInput.dispatchEvent(new Event('input'));
    quickChips.forEach(c => c.classList.toggle('active', c === chip));

    if (chip.dataset.photo) {
      // 写真（スクショ）を選んでもらう。選んだら自動送信。
      imageUpload.click();
    } else {
      sendMessage();
    }
  });
});

// ---------- 音声認識 (Web Speech API) ----------
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
    voiceStatusText.textContent = 'お話ししてください… 🎙️';
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

  recognition.onend = () => {
    stopRecognition();
  };
} else {
  micBtn.title = 'お使いのブラウザは音声認識に対応していません';
}

function startRecognition() {
  if (!recognition) {
    alert('マイク機能はお使いのブラウザに対応していません');
    return;
  }
  try {
    recognition.start();
  } catch (err) {
    console.warn(err);
  }
}

function stopRecognition() {
  isRecording = false;
  micBtn.classList.remove('recording');
  voiceStatusBar.hidden = true;
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
  }
}

micBtn.addEventListener('click', () => {
  if (isRecording) {
    stopRecognition();
  } else {
    startRecognition();
  }
});

stopVoiceBtn.addEventListener('click', stopRecognition);

// ---------- 読み上げ (おばあちゃん向け) ----------
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[⚠️🚨📞🆘💡]/g, ''));
    u.lang = 'ja-JP';
    u.rate = 0.9;
    window.speechSynthesis.speak(u);
  } catch (_) {}
}

// ---------- 通信 ----------

function getConnection() {
  const endpoint = localStorage.getItem('gemini_api_endpoint');
  const secret = localStorage.getItem('gemini_api_secret');
  if (!endpoint) {
    settingsModal.hidden = false;
    alert('右上の⚙️マークから、見守りサーバー（Google Apps Script）のURLを設定してください。');
    return null;
  }
  return { endpoint, secret };
}

async function postToBackend(conn, payload) {
  const res = await fetch(conn.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GAS CORS対策でtext/plain
    body: JSON.stringify(Object.assign({ secret: conn.secret, source: 'iphone_pwa', timestamp: new Date().toISOString() }, payload))
  });
  return res.json();
}

// メッセージ送信処理
async function sendMessage() {
  const text = userInput.value.trim();
  const image = currentImageBase64;
  const mode = currentMode;

  if (!text && !image) return;

  const conn = getConnection();
  if (!conn) return;

  // 画面にユーザーメッセージを描画
  renderUserMessage(text, image);
  lastUserText = text;

  // 入力リセット
  userInput.value = '';
  userInput.style.height = 'auto';
  clearImageBtn.click();
  stopRecognition();
  currentMode = 'chat';
  quickChips.forEach(c => c.classList.remove('active'));

  // ローディング吹き出しを描画
  const loadingBubble = renderLoadingMessage();

  try {
    const data = await postToBackend(conn, { question: text, image: image, mode: mode });
    loadingBubble.remove();

    if (data.ok) {
      // GAS側から洸晟の電話番号が届いたら保存（設定の手間を減らす）
      if (data.kosei_tel && !getKoseiTel()) {
        localStorage.setItem('kosei_tel', normalizeTel(data.kosei_tel));
        updateCallButton();
      }
      renderAssistantMessage(data.answer, data.risk, data.kosei_reply);
    } else {
      renderAssistantMessage('申し訳ありません。うまく聞き取れませんでした。もう一度お話ししてみてください。', 0);
    }
  } catch (err) {
    console.error('Send error:', err);
    loadingBubble.remove();
    renderAssistantMessage('通信がうまくつながりませんでした。電波のよいところで、もう一度お話ししてみてください。', 0);
  }
}

// 🆘 洸晟へ即時通報（Geminiを通さず、Discord/メールに直送）
async function sendSOS(contextText) {
  if (!confirm('洸晟にすぐ知らせますか？')) return;
  const conn = getConnection();
  if (!conn) return;

  const loadingBubble = renderLoadingMessage('洸晟に知らせています…');
  try {
    const data = await postToBackend(conn, { type: 'sos', question: contextText || '' });
    loadingBubble.remove();
    if (data.ok) {
      renderAssistantMessage(data.answer || '洸晟に知らせました。すぐ連絡が来るので、何もせずに待っていてね。', 0, null, { sos: true });
    } else {
      renderAssistantMessage('うまく知らせられませんでした。右上の📞から洸晟に電話してね。', 0);
    }
  } catch (err) {
    console.error('SOS error:', err);
    loadingBubble.remove();
    renderAssistantMessage('うまく知らせられませんでした。右上の📞から洸晟に電話してね。', 0);
  }
}

// ---------- メッセージ描画ヘルパー ----------
function renderUserMessage(text, imageSrc) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message user';

  let inner = '<div class="msg-bubble">';
  if (imageSrc) {
    inner += `<img src="${imageSrc}" class="msg-image" alt="質問画像">`;
  }
  if (text) {
    inner += `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  }
  inner += '</div>';

  msgDiv.innerHTML = inner;
  chatMessages.appendChild(msgDiv);
  scrollToBottom();
}

function renderAssistantMessage(text, risk = 0, koseiReply = null, opts = {}) {
  const isRisk = risk >= RISK_ALERT_AT;
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant' + (isRisk ? ' risk-alert' : '') + (opts.sos ? ' sos-done' : '');

  let inner = '<div class="msg-bubble">';
  if (isRisk) {
    inner += '<span class="risk-tag">⚠️ 危険な可能性があります</span>';
  }
  if (opts.sos) {
    inner += '<span class="kosei-tag">🆘 洸晟に知らせました</span>';
  }
  inner += `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;

  // 洸晟からの直接メッセージ/補足がある場合
  if (koseiReply) {
    inner += `
      <div class="kosei-box">
        <span class="kosei-tag">💡 孫（洸晟）からのメッセージ</span>
        <p style="font-weight: 500;">${escapeHtml(koseiReply).replace(/\n/g, '<br>')}</p>
      </div>
    `;
  }

  // 危険時は特大の「電話」「知らせる」ボタンを出す
  if (isRisk) {
    const tel = getKoseiTel();
    inner += '<div class="alert-actions">';
    if (tel) {
      inner += `<a class="big-call-btn" href="tel:${escapeHtml(tel)}">📞 洸晟に電話する</a>`;
    }
    inner += '<button class="big-sos-btn" type="button">🆘 洸晟にすぐ知らせる</button>';
    inner += '</div>';
  }

  inner += '<button class="speak-btn" type="button" aria-label="読み上げ">🔊 読んで</button>';
  inner += '</div>';
  msgDiv.innerHTML = inner;

  const sosBtn = msgDiv.querySelector('.big-sos-btn');
  if (sosBtn) sosBtn.addEventListener('click', () => sendSOS(lastUserText));
  const speakBtn = msgDiv.querySelector('.speak-btn');
  if (speakBtn) speakBtn.addEventListener('click', () => speak(text));

  chatMessages.appendChild(msgDiv);
  scrollToBottom();

  if (isRisk && navigator.vibrate) {
    try { navigator.vibrate([200, 100, 200]); } catch (_) {}
  }
}

function renderLoadingMessage(label = '考えています…') {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant';
  msgDiv.innerHTML = `
    <div class="msg-bubble" style="color: #70757a;">
      <span class="pulse-dot" style="width: 10px; height: 10px; background: #1a73e8;"></span>
      ${escapeHtml(label)}
    </div>
  `;
  chatMessages.appendChild(msgDiv);
  scrollToBottom();
  return msgDiv;
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- イベントリスナー ----------
sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

settingsBtn.addEventListener('click', () => { settingsModal.hidden = false; });
closeSettingsBtn.addEventListener('click', () => { settingsModal.hidden = true; });
saveSettingsBtn.addEventListener('click', saveSettings);

// 初期化
loadSettings();
