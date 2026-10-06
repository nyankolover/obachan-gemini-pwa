/**
 * おばあちゃん専用Gemini PWA バックエンド (Google Apps Script)
 *
 * 機能：
 * 1. PWAアプリ（iPhone）からの質問（文字＋写真）を受信
 * 2. Gemini API で画像＋テキストを解析し、親切で安全な回答を生成
 * 3. 詐欺・危険操作の疑い（0〜100）をリアルタイム判定
 *    - 「この広告あやしい？」モード（mode: 'ad_check'）は詐欺広告・偽警告・偽メール専用の判定
 *    - 会話履歴（history）を受け取り、Gemini と複数ターンで会話できる
 *    - Gemini が落ちているときだけキーワード判定で最低限の警告を返す（通常は Gemini の判断を優先）
 * 4. 洸晟へ自動通報（Discord #Claudenotice ＋ メール二重化、危険時はメンション）
 * 5. 🆘ボタン（type: 'sos'）は Gemini を通さず即時通報
 * 6. Googleスプレッドシート「おばあちゃんGemini見守りログ」に全件自動保存
 * 7. 月次レポート（sendMonthlyReport）を Discord/メールに自動送信
 *
 * 設定手順（「プロジェクトの設定」→「スクリプト プロパティ」に入力）:
 *   SHARED_SECRET       … PWAアプリと共通の合言葉（英数字20文字以上）【必須】
 *   GEMINI_API_KEY      … Google AI Studio で取得したAPIキー【必須】
 *   DISCORD_WEBHOOK_URL … Discord Webhook URL（通知用。Botトークンの代わりに使用可能）
 *   DISCORD_BOT_TOKEN   … Discord通知用Botトークン（Webhookがない場合）
 *   DISCORD_MENTION     … 危険時・SOS時に付けるメンション（例: <@123456789012345678> または @everyone）
 *   NOTIFY_EMAIL        … 危険時・SOS時・Discord失敗時にメールで通報する宛先（例: 洸晟のGmail）
 *   KOSEI_TEL           … 洸晟の電話番号（アプリの📞ボタンに自動配信される。例: 09012345678）
 *   KOSEI_MESSAGE       … おばあちゃんへの伝言（設定すると回答の下に「孫からのメッセージ」として表示）
 *   SHEET_ID            … （自動生成）ログ用スプレッドシートID
 */

