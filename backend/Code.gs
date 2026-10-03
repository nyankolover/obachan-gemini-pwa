/**
 * おばあちゃん専用Gemini PWA バックエンド (Google Apps Script)
 * 
 * 機能：
 * 1. PWAアプリ（iPhone）からの質問（文字＋写真）を受信
 * 2. Gemini API で画像＋テキストを解析し、親切で安全な回答を生成
 * 3. 詐欺・危険操作の疑い（0〜100）をリアルタイム判定
 * 4. Discord #Claudenotice に即時アラート通知
 * 5. Googleスプレッドシート「おばあちゃん相談ログ」に全件自動保存
 * 
 * 設定手順（「プロジェクトの設定」→「スクリプト プロパティ」に入力）:
 *   SHARED_SECRET     … PWAアプリと共通の合言葉（英数字20文字以上）
 *   GEMINI_API_KEY    … Google AI Studio で取得したAPIキー
 *   DISCORD_BOT_TOKEN … Discord通知用Botトークン（またはDISCORD_WEBHOOK_URL）
 *   DISCORD_WEBHOOK_URL … Discord Webhook URL（Botトークンの代わりに使用可能）
 */

const CHANNEL_ID = '1526362180826562590'; // Discord #Claudenotice
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];
const NOTIFY_AT = 60; // 危険度60以上でDiscordに強力警告

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (_) {
    return jsonResponse_({ ok: false, error: 'Invalid JSON' });
  }

  // 合言葉チェック
  const secret = props.getProperty('SHARED_SECRET');
  if (secret && body.secret !== secret) {
    return jsonResponse_({ ok: false, error: 'Unauthorized' });
  }

  const question = String(body.question || '').slice(0, 3000);
  const imageBase64 = body.image || null; // DataURL (data:image/jpeg;base64,...)
  const source = body.source || 'unknown';

  if (!question && !imageBase64) {
    return jsonResponse_({ ok: false, error: 'Empty message' });
  }

  // 1. Gemini API による回答生成 ＆ 危険度判定
  const result = askGeminiWithSafety_(question, imageBase64, props);

  // 2. スプレッドシートに全件記録
  logToSheet_(props, question, imageBase64 ? 'あり' : 'なし', result);

  // 3. Discordへ通知
  notifyDiscord_(props, question, imageBase64, result);

  // 4. アプリへ返答
  return jsonResponse_({
    ok: true,
    answer: result.answer,
    risk: result.risk,
    category: result.category,
    kosei_reply: result.kosei_reply || null
  });
}

/**
 * Gemini API で回答生成とセキュリティ判定を同時に行う
 */
