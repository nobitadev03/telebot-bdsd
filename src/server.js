const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const querystring = require('node:querystring');

const config = {
  port: Number(process.env.PORT || 3000),
  webhookPath: process.env.SEPAY_WEBHOOK_PATH || '/webhooks/sepay',
  apiKey: process.env.SEPAY_API_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  dedupeFile: process.env.DEDUPE_FILE || path.join(process.cwd(), 'data', 'processed-webhooks.json'),
  maxBodySize: Number(process.env.MAX_BODY_SIZE || 1024 * 1024),
  notifyOutgoing: String(process.env.NOTIFY_OUTGOING || 'true').toLowerCase() !== 'false',
};

function formatVnd(value) {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return String(value);
  }

  return new Intl.NumberFormat('vi-VN').format(numericValue) + ' VND';
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function normalizePayload(payload) {
  const id = payload.id ?? payload.transactionId ?? payload.referenceCode ?? `${payload.accountNumber || 'unknown'}-${payload.transactionDate || Date.now()}-${payload.transferAmount || payload.amount || '0'}`;
  const transferType = normalizeText(payload.transferType || payload.direction || '').toLowerCase();
  const isIncoming = transferType === 'in' || transferType === 'credit' || transferType === 'income';
  const isOutgoing = transferType === 'out' || transferType === 'debit' || transferType === 'expense';

  return {
    id: String(id),
    gateway: normalizeText(payload.gateway || payload.bank || payload.bankName || 'SePay'),
    transactionDate: normalizeText(payload.transactionDate || payload.date || payload.createdAt || ''),
    accountNumber: normalizeText(payload.accountNumber || payload.account || payload.bankAccount || ''),
    code: normalizeText(payload.code || payload.paymentCode || ''),
    content: normalizeText(payload.content || payload.description || payload.message || ''),
    transferType: isIncoming ? 'in' : isOutgoing ? 'out' : transferType || 'unknown',
    transferAmount: payload.transferAmount ?? payload.amount ?? 0,
    accumulated: payload.accumulated ?? payload.balance ?? null,
    subAccount: normalizeText(payload.subAccount || payload.virtualAccount || ''),
    referenceCode: normalizeText(payload.referenceCode || payload.reference || ''),
    description: normalizeText(payload.description || ''),
  };
}

function buildTelegramMessage(event) {
  const direction = event.transferType === 'in' ? 'Tiền vào' : event.transferType === 'out' ? 'Tiền ra' : 'Biến động số dư';
  const lines = [
    'SePay báo biến động số dư',
    `Loại: ${direction}`,
    `Số tiền: ${formatVnd(event.transferAmount)}`,
    `Số dư lũy kế: ${formatVnd(event.accumulated)}`,
    `Ngân hàng: ${event.gateway}`,
    event.accountNumber ? `Tài khoản: ${event.accountNumber}` : null,
    event.subAccount ? `Tài khoản phụ: ${event.subAccount}` : null,
    event.code ? `Mã thanh toán: ${event.code}` : null,
    event.referenceCode ? `Tham chiếu: ${event.referenceCode}` : null,
    event.content ? `Nội dung: ${event.content}` : null,
    event.transactionDate ? `Thời gian: ${event.transactionDate}` : null,
    `Webhook ID: ${event.id}`,
  ].filter(Boolean);

  return lines.join('\n');
}

async function sendTelegramMessage(message) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${text}`);
  }
}

async function parseRequestBody(request) {
  const contentType = (request.headers['content-type'] || '').toLowerCase();
  const body = await readBody(request);

  if (!body.length) {
    return {};
  }

  if (contentType.includes('application/json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    return JSON.parse(body);
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return querystring.parse(body);
  }

  return { rawBody: body };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    request.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > config.maxBodySize) {
        reject(new Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', reject);
  });
}

function isAuthorized(request) {
  if (!config.apiKey) {
    return true;
  }

  const authHeader = String(request.headers.authorization || '').trim();
  return authHeader === `Apikey ${config.apiKey}` || authHeader === `ApiKey ${config.apiKey}`;
}

function sendJson(response, statusCode, data) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function handleWebhook(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { success: false, message: 'Unauthorized' });
    return;
  }

  let payload;
  try {
    payload = await parseRequestBody(request);
  } catch (error) {
    sendJson(response, error.message === 'Request body too large' ? 413 : 400, {
      success: false,
      message: error.message,
    });
    return;
  }

  const event = normalizePayload(payload);

  if (!event.id) {
    sendJson(response, 400, {
      success: false,
      message: 'Missing webhook id',
    });
    return;
  }

  const isDuplicate = await dedupeStore.has(event.id);
  if (isDuplicate) {
    sendJson(response, 201, {
      success: true,
      message: 'Duplicate webhook ignored',
    });
    return;
  }

  if (event.transferType === 'out' && !config.notifyOutgoing) {
    await dedupeStore.add(event.id);
    sendJson(response, 201, {
      success: true,
      message: 'Outgoing transaction skipped',
    });
    return;
  }

  try {
    await sendTelegramMessage(buildTelegramMessage(event));
    await dedupeStore.add(event.id);
    sendJson(response, 201, {
      success: true,
      message: 'Notification sent',
    });
  } catch (error) {
    console.error('Failed to process webhook:', error);
    sendJson(response, 500, {
      success: false,
      message: 'Failed to send notification',
    });
  }
}

async function handleHealthCheck(response) {
  sendJson(response, 200, {
    ok: true,
    service: 'sepay-balance-bot',
    uptime: process.uptime(),
  });
}

async function main() {
  await dedupeStore.init();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/health') {
        await handleHealthCheck(response);
        return;
      }

      if (request.method === 'POST' && url.pathname === config.webhookPath) {
        await handleWebhook(request, response);
        return;
      }

      sendJson(response, 404, {
        success: false,
        message: 'Not found',
      });
    } catch (error) {
      console.error('Unexpected server error:', error);
      sendJson(response, 500, {
        success: false,
        message: 'Internal server error',
      });
    }
  });

  server.listen(config.port, () => {
    console.log(`Sepay bot is running on port ${config.port}`);
    console.log(`Webhook path: ${config.webhookPath}`);
  });
}

class DedupeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = new Map();
    this.maxAgeMs = 30 * 24 * 60 * 60 * 1000;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const now = Date.now();

      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'number' && now - value <= this.maxAgeMs) {
          this.items.set(key, value);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Unable to load dedupe store:', error.message);
      }
    }
  }

  async has(key) {
    return this.items.has(String(key));
  }

  async add(key) {
    this.items.set(String(key), Date.now());
    await this.save();
  }

  async save() {
    const tmpPath = `${this.filePath}.tmp`;
    const data = JSON.stringify(Object.fromEntries(this.items.entries()), null, 2);
    await fs.writeFile(tmpPath, data, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

const dedupeStore = new DedupeStore(config.dedupeFile);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