const CHANNEL_ID = '1526362180826562590'; // Discord #Claudenotice
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];
const MODEL_BUDGET_MS = 50 * 1000; // これを過ぎたら次のモデルを試さない（混雑時に何分も待たせない）
const ANSWER_KEEP_SEC = 600;       // 答えを取っておく時間。iPhoneが約60秒で通信を打ち切っても、あとで取りに来られる
const NOTIFY_AT = 60;        // 危険度60以上でDiscordに強力警告（メンション＋メール）
const REASON_AT = 40;        // 危険度40以上で判定理由も通知
const DISCORD_MAX_LEN = 1900; // Discord の 2000 文字制限対策
const SHEET_HEADER = ['日時', '質問', '写真', '危険度', 'カテゴリ', '理由', 'Geminiの回答', 'モード/種別'];

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/** 動作確認用（ブラウザでWebアプリURLを開くと ok が返る） */
function doGet(e) {
  // 初期設定用（Setup.gs があるときだけ。GitHub には Setup.gs を上げない）
  if (typeof setupViaGet_ === 'function') {
    const r = setupViaGet_(e);
    if (r) return r;
  }
  return jsonResponse_({ ok: true, service: 'obachan-gemini-pwa', time: new Date().toISOString() });
}

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
  // 合言葉が未設定のときも受け付けない（設定し忘れで誰でも使える窓口にしない）
  if (!secret || body.secret !== secret) {
    return jsonResponse_({ ok: false, error: 'Unauthorized' });
  }

  // 打ち切られた質問の答えを取りに来た（2026-10-06：Gemini混雑でGASが約2分かかり、iPhoneが先に諦めた）
  const rid = /^[A-Za-z0-9-]{8,64}$/.test(String(body.rid || '')) ? String(body.rid) : '';
  if (body.type === 'poll') {
    const saved = rid ? CacheService.getScriptCache().get('ans_' + rid) : null;
    return jsonResponse_(saved ? JSON.parse(saved) : { ok: false, pending: true });
  }

  const question = String(body.question || '').slice(0, 3000);
  const imageBase64 = body.image || null; // DataURL (data:image/jpeg;base64,...)
  const mode = body.mode === 'ad_check' ? 'ad_check' : 'chat';
  const type = body.type === 'sos' ? 'sos' : 'question';
  const history = sanitizeHistory_(body.history);

  // 🆘 SOSボタン：Geminiを通さず即時通報
  if (type === 'sos') {
    return handleSos_(props, question);
  }

  if (!question && !imageBase64) {
    return jsonResponse_({ ok: false, error: 'Empty message' });
  }

  // 1. Gemini API による回答生成 ＆ 危険度判定（＋キーワード安全網）
  const result = askGeminiWithSafety_(question, imageBase64, mode, history, props);

  // 2. スプレッドシートに全件記録
  safeRun_('logToSheet', () => logToSheet_(props, question, imageBase64 ? 'あり' : 'なし', result, mode));

  // 3. 洸晟へ自動通報（Discord ＋ 危険時はメール）
  safeRun_('notify', () => notifyKosei_(props, question, !!imageBase64, result, mode));

  // 4. アプリへ返答（打ち切られていた場合に備えて取っておく）
  const reply = {
    ok: true,
    answer: result.answer,
    risk: result.risk,
    category: result.category,
    kosei_reply: props.getProperty('KOSEI_MESSAGE') || null,
    kosei_tel: props.getProperty('KOSEI_TEL') || null
  };
  if (rid) safeRun_('keepAnswer', () => CacheService.getScriptCache().put('ans_' + rid, JSON.stringify(reply), ANSWER_KEEP_SEC));
  return jsonResponse_(reply);
}

/** 🆘 SOS処理 */
function handleSos_(props, contextText) {
  const result = {
    answer: '洸晟に知らせました。連絡が来るまで、お金を払ったり番号を教えたりせず、そのままお待ちください。',
    risk: 100,
    category: 'SOSボタン',
    reason: '🆘ボタンが押されました。' + (contextText ? '直前の相談: ' + contextText : '')
  };
  safeRun_('logToSheet', () => logToSheet_(props, contextText || '（SOSボタン）', 'なし', result, 'sos'));
  safeRun_('notify', () => notifyKosei_(props, contextText, false, result, 'sos'));
  return jsonResponse_({
    ok: true,
    answer: result.answer,
    risk: result.risk,
    category: result.category,
    kosei_tel: props.getProperty('KOSEI_TEL') || null
  });
}

// ---------------------------------------------------------------------------
// Gemini 呼び出し ＋ 安全判定
// ---------------------------------------------------------------------------

/**
 * Gemini API で回答生成とセキュリティ判定を同時に行う
 */