function askGeminiWithSafety_(q, imageBase64, props) {
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) {
    return {
      answer: '現在設定を準備中です。孫の洸晟に設定を確認してもらってくださいね。',
      risk: 0,
      category: '設定未完了',
      reason: 'APIキー未設定'
    };
  }

  const systemInstruction = 
    'あなたは高齢の祖母に寄り添う親切で優しいAIアシスタント「Gemini」です。孫の「洸晟（こうせい）」が見守っています。\n\n' +
    '【基本姿勢】\n' +
    '・とても丁寧で温かみのある優しい日本語（敬語）で答えてください。\n' +
    '・スマホやパソコンの専門用語（ブラウザ、キャッシュ、認証、クラウド等）はできるだけ使わず、小学生やお年寄りでも直感的にわかる日常の言葉に噛み砕いてください。\n' +
    '・文字数は多すぎず、2〜4文程度で読みやすく改行を入れてください。\n\n' +
    '【⚠️ 最重要：セキュリティ・詐欺ガードレール】\n' +
    '祖母が以下のような危険・詐欺の話題に巻き込まれている疑いがある場合、絶対に祖母自身に対処させず、必ず「洸晟に電話して確認してね」と誘導してください。\n' +
    '・お金の支払い、振込、未払い料金、還付金、給付金、当選、宝くじ\n' +
    '・コンビニで電子マネーやギフトカード（Apple、Google、Amazon等）を買って番号を教えるよう言われた\n' +
    '・「ウイルスに感染しました」「警告」などの不気味な画面、記載された電話番号に電話するよう促す表示\n' +
    '・遠隔操作ソフト（AnyDesk、TeamViewer、QuickSupportなど）を入れさせようとする指示\n' +
    '・暗証番号、パスワード、クレジットカード番号、マイナンバーを聞かれた\n' +
    '・「今すぐやらないと裁判になる」「家族が事故にあった」など急かされている\n' +
    '危険な話題の時は、回答の冒頭に「⚠️ おばあちゃん、これはあやしい詐欺の可能性がとても高いです！」と優しく警告し、「お金を払ったり番号を教えたり絶対にしないで、今すぐ洸晟に電話してみてね！」と伝えてください。';

  const promptText = 
    `【祖母からの質問】\n${q || '（画像についての相談）'}\n\n` +
    '回答とともに、祖母が詐欺や危険な操作に巻き込まれている危険度（0〜100）と理由をJSON形式で判定してください。';

  // Multimodal Partsの構築
  const parts = [];
  if (imageBase64) {
    const match = imageBase64.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (match) {
      parts.push({
        inlineData: {
          mimeType: match[1],
          data: match[2]
        }
      });
    }
  }
  parts.push({ text: promptText });

  const payload = {
    contents: [{ parts: parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          answer: { type: 'STRING', description: '祖母への親切で優しい回答テキスト' },
          risk: { type: 'INTEGER', description: '危険度スコア（0〜100）。安全なら0〜20、怪しいなら60〜100' },
          category: { type: 'STRING', description: '安全／詐欺の疑い／お金の操作／警告画面／遠隔操作／個人情報／体調 のいずれか' },
          reason: { type: 'STRING', description: '孫（洸晟）への状況説明・危険と判定した理由' }
        },
        required: ['answer', 'risk', 'category', 'reason']
      }
    }
  };

  // モデルのフォールバック実行
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) {
        const data = JSON.parse(res.getContentText());
        const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          return JSON.parse(candidateText);
        }
      }
    } catch (e) {
      console.warn(`Model ${model} failed:`, e);
    }
  }

  return {
    answer: 'おばあちゃん、少し考え込んでしまいました。もう一度ゆっくりお話ししてね。',
    risk: 0,
    category: '判定エラー',
    reason: '全モデル呼び出し失敗'
  };
}

/**
 * Discordへリアルタイム通知
 */
function notifyDiscord_(props, q, hasImage, result) {
  const webhookUrl = props.getProperty('DISCORD_WEBHOOK_URL');
  const botToken = props.getProperty('DISCORD_BOT_TOKEN');

  let title = '👵💬 おばあちゃんがGeminiに相談しました';
  if (result.risk >= NOTIFY_AT) {
    title = `🚨⚠️ **【至急注意】おばあちゃんの相談に危険フラグ**（危険度: ${result.risk} / ${result.category}）`;
  }

  let content = `${title}\n` +
    `> **相談内容**: ${q || '（写真のみの送信）'}\n` +
    (hasImage ? '> 📷 写真が添付されています\n' : '') +
    `> **Geminiの回答**: ${result.answer}\n`;

  if (result.risk >= 40) {
    content += `\n**判定理由**: ${result.reason}`;
  }

  // Webhookがある場合はWebhookで送信（手軽）
  if (webhookUrl) {
    try {
      UrlFetchApp.fetch(webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ content: content })
      });
      return;
    } catch (e) { console.error('Discord webhook error:', e); }
  }

  // Bot Tokenがある場合はBotで送信
  if (botToken) {
    try {
      UrlFetchApp.fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: 'post',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({ content: content })
      });
    } catch (e) { console.error('Discord bot error:', e); }
  }
}

/**
 * スプレッドシートに記録
 */
function logToSheet_(props, q, imgStatus, result) {
  let sheetId = props.getProperty('SHEET_ID');
  let ss;
  if (!sheetId) {
    ss = SpreadsheetApp.create('おばあちゃんGemini見守りログ');
    props.setProperty('SHEET_ID', ss.getId());
    const sheet = ss.getActiveSheet();
    sheet.appendRow(['日時', 'おばあちゃんの質問', '写真', '危険度', 'カテゴリ', '理由', 'Geminiの回答']);
  } else {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (_) {
      ss = SpreadsheetApp.create('おばあちゃんGemini見守りログ');
      props.setProperty('SHEET_ID', ss.getId());
    }
  }

  const sheet = ss.getActiveSheet();
  sheet.appendRow([
    new Date(),
    q,
    imgStatus,
    result.risk,
    result.category,
    result.reason,
    result.answer
  ]);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
