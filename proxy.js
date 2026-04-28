/**
 * 人格解刨刀 - Vercel Serverless API代理
 * 
 * 部署方式：
 * 1. 在 Vercel 中导入你的 GitHub 仓库
 * 2. 设置环境变量 DEEPSEEK_API_KEY=你的DeepSeek Key
 * 3. 部署后得到 https://xxx.vercel.app
 * 4. 前端默认API地址改成 https://xxx.vercel.app
 * 
 * 本地开发：
 * vercel dev
 */

const https = require('https');

// ===== Quota 管理（Vercel环境下用内存，重启重置）=====
// 注意：Vercel Serverless Function 是无状态的，每次冷启动都会重置
// 如果需要持久化quota，建议用 Upstash Redis 或 Vercel KV
const SESSION_LIMIT = 30;
const TOTAL_LIMIT = 3000;

// 使用全局变量（在同一个实例的生命周期内保持）
if (!global.__quota) {
  global.__quota = { totalCalls: 0, sessions: {} };
}
const quota = global.__quota;

function generateSessionId(req) {
  const ip = req.headers['x-forwarded-for'] || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  let hash = 0;
  const str = ip + ua;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function checkQuota(sessionId) {
  if (quota.totalCalls >= TOTAL_LIMIT) {
    return { allowed: false, message: '服务总调用次数已达上限，请联系管理员' };
  }
  const session = quota.sessions[sessionId] || { count: 0 };
  if (session.count >= SESSION_LIMIT) {
    return { allowed: false, message: '免费额度已用完，请输入自己的API体验哦' };
  }
  return { allowed: true };
}

function deductQuota(sessionId) {
  quota.totalCalls += 1;
  if (!quota.sessions[sessionId]) {
    quota.sessions[sessionId] = { count: 0 };
  }
  quota.sessions[sessionId].count += 1;
}

module.exports = async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET /api/proxy - 健康检查
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', totalCalls: quota.totalCalls });
  }

  // 只接受 POST
  if (req.method !== 'POST') {
    return res.status(404).json({ error: 'Not Found' });
  }

  try {
    const { url: targetUrl, ...apiParams } = req.body;

    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing target URL' });
    }

    // 判断是否使用内置Key
    const authHeader = req.headers['authorization'];
    const useBuiltInKey = !authHeader || authHeader === 'Bearer ' || authHeader === 'Bearer undefined';
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

    if (useBuiltInKey) {
      if (!DEEPSEEK_API_KEY) {
        return res.status(500).json({ error: 'Server not configured with API key' });
      }
      const sessionId = generateSessionId(req);
      const quotaCheck = checkQuota(sessionId);
      if (!quotaCheck.allowed) {
        return res.status(429).json({
          error: quotaCheck.message,
          quotaError: true,
        });
      }
    }

    // 转发到目标API
    const fullUrl = targetUrl.endsWith('/chat/completions')
      ? targetUrl
      : targetUrl.replace(/\/+$/, '') + '/chat/completions';

    const urlObj = new URL(fullUrl);
    const finalAuth = useBuiltInKey ? `Bearer ${DEEPSEEK_API_KEY}` : authHeader;

    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': finalAuth || '',
      },
      timeout: 120000,
    };

    const proxyRes = await new Promise((resolve, reject) => {
      const proxyReq = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          resolve({ status: response.statusCode, headers: response.headers, body: data });
        });
      });
      proxyReq.on('error', reject);
      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        reject(new Error('API request timeout'));
      });
      const { url: _, ...forwardBody } = apiParams;
      proxyReq.write(JSON.stringify(forwardBody));
      proxyReq.end();
    });

    // 扣减quota
    if (useBuiltInKey && proxyRes.status < 500) {
      const sessionId = generateSessionId(req);
      deductQuota(sessionId);
    }

    const responseHeaders = { ...proxyRes.headers };
    delete responseHeaders['access-control-allow-origin'];
    res.setHeader('Content-Type', responseHeaders['content-type'] || 'application/json');
    return res.status(proxyRes.status).send(proxyRes.body);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