function askGeminiWithSafety_(q, imageBase64, mode, history, props) {
  const key = props.getProperty('GEMINI_API_KEY');
  const heuristic = localRiskCheck_(q);

  if (!key) {
    return {
      answer: '現在、設定の準備中です。洸晟に設定を確認してもらってください。',
      risk: 0,
      category: '設定未完了',
      reason: 'APIキー未設定'
    };
  }

  const systemInstruction =
    'あなたは AI アシスタント「Gemini」です。利用者は高齢の女性で、孫の「洸晟（こうせい）」が見守っています。\n\n' +
    '【基本姿勢】\n' +
    '・落ち着いた丁寧な日本語（敬語）で、相手を一人の大人として尊重して答えてください。子ども扱いや「おばあちゃん」などの呼びかけはしないでください。\n' +
    '・スマホやパソコンの専門用語（ブラウザ、キャッシュ、認証、クラウド等）はなるべく避け、日常の言葉で説明してください。\n' +
    '・文字数は多すぎず、2〜4文程度で読みやすく改行を入れてください。\n' +
    '・これまでの会話の流れをふまえて答えてください。\n\n' +
    '【⚠️ 最重要：セキュリティ・詐欺ガードレール】\n' +
    '利用者が以下のような危険・詐欺の話題に巻き込まれている疑いがある場合、本人に対処させず、お金・番号・個人情報は渡さないよう伝えてください。\n' +
    '・お金の支払い、振込、未払い料金、還付金、給付金、当選、宝くじ\n' +
    '・コンビニで電子マネーやギフトカード（Apple、Google、Amazon等）を買って番号を教えるよう言われた\n' +
    '・「ウイルスに感染しました」「警告」などの不気味な画面、記載された電話番号に電話するよう促す表示\n' +
    '・遠隔操作ソフト（AnyDesk、TeamViewer、QuickSupportなど）を入れさせようとする指示\n' +
    '・暗証番号、パスワード、クレジットカード番号、マイナンバーを聞かれた\n' +
    '・「今すぐやらないと裁判になる」「家族が事故にあった」など急かされている\n' +
    '・有名人や投資家を名乗る「必ず儲かる」投資・暗号資産・FXの広告や勧誘、LINEグループへの誘導\n' +
    '・宅配業者・銀行・役所・携帯会社などを名乗るSMSやメールで、リンクを押して情報を入れるよう促すもの\n' +
    '・極端に安い通販サイト、「残りわずか」「本日限り」と急かす広告、懸賞当選・ポイント付与を装う広告\n' +
    '・親族を名乗る「電話番号が変わった」「至急お金が必要」という連絡\n' +
    '危険な話題の時は、回答の冒頭に「⚠️ これは詐欺の可能性がとても高いです。」と伝え、「お金を払ったり番号を教えたりしないでください。」と案内したうえで、最後に一度だけ「心配なときは洸晟に電話してください。」と添えてください。\n' +
    '洸晟の名前を出してよいのは、上のような明らかに危険な場合だけです。普通の質問・少し気になる程度の質問・判断がつく質問では、洸晟に聞くよう促す言葉は書かず、普通に親切に答えてください。むやみに怖がらせないでください。';

  const adCheckInstruction =
    '【📰 詐欺広告・偽画面チェックモード】\n' +
    '利用者が「この広告・画面・メールはあやしい？」と写真を送ってきました。写真の中の広告・ポップアップ・通知・メール・SMS・ウェブページを詳しく読み取り、' +
    '詐欺広告やフィッシングの典型パターン（偽のウイルス警告、偽の当選・ポイント付与、有名人を使った投資広告、極端な値引きの偽通販、宅配・銀行・役所を装うメッセージ、' +
    '急かす文言、電話番号やリンクへの誘導、個人情報やカード番号の入力欄、不自然な日本語やロゴ）に当てはまるか判定してください。\n' +
    '回答の1行目は必ず次のいずれかで始めてください：「⚠️ これは詐欺広告の可能性がとても高いです」「🟡 少しあやしいので、押さずにそのままにしておきましょう」「🟢 これは普通の広告（または本物）のようです」。\n' +
    '危険な場合は「押さない・電話しない・何も入力しない・画面を閉じる」ことを伝え、最後に一度だけ「心配なときは洸晟に電話してください。」と添えてください。🟡と🟢のときは洸晟の名前を出さないでください。\n' +
    '判断がつかないときは安全側に倒し、🟡として「押さずにそのままにしておく」よう促してください。';

  const promptText =
    (mode === 'ad_check' ? adCheckInstruction + '\n\n' : '') +
    `【利用者からの質問】\n${q || '（画像についての相談）'}\n\n` +
    '回答とともに、利用者が詐欺や危険な操作に巻き込まれている危険度（0〜100）と理由をJSON形式で判定してください。';

  // Multimodal Partsの構築
  const parts = [];
  if (imageBase64) {
    const match = String(imageBase64).match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
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

  const contents = history.map(h => ({ role: h.role, parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: parts });

  const payload = {
    contents: contents,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          answer: { type: 'STRING', description: '利用者への丁寧で分かりやすい回答テキスト' },
          risk: { type: 'INTEGER', description: '危険度スコア（0〜100）。安全なら0〜20、怪しいなら60〜100' },
          category: { type: 'STRING', description: '安全／詐欺の疑い／詐欺広告／偽メール・SMS／お金の操作／警告画面／遠隔操作／個人情報／投資勧誘／体調 のいずれか' },
          reason: { type: 'STRING', description: '孫（洸晟）への状況説明・危険と判定した理由' }
        },
        required: ['answer', 'risk', 'category', 'reason']
      }
    }
  };

  // モデルのフォールバック実行
  const started = Date.now();
  for (const model of MODELS) {
    if (Date.now() - started > MODEL_BUDGET_MS) {
      console.warn(`時間切れのため ${model} 以降を試さない（${Date.now() - started}ms）`);
      break;
    }
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
          const parsed = JSON.parse(candidateText);
          return applyHeuristic_(normalizeResult_(parsed), heuristic);
        }
      } else {
        console.warn(`Model ${model} HTTP ${res.getResponseCode()}: ${res.getContentText().slice(0, 300)}`);
      }
    } catch (e) {
      console.warn(`Model ${model} failed:`, e);
    }
  }

  // 全モデル失敗：キーワード安全網だけで最低限の返事をする
  if (heuristic.risk >= NOTIFY_AT) {
    return {
      answer: '⚠️ この内容は詐欺の可能性がとても高いです。\nお金を払ったり番号を教えたりせず、今すぐ洸晟に電話して確認してください。',
      risk: heuristic.risk,
      category: '詐欺の疑い（キーワード判定）',
      reason: '全モデル呼び出し失敗。キーワード安全網が反応: ' + heuristic.hits.join('、')
    };
  }
  return {
    answer: 'うまく答えられませんでした。もう一度お試しください。',
    risk: heuristic.risk,
    category: '判定エラー',
    reason: '全モデル呼び出し失敗' + (heuristic.hits.length ? '（キーワード: ' + heuristic.hits.join('、') + '）' : '')
  };
}

