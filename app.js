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

// 設定モーダル
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const apiEndpointInput = document.getElementById('api-endpoint');
const apiSecretInput = document.getElementById('api-secret');

// 状態管理
let currentImageBase64 = null;
let isRecording = false;
let recognition = null;

// 設定のロード & URLパラメータ自動適用
function loadSettings() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('endpoint')) localStorage.setItem('gemini_api_endpoint', params.get('endpoint'));
  if (params.get('secret')) localStorage.setItem('gemini_api_secret', params.get('secret'));

  apiEndpointInput.value = localStorage.getItem('gemini_api_endpoint') || '';
  apiSecretInput.value = localStorage.getItem('gemini_api_secret') || '';
}

function saveSettings() {
  localStorage.setItem('gemini_api_endpoint', apiEndpointInput.value.trim());
  localStorage.setItem('gemini_api_secret', apiSecretInput.value.trim());
  settingsModal.hidden = true;
  alert('設定を保存しました！');
}

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
  };
  reader.readAsDataURL(file);
});

clearImageBtn.addEventListener('click', () => {
  currentImageBase64 = null;
  imageUpload.value = '';
  imagePreviewBar.hidden = true;
});

// 音声認識 (Web Speech API)
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

// メッセージ送信処理
async function sendMessage() {
  const text = userInput.value.trim();
  const image = currentImageBase64;

  if (!text && !image) return;

  const endpoint = localStorage.getItem('gemini_api_endpoint');
  const secret = localStorage.getItem('gemini_api_secret');

  if (!endpoint) {
    settingsModal.hidden = false;
    alert('右上の⚙️マークから、見守りサーバー（Google Apps Script）のURLを設定してください。');
    return;
  }

  // 画面にユーザーメッセージを描画
  renderUserMessage(text, image);

  // 入力リセット
  userInput.value = '';
  userInput.style.height = 'auto';
  clearImageBtn.click();
  stopRecognition();

  // ローディング吹き出しを描画
  const loadingBubble = renderLoadingMessage();

  try {
    const payload = {
      secret: secret,
      question: text,
      image: image,
      source: 'iphone_pwa',
      timestamp: new Date().toISOString()
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GAS CORS対策でtext/plain
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    loadingBubble.remove();

    if (data.ok) {
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

// メッセージ描画ヘルパー
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

function renderAssistantMessage(text, risk = 0, koseiReply = null) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant' + (risk >= 60 ? ' risk-alert' : '');

  let inner = '<div class="msg-bubble">';
  if (risk >= 60) {
    inner += '<span class="risk-tag">⚠️ 危険な可能性があります</span>';
  }
  inner += `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;

  // 洸晟からの直接メッセージ/補足がある場合
  if (koseiReply) {
    inner += `
      <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed #dadce0;">
        <span class="kosei-tag">💡 孫（洸晟）からのメッセージ</span>
        <p style="font-weight: 500;">${escapeHtml(koseiReply).replace(/\n/g, '<br>')}</p>
      </div>
    `;
  }

  inner += '</div>';
  msgDiv.innerHTML = inner;
  chatMessages.appendChild(msgDiv);
  scrollToBottom();
}

function renderLoadingMessage() {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant';
  msgDiv.innerHTML = `
    <div class="msg-bubble" style="color: #70757a;">
      <span class="pulse-dot" style="width: 10px; height: 10px; background: #1a73e8;"></span>
      考えています…
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

// イベントリスナー
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
