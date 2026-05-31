require('dotenv').config();
const axios = require('axios');
const express = require('express');
const https = require('https');
const http = require('http'); // dùng cho tự ping
const winston = require('winston');

const CONFIG = {
    BASE_URL: process.env.BASE_URL || 'https://aibcr.me',
    USERNAME: process.env.AUTH_USER || 'tiendatoce1232',
    PASSWORD: process.env.AUTH_PASS || 'tiendatoceee1',
    PORT: process.env.PORT || 5000,
    FETCH_INTERVAL: 2000,
    SELF_PING_INTERVAL: 60_000, // 1 phút
};

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
    ),
    transports: [new winston.transports.Console()],
});

// ======================
// Session Manager (giữ nguyên)
// ======================
class SessionManager {
    constructor() {
        this.cookieJar = '';
        this.agent = new https.Agent({ rejectUnauthorized: false });
        this.instance = axios.create({
            baseURL: CONFIG.BASE_URL,
            timeout: 30000,
            httpsAgent: this.agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });
        this._setupInterceptors();
    }

    _setupInterceptors() {
        this.instance.interceptors.request.use(config => {
            if (this.cookieJar) config.headers.Cookie = this.cookieJar;
            return config;
        });

        this.instance.interceptors.response.use(res => {
            const setCookie = res.headers['set-cookie'];
            if (setCookie) {
                setCookie.forEach(cookie => {
                    const [nameVal] = cookie.split(';');
                    const [name, value] = nameVal.split('=');
                    this.cookieJar = this.cookieJar
                        .replace(new RegExp(`${name}=[^;]*;?`, 'g'), '')
                        .trim();
                    this.cookieJar += `${name}=${value}; `;
                });
            }
            return res;
        });
    }

    getCookie(name) {
        const match = this.cookieJar.match(new RegExp(`${name}=([^;]+)`));
        return match ? decodeURIComponent(match[1]) : null;
    }

    async get(url, config = {}) {
        return this.instance.get(url, config);
    }

    async post(url, data, config = {}) {
        return this.instance.post(url, data, config);
    }
}

// ======================
// AuthService (giữ nguyên)
// ======================
class AuthService {
    constructor(session) {
        this.session = session;
    }

    getCsrfToken(html) {
        const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
        return match ? match[1] : null;
    }

    async login() {
        try {
            const { data } = await this.session.get('/login');
            const token = this.getCsrfToken(data);
            if (!token) throw new Error('Không tìm thấy CSRF token');

            const formData = new URLSearchParams();
            formData.append('username', CONFIG.USERNAME);
            formData.append('password', CONFIG.PASSWORD);
            formData.append('_token', token);
            formData.append('action', 'Login');

            const headers = {
                Referer: `${CONFIG.BASE_URL}/login`,
                Origin: CONFIG.BASE_URL,
                'Content-Type': 'application/x-www-form-urlencoded',
            };

            const loginResp = await this.session.post('/login', formData.toString(), { headers });
            return loginResp.status === 200;
        } catch (err) {
            logger.error(`Login failed: ${err.message}`);
            return false;
        }
    }

    async goToLobby() {
        try {
            await this.session.get('/ae/lobby');
            return true;
        } catch (err) {
            logger.error(`Lobby redirect failed: ${err.message}`);
            return false;
        }
    }
}

// ======================
// BaccaratFetcher (giữ nguyên)
// ======================
class BaccaratFetcher {
    constructor(session) {
        this.session = session;
        this.url = '/baccarat/getnewresult';
    }

    async fetch() {
        try {
            const xsrfToken = this.session.getCookie('XSRF-TOKEN') || '';
            const headers = {
                Referer: `${CONFIG.BASE_URL}/ae/lobby`,
                Origin: CONFIG.BASE_URL,
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': xsrfToken,
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            };

            const formData = new URLSearchParams();
            formData.append('gameCode', 'ae');

            const { data } = await this.session.post(this.url, formData.toString(), { headers });
            if (!data?.data) return [];

            return data.data.map(item => ({
                table: item.table_name,
                resultStr: item.result,
                shoeId: item.shoeId || '',
                round: item.round || '',
            }));
        } catch (err) {
            logger.error(`Data fetch error: ${err.message}`);
            return [];
        }
    }
}

// ======================
// BaccaratPredictor (thêm SuperVIP)
// ======================
class BaccaratPredictor {
    constructor() {
        this.history = new Map();
        this.lastUpdate = null;
    }

    updateFromFetch(data) {
        let changed = false;
        data.forEach(({ table, resultStr }) => {
            const outcomes = this._parseResult(resultStr);
            const old = this.history.get(table);
            if (!old || old.length !== outcomes.length) {
                this.history.set(table, outcomes);
                changed = true;
            }
        });
        if (changed) this.lastUpdate = new Date().toISOString();
    }