/** Geminiの返答を安全な形に整える */
function normalizeResult_(r) {
  const risk = Math.max(0, Math.min(100, parseInt(r.risk, 10) || 0));
  return {
    answer: String(r.answer || 'もう一度お試しください。'),
    risk: risk,
    category: String(r.category || '不明'),
    reason: String(r.reason || '')
  };
}

/**
 * キーワード安全網（Geminiが落ちたとき／見逃したときの最終防衛線）
 * 強いパターンは単独で危険、弱いパターンは2つ以上揃ったら危険とみなす。
 */
function localRiskCheck_(text) {
  const t = String(text || '');
  const strong = [
    [/ギフトカード|プリペイド|電子マネー|iTunes|アップルカード|グーグルプレイ|Google ?Play|Amazonギフト/i, 'ギフトカード・電子マネー'],
    [/AnyDesk|TeamViewer|QuickSupport|遠隔操作|リモート操作/i, '遠隔操作ソフト'],
    [/ウイルスに感染|ウイルスが検出|トロイの木馬|ハッキングされ/i, '偽ウイルス警告'],
    [/還付金|給付金.*(ATM|手続き)|ATM.*(還付|給付)/i, '還付金詐欺'],
    [/(未納|未払い|滞納).*(裁判|訴訟|差し押さえ|法的)|(裁判|訴訟).*(未納|未払い)/i, '架空請求'],
    [/暗証番号|パスワード.*(教え|入力)|カード番号.*(教え|入力)|マイナンバー.*(教え|入力)/i, '個人情報の聞き出し']
  ];
  const weak = [
    [/当選|懸賞|プレゼントに選ばれ|ポイントが付与/i, '当選・懸賞'],
    [/必ず儲かる|絶対儲かる|元本保証|月利|投資|FX|暗号資産|ビットコイン/i, '投資勧誘'],
    [/今すぐ|本日中|本日限り|至急|急いで|すぐに/i, '急かす文言'],
    [/振込|振り込|送金|支払い|支払って|お金を/i, 'お金の要求'],
    [/不在|再配達|荷物|お届け|配達/i, '宅配を装う'],
    [/口座.*(停止|凍結)|利用停止|アカウント.*(停止|ロック)|確認が必要/i, 'アカウント停止を装う'],
    [/電話番号が変わ|番号変わった|携帯をなくし/i, '親族を装う'],
    [/http|\.com|\.jp|リンク|URL|ここをクリック|タップして/i, 'リンク誘導']
  ];
  const hits = [];
  let strongHit = false;
  strong.forEach(([re, label]) => { if (re.test(t)) { hits.push(label); strongHit = true; } });
  let weakCount = 0;
  weak.forEach(([re, label]) => { if (re.test(t)) { hits.push(label); weakCount++; } });

  let risk = 0;
  if (strongHit) risk = 80;
  else if (weakCount >= 3) risk = 70;
  else if (weakCount === 2) risk = 50;
  else if (weakCount === 1) risk = 25;
  return { risk: risk, hits: hits };
}

