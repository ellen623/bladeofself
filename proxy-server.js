/**
 * 人格解刨刀 - API代理服务器
 * 解决DeepSeek等API的CORS跨域问题
 * 内置quota管理：单次30次，总3000次
 * 
 * 使用方法：
 * 1. 设置环境变量 DEEPSEEK_API_KEY=你的key
 * 2. 终端运行: node proxy-server.js
 * 3. 前端默认API地址指向此服务器
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-your-deepseek-api-key-here';

// ===== Quota 管理 =====
const QUOTA_FILE = path.join(__dirname, '.quota.json');
const SESSION_LIMIT = 30;   // 单次会话最多30次API调用
const TOTAL_LIMIT = 3000;   // 总quota 3000次

// 从文件加载quota数据
function loadQuota() {
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载quota文件失败:', e.message);
  }
  return { totalCalls: 0, sessions: {} };
}

// 保存quota数据到文件
function saveQuota(data) {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('保存quota文件失败:', e.message);
  }
}

let quota = loadQuota();

// 清理过期session（24小时前的session）
function cleanOldSessions() {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  for (const [sid, session] of Object.entries(quota.sessions)) {
    if (now - session.createdAt > oneDay) {
      delete quota.sessions[sid];
    }
  }
  saveQuota(quota);
}

// 检查并扣减quota
function checkQuota(sessionId) {
  // 总quota检查
  if (quota.totalCalls >= TOTAL_LIMIT) {
    return { allowed: false, reason: 'total', message: '服务总调用次数已达上限，请联系管理员' };
  }

  // 单次session quota检查
  const session = quota.sessions[sessionId] || { count: 0, createdAt: Date.now() };
  if (session.count >= SESSION_LIMIT) {
    return { allowed: false, reason: 'session', message: '免费额度已用完，请输入自己的API体验哦' };
  }

  return { allowed: true };
}

// 扣减quota
function deductQuota(sessionId) {
  quota.totalCalls += 1;
  
  if (!quota.sessions[sessionId]) {
    quota.sessions[sessionId] = { count: 0, createdAt: Date.now() };
  }
  quota.sessions[sessionId].count += 1;
  
  saveQuota(quota);
}

// 生成session ID
function generateSessionId(req) {
  // 用IP + User-Agent 作为session标识
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  // 简单hash
  let hash = 0;
  const str = ip + ua;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ===== 服务器 =====

const server = http.createServer((req, res) => {
  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET /quota - 查询quota状态
  if (req.method === 'GET' && req.url === '/quota') {
    const sessionId = generateSessionId(req);
    const session = quota.sessions[sessionId] || { count: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionUsed: session.count,
      sessionLimit: SESSION_LIMIT,
      totalUsed: quota.totalCalls,
      totalLimit: TOTAL_LIMIT,
      sessionRemaining: Math.max(0, SESSION_LIMIT - session.count),
      totalRemaining: Math.max(0, TOTAL_LIMIT - quota.totalCalls),
    }));
    return;
  }

  // 只接受POST请求到 /chat/completions
  if (req.method !== 'POST' || req.url !== '/chat/completions') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const requestData = JSON.parse(body);
      const { url: targetUrl, ...apiParams } = requestData;

      if (!targetUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing target URL' }));
        return;
      }

      // 从请求中提取Authorization头
      const authHeader = req.headers['authorization'];
      
      // 判断是否使用内置quota（用户没填自己的Key）
      const useBuiltInKey = !authHeader || authHeader === 'Bearer ' || authHeader === 'Bearer undefined';
      
      if (useBuiltInKey) {
        // 使用内置Key，检查quota
        const sessionId = generateSessionId(req);
        const quotaCheck = checkQuota(sessionId);
        if (!quotaCheck.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            error: quotaCheck.message,
            quotaError: true,
            quotaReason: quotaCheck.reason,
          }));
          return;
        }
      }

      // 构建转发请求
      const fullUrl = targetUrl.endsWith('/chat/completions') 
        ? targetUrl 
        : targetUrl.replace(/\/+$/, '') + '/chat/completions';

      const urlObj = new URL(fullUrl);
      const isHttps = urlObj.protocol === 'https:';
      const transport = isHttps ? https : http;

      // 确定使用的API Key
      let finalAuth = authHeader;
      if (useBuiltInKey) {
        finalAuth = `Bearer ${DEEPSEEK_API_KEY}`;
      }

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': finalAuth || '',
        },
        timeout: 120000,
      };

      const proxyReq = transport.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
          // 如果使用了内置Key，扣减quota
          if (useBuiltInKey && proxyRes.statusCode < 500) {
            const sessionId = generateSessionId(req);
            deductQuota(sessionId);
          }
          
          // 转发响应
          const responseHeaders = { ...proxyRes.headers };
          delete responseHeaders['access-control-allow-origin']; // 让我们的CORS头覆盖
          res.writeHead(proxyRes.statusCode, responseHeaders);
          res.end(data);
        });
      });

      proxyReq.on('error', (err) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        res.writeHead(504);
        res.end(JSON.stringify({ error: 'API request timeout' }));
      });

      // 转发请求体（去掉url字段）
      const { url: _, ...forwardBody } = apiParams;
      proxyReq.write(JSON.stringify(forwardBody));
      proxyReq.end();

    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON: ' + err.message }));
    }
  });
});

// 定期清理过期session（每小时）
setInterval(cleanOldSessions, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  🚀 人格解刨刀 - API代理服务器已启动`);
  console.log(`  📡 地址: http://localhost:${PORT}`);
  console.log(`  📊 Quota: 单次${SESSION_LIMIT}次 / 总${TOTAL_LIMIT}次`);
  console.log(`  📈 当前使用: 总${quota.totalCalls}次`);
  console.log(`  \n  前端默认API地址: http://localhost:${PORT}`);
  console.log(`  用户不填Key时使用内置Key并扣quota`);
  console.log(`  用户填自己的Key则不扣quota\n`);
});