    _parseResult(resultStr) {
        if (!resultStr) return [];
        return resultStr.toUpperCase().split('').filter(ch => 'BPT'.includes(ch));
    }

    getHistory(table) {
        return this.history.get(table) || [];
    }

    getAllTables() {
        return Array.from(this.history.keys());
    }

    predictStandard(table) {
        const hist = this.getHistory(table);
        if (hist.length === 0) return { prediction: null, confidence: 0, reason: 'no_data' };

        const counts = { B: 0, P: 0, T: 0 };
        hist.forEach(r => counts[r] = (counts[r] || 0) + 1);
        const total = hist.length;
        const prediction = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
        const confidence = (counts[prediction] / total * 100).toFixed(1);
        return {
            prediction,
            confidence: parseFloat(confidence),
            reason: `Xuất hiện ${counts[prediction]}/${total} lần`,
        };
    }

    predictVIP(table) {
        const hist = this.getHistory(table);
        if (hist.length < 3) return this.predictStandard(table);

        const transitions = new Map();
        for (let i = 0; i < hist.length - 2; i++) {
            const pair = hist[i] + hist[i + 1];
            const next = hist[i + 2];
            if (!transitions.has(pair)) transitions.set(pair, { B: 0, P: 0, T: 0 });
            const counter = transitions.get(pair);
            counter[next] = (counter[next] || 0) + 1;
        }

        const lastPair = hist.slice(-2).join('');
        const probs = transitions.get(lastPair);
        if (!probs) return this.predictStandard(table);

        const total = Object.values(probs).reduce((a, b) => a + b, 0);
        const prediction = Object.keys(probs).reduce((a, b) => probs[a] > probs[b] ? a : b);
        const confidence = ((probs[prediction] / total) * 100).toFixed(1);

        return {
            prediction,
            confidence: parseFloat(confidence),
            reason: `Pattern "${lastPair}" → tiếp theo thường là "${prediction}" (${probs[prediction]}/${total})`,
        };
    }

    // ======================
    // Super VIP Algorithm
    // ======================
    predictSuperVIP(table) {
        const hist = this.getHistory(table);

        if (hist.length < 10) {
            // fallback về standard khi quá ít dữ liệu
            return this.predictStandard(table);
        }

        const score = { B: 0, P: 0 };

        // 1. Tần suất gần đây (20 kết quả cuối)
        const recent = hist.slice(-20);
        const bCount = recent.filter(x => x === 'B').length;
        const pCount = recent.filter(x => x === 'P').length;
        if (bCount > pCount) score.B += 20;
        if (pCount > bCount) score.P += 20;

        // 2. Markov bậc 3
        if (hist.length >= 4) {
            const pattern = hist.slice(-3).join('');
            const nexts = { B: 0, P: 0 };
            for (let i = 0; i < hist.length - 3; i++) {
                const p = hist.slice(i, i + 3).join('');
                if (p === pattern) {
                    const next = hist[i + 3];
                    if (next === 'B') nexts.B++;
                    if (next === 'P') nexts.P++;
                }
            }
            if (nexts.B > nexts.P) score.B += 40;
            if (nexts.P > nexts.B) score.P += 40;
        }

        // 3. PingPong (BPBP / PBPB)
        const last4 = hist.slice(-4).join('');
        if (last4 === 'BPBP') score.B += 30;
        if (last4 === 'PBPB') score.P += 30;

        // 4. Bệt (streak >= 4 đảo chiều)
        const last = hist[hist.length - 1];
        let streak = 1;
        for (let i = hist.length - 2; i >= 0; i--) {
            if (hist[i] === last) streak++;
            else break;
        }
        if (streak >= 4) {
            if (last === 'B') score.P += 25;
            if (last === 'P') score.B += 25;
        }

        const prediction = score.B >= score.P ? 'B' : 'P';
        const totalScore = score.B + score.P || 1;
        const confidence = Math.round((Math.max(score.B, score.P) / totalScore) * 100);

        return {
            prediction,
            confidence,
            score,
            reason: `SuperVIP (Markov3 + tần suất + pingpong + bệt)`,
        };
    }
}