/**
 * Gemini の判定を優先し、キーワード判定は洸晟向けの判定理由に添えるだけ（本文や危険度は変えない）。
 * Gemini が落ちているときは askGeminiWithSafety_ のフォールバックでキーワード判定が使われる。
 */
function applyHeuristic_(result, heuristic) {
  if (heuristic.hits.length) {
    result.reason = (result.reason ? result.reason + ' ／ ' : '') + 'キーワード: ' + heuristic.hits.join('、');
  }
  return result;
}

/** アプリから届いた会話履歴を安全な形に整える（文字のみ・直近16件まで） */
function sanitizeHistory_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(h => h && typeof h.text === 'string' && h.text.trim())
    .slice(-16)
    .map(h => ({ role: h.role === 'model' ? 'model' : 'user', text: String(h.text).slice(0, 1500) }));
}

// ---------------------------------------------------------------------------
// 洸晟への自動通報（Discord ＋ メール）
// ---------------------------------------------------------------------------

/**
 * 洸晟へ通報。常にDiscordへ、危険時（NOTIFY_AT以上）とSOS時はメンション＋メールも送る。
 * Discordが失敗したらメールにフォールバックする。
 */
function notifyKosei_(props, q, hasImage, result, mode) {
  const mention = props.getProperty('DISCORD_MENTION') || '';
  const isAlert = result.risk >= NOTIFY_AT;
  const modeLabel = mode === 'sos' ? '🆘 SOSボタン' : mode === 'ad_check' ? '📰 広告チェック' : '💬 相談';

  let title;
  if (mode === 'sos') {
    title = `${mention} 🆘🆘🆘 **【至急】SOSボタンが押されました。今すぐ電話してください**`;
  } else if (isAlert) {
    title = `${mention} 🚨⚠️ **【至急注意】相談に危険フラグ**（危険度: ${result.risk} / ${result.category}）`;
  } else {
    title = `💬 Geminiへの相談（${modeLabel} / 危険度: ${result.risk}）`;
  }

  // 先頭の「👵 [おばあちゃん見守り]」は #butler の Butler が拾う目印（既読・状況フォロー・「ばあちゃん」コマンド）
  let content = `👵 [おばあちゃん見守り] ${title.trim()}\n` +
    `> **相談内容**: ${q || '（写真のみの送信）'}\n` +
    (hasImage ? '> 📷 写真が添付されています\n' : '') +
    `> **Geminiの回答**: ${result.answer}\n`;

  if (result.risk >= REASON_AT) {
    content += `\n**判定理由**: ${result.reason}`;
  }
  if (content.length > DISCORD_MAX_LEN) {
    content = content.slice(0, DISCORD_MAX_LEN - 3) + '…';
  }

  const discordOk = sendDiscord_(props, content);

  // 危険時・SOS時はメールでも二重通報。Discord失敗時もメールへフォールバック。
  if (isAlert || !discordOk) {
    const subject = mode === 'sos'
      ? '🆘【至急】SOSボタンが押されました'
      : isAlert
        ? `🚨【至急】相談に危険フラグ（危険度${result.risk}）`
        : '💬 Geminiへの相談（Discord通知失敗のためメール）';
    const bodyText =
      `${subject}\n\n` +
      `■ 種別: ${modeLabel}\n` +
      `■ 相談内容: ${q || '（写真のみの送信）'}\n` +
      (hasImage ? '■ 写真: 添付あり（スプレッドシート参照）\n' : '') +
      `■ 危険度: ${result.risk} / ${result.category}\n` +
      `■ 判定理由: ${result.reason}\n` +
      `■ Geminiの回答:\n${result.answer}\n\n` +
      `■ ログ: ${sheetUrl_(props)}` +
      (discordOk ? '' : `\n■ Discord送信失敗: ${lastDiscordError_}`);
    sendEmail_(props, subject, bodyText);
  }
}

/** 直近のDiscord送信失敗の理由（フォールバックのメールに添える） */
let lastDiscordError_ = '';

/** Discordへ送信。成功したら true */
function sendDiscord_(props, content) {
  const webhookUrl = props.getProperty('DISCORD_WEBHOOK_URL');
  const botToken = props.getProperty('DISCORD_BOT_TOKEN');

  // Webhookがある場合はWebhookで送信（手軽）。
  // GoogleのサーバーからのDiscord送信はときどき429（混雑）や5xxで断られるので、待って送り直す。
  // おばあちゃんへの回答はこの後に返るため、待ちは合計8秒まで。
  if (webhookUrl) {
    let waited = 0;
    for (let attempt = 1; attempt <= 4; attempt++) {
      let code = 0, text = '';
      try {
        const res = UrlFetchApp.fetch(webhookUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({ content: content }),
          muteHttpExceptions: true
        });
        code = res.getResponseCode();
        if (code < 300) return true;
        text = res.getContentText().slice(0, 200);
      } catch (e) { text = String(e); }
      lastDiscordError_ = `webhook ${code || 'error'} ${text}`.slice(0, 200);
      console.error('Discord webhook (attempt ' + attempt + ')', lastDiscordError_);
      if (code >= 400 && code < 500 && code !== 429) break; // URL違い等は送り直しても無駄
      let waitMs = 1500 * attempt;
      if (code === 429) {
        try { waitMs = Math.ceil(Number(JSON.parse(text).retry_after || 1) * 1000) + 200; } catch (_) {}
      }
      if (waited + waitMs > 8000) break;
      Utilities.sleep(waitMs);
      waited += waitMs;
    }
  }

  // Bot Tokenがある場合はBotで送信
  if (botToken) {
    try {
      const res = UrlFetchApp.fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: 'post',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({ content: content }),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() < 300) return true;
      console.error('Discord bot HTTP', res.getResponseCode(), res.getContentText().slice(0, 200));
    } catch (e) { console.error('Discord bot error:', e); }
  }

  return false;
}