// ======================
// API Server (thêm endpoint SuperVIP & tự ping)
// ======================
function createApp(predictor) {
    const app = express();

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', '*');
        next();
    });

    // Dữ liệu thô
    app.get('/api/baccarat', (req, res) => {
        const tables = predictor.getAllTables().map(table => ({
            table,
            history: predictor.getHistory(table).join(''),
            lastUpdate: predictor.lastUpdate,
        }));
        res.json({ success: true, data: tables, lastUpdate: predictor.lastUpdate });
    });

    app.get('/api/baccarat/:table', (req, res) => {
        const table = req.params.table;
        const hist = predictor.getHistory(table);
        if (hist.length > 0) {
            res.json({ success: true, data: { table, history: hist.join('') } });
        } else {
            res.json({ success: false, message: `Không tìm thấy bàn ${table}` });
        }
    });

    // Dự đoán chuẩn
    app.get('/dudoan', (req, res) => {
        const tables = predictor.getAllTables();
        const predictions = tables.map(table => ({
            table,
            ...predictor.predictStandard(table),
        }));
        res.json({ success: true, data: predictions, lastUpdate: predictor.lastUpdate });
    });

    // Dự đoán VIP (Markov bậc 2)
    app.get('/dudoan/vip', (req, res) => {
        const tables = predictor.getAllTables();
        const predictions = tables.map(table => ({
            table,
            ...predictor.predictVIP(table),
        }));
        res.json({ success: true, data: predictions, lastUpdate: predictor.lastUpdate });
    });

    // Dự đoán Super VIP (Markov bậc 3 + heuristic)
    app.get('/dudoan/supervip', (req, res) => {
        const tables = predictor.getAllTables();
        const predictions = tables.map(table => ({
            table,
            ...predictor.predictSuperVIP(table),
        }));
        res.json({ success: true, data: predictions, lastUpdate: predictor.lastUpdate });
    });

    // Dự đoán cho một bàn (cả 3 loại)
    app.get('/dudoan/:table', (req, res) => {
        const table = req.params.table;
        const standard = predictor.predictStandard(table);
        const vip = predictor.predictVIP(table);
        const supervip = predictor.predictSuperVIP(table);
        res.json({
            success: true,
            data: {
                table,
                standard,
                vip,
                supervip,
            },
        });
    });

    return app;
}

// ======================
// Self-ping helper
// ======================
function startSelfPing(port) {
    const url = `http://127.0.0.1:${port}/api/baccarat`;
    setInterval(() => {
        http.get(url, (res) => {
            // Chỉ cần request thành công, không cần xử lý data
            res.resume();
        }).on('error', (e) => {
            logger.warn(`Self-ping failed: ${e.message}`);
        });
    }, CONFIG.SELF_PING_INTERVAL);
    logger.info(`🔄 Tự ping mỗi ${CONFIG.SELF_PING_INTERVAL / 1000}s để duy trì hoạt động`);
}

// ======================
// Main
// ======================
async function start() {
    logger.info('========================================');
    logger.info('BACCARAT API SERVER (Professional Edition)');
    logger.info('========================================');

    const session = new SessionManager();
    const auth = new AuthService(session);
    const fetcher = new BaccaratFetcher(session);
    const predictor = new BaccaratPredictor();

    logger.info('Đang đăng nhập...');
    const loginOk = await auth.login();
    if (!loginOk) {
        logger.error('Đăng nhập thất bại.');
        process.exit(1);
    }
    logger.info('Đăng nhập thành công');

    logger.info('Vào lobby...');
    await auth.goToLobby();
    logger.info('Đã vào lobby');

    const firstData = await fetcher.fetch();
    predictor.updateFromFetch(firstData);
    logger.info(`Đã lấy ${predictor.getAllTables().length} bàn dữ liệu ban đầu`);

    // Vòng lặp cập nhật
    (async function updateLoop() {
        while (true) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.FETCH_INTERVAL));
            try {
                const newData = await fetcher.fetch();
                predictor.updateFromFetch(newData);
            } catch (e) {
                logger.error(`Update loop error: ${e.message}`);
            }
        }
    })();

    const app = createApp(predictor);
    const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        logger.info(`🚀 API đang chạy tại http://localhost:${CONFIG.PORT}`);
        logger.info(`   /dudoan               - Dự đoán tiêu chuẩn`);
        logger.info(`   /dudoan/vip           - Dự đoán VIP (Markov bậc 2)`);
        logger.info(`   /dudoan/supervip      - Dự đoán Siêu VIP (Markov bậc 3 + heuristic)`);
        logger.info(`   /dudoan/:table        - Dự đoán cả 3 loại cho một bàn`);
        logger.info(`   /api/baccarat         - Dữ liệu thô`);
        logger.info(`⏰ Tự động cập nhật mỗi ${CONFIG.FETCH_INTERVAL / 1000}s`);
    });

    // Tự ping để không bị sleep (nếu chạy trên nền tảng miễn phí như Render, Heroku)
    startSelfPing(CONFIG.PORT);
}

start().catch(err => {
    logger.error(`Khởi động thất bại: ${err.message}`);
    process.exit(1);
});