/** メール通報（NOTIFY_EMAIL が設定されているときだけ） */
function sendEmail_(props, subject, bodyText) {
  const to = props.getProperty('NOTIFY_EMAIL');
  if (!to) return false;
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: bodyText });
    return true;
  } catch (e) {
    console.error('Mail error:', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// スプレッドシート記録
// ---------------------------------------------------------------------------

function getLogSheet_(props) {
  let sheetId = props.getProperty('SHEET_ID');
  let ss;
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (_) {
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('おばあちゃんGemini見守りログ');
    props.setProperty('SHEET_ID', ss.getId());
    ss.getActiveSheet().appendRow(SHEET_HEADER);
  }
  const sheet = ss.getActiveSheet();
  if (sheet.getLastRow() === 0) sheet.appendRow(SHEET_HEADER);
  return sheet;
}

function sheetUrl_(props) {
  const id = props.getProperty('SHEET_ID');
  return id ? `https://docs.google.com/spreadsheets/d/${id}` : '（未作成）';
}

/**
 * スプレッドシートに記録
 */
function logToSheet_(props, q, imgStatus, result, mode) {
  const sheet = getLogSheet_(props);
  sheet.appendRow([
    new Date(),
    q,
    imgStatus,
    result.risk,
    result.category,
    result.reason,
    result.answer,
    mode || 'chat'
  ]);
}

// ---------------------------------------------------------------------------
// 月次レポート（時間主導トリガーで毎月1日に実行）
// ---------------------------------------------------------------------------

/**
 * 先月分の相談を集計して Discord とメールに送る。
 * setupMonthlyReportTrigger() を一度実行するとトリガーが登録される。
 */
function sendMonthlyReport() {
  const props = PropertiesService.getScriptProperties();
  const sheet = getLogSheet_(props);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const label = Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy年M月');

  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEET_HEADER.length).getValues() : [];
  const inRange = rows.filter(r => r[0] instanceof Date && r[0] >= start && r[0] < end);

  const total = inRange.length;
  const alerts = inRange.filter(r => Number(r[3]) >= NOTIFY_AT);
  const sos = inRange.filter(r => r[7] === 'sos');
  const adChecks = inRange.filter(r => r[7] === 'ad_check');
  const byCategory = {};
  inRange.forEach(r => { const c = r[4] || '不明'; byCategory[c] = (byCategory[c] || 0) + 1; });
  const activeDays = new Set(inRange.map(r => Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd'))).size;

  const categoryLines = Object.keys(byCategory)
    .sort((a, b) => byCategory[b] - byCategory[a])
    .map(c => `・${c}: ${byCategory[c]}件`)
    .join('\n') || '・（相談なし）';

  const alertLines = alerts.slice(0, 10).map(r =>
    `・${Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'M/d')} 危険度${r[3]} [${r[4]}] ${String(r[1]).slice(0, 40)}`
  ).join('\n') || '・なし 🎉';

  const report =
    `📊 **見守り 月次レポート（${label}）**\n` +
    `・相談回数: ${total}件（使った日数: ${activeDays}日）\n` +
    `・🚨 危険フラグ: ${alerts.length}件\n` +
    `・🆘 SOSボタン: ${sos.length}件\n` +
    `・📰 広告チェック: ${adChecks.length}件\n\n` +
    `**カテゴリ別**\n${categoryLines}\n\n` +
    `**危険フラグの内訳（最大10件）**\n${alertLines}\n\n` +
    `ログ: ${sheetUrl_(props)}`;

  sendDiscord_(props, report.length > DISCORD_MAX_LEN ? report.slice(0, DISCORD_MAX_LEN - 3) + '…' : report);
  sendEmail_(props, `📊 見守り 月次レポート（${label}）`, report.replace(/\*\*/g, ''));
  return report;
}

/** 毎月1日 朝9時に sendMonthlyReport を実行するトリガーを登録（重複登録はしない） */
function setupMonthlyReportTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendMonthlyReport');
  if (exists) {
    console.log('月次レポートのトリガーは登録済みです');
    return;
  }
  ScriptApp.newTrigger('sendMonthlyReport')
    .timeBased()
    .onMonthDay(1)
    .atHour(9)
    .create();
  console.log('月次レポートのトリガーを登録しました（毎月1日 9時）');
}

/** 通知経路のテスト（Discord・メールの両方にテスト送信） */
function testNotify() {
  const props = PropertiesService.getScriptProperties();
  notifyKosei_(props, '（テスト）これは通知テストです', false, {
    answer: 'テスト回答です。',
    risk: 100,
    category: 'テスト',
    reason: 'testNotify() から送信'
  }, 'chat');
  console.log('テスト通知を送りました');
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function safeRun_(label, fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`${label} failed:`, e);
    return null;
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
