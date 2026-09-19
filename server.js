import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new Database('bot.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// ==================== DATABASE ====================

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    tickets INTEGER NOT NULL DEFAULT 0,
    invited_count INTEGER NOT NULL DEFAULT 0,
    referred_by INTEGER,
    referral_rewarded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    prize_id INTEGER,
    prize_name TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    spin_id INTEGER NOT NULL,
    prize_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// Початкові призи
const prizeCount = db
    .prepare('SELECT COUNT(*) AS count FROM prizes')
    .get().count;

if (prizeCount === 0) {
    const addPrize = db.prepare(`
        INSERT INTO prizes (name, emoji, weight)
        VALUES (?, ?, ?)
    `);

    addPrize.run('100 ⭐', '⭐', 1);
    addPrize.run('50 ⭐', '⭐', 2);
    addPrize.run('Telegram Gift', '🎁', 3);
    addPrize.run('Спробуй ще', '🍀', 10);
}

// ==================== USERS ====================

function saveUser(user) {
    const existing = db
        .prepare('SELECT id FROM users WHERE id = ?')
        .get(user.id);

    if (!existing) {
        db.prepare(`
            INSERT INTO users
            (id, username, first_name)
            VALUES (?, ?, ?)
        `).run(
            user.id,
            user.username || null,
            user.first_name || ''
        );
    } else {
        db.prepare(`
            UPDATE users
            SET username = ?, first_name = ?
            WHERE id = ?
        `).run(
            user.username || null,
            user.first_name || '',
            user.id
        );
    }

    return db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(user.id);
}

// ==================== TELEGRAM AUTH ====================

function verifyTelegramData(initData) {

    if (!initData) {
        throw new Error('Telegram authorization missing');
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash) {
        throw new Error('Hash missing');
    }

    params.delete('hash');

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(process.env.BOT_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) {
        throw new Error('Invalid Telegram data');
    }

    const user = JSON.parse(params.get('user'));

    return user;
}

// ==================== AUTH MIDDLEWARE ====================

function auth(req, res, next) {

    try {

        const user = verifyTelegramData(
            req.headers['x-telegram-init-data']
        );

        req.telegramUser = user;

        saveUser(user);

        next();

    } catch (error) {

        res.status(401).json({
            error: 'Потрібно відкрити Mini App через Telegram'
        });

    }
}

// ==================== CHANNEL CHECK ====================

async function checkSubscription(userId) {

    try {

        const member = await bot.telegram.getChatMember(
            process.env.CHANNEL_ID,
            userId
        );

        return [
            'creator',
            'administrator',
            'member'
        ].includes(member.status);

    } catch (error) {

        console.log(
            'Subscription check error:',
            error.message
        );

        return false;
    }
}

// ==================== REFERRALS ====================
// Реферальна нагорода.
// Квиток видається тільки після першого входу в Mini App.

async function processReferral(userId) {

    const user = db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(userId);

    if (!user) return;

    // Немає запрошувача
    if (!user.referred_by) return;

    // Нагорода вже була видана
    if (user.referral_rewarded === 1) return;

    // Перевіряємо підписку
    const subscribed = await checkSubscription(userId);

    if (!subscribed) return;

    db.transaction(() => {

        // +1 квиток запрошувачу
        db.prepare(`
            UPDATE users
            SET tickets = tickets + 1,
                invited_count = invited_count + 1
            WHERE id = ?
        `).run(user.referred_by);

        // Позначаємо реферала як зарахованого
        db.prepare(`
            UPDATE users
            SET referral_rewarded = 1
            WHERE id = ?
        `).run(userId);

    })();

    console.log(
        `Referral rewarded after Mini App entry: ${user.referred_by} -> ${userId}`
    );
}
// ==================== BOT START ====================

bot.start(async (ctx) => {

    const user = saveUser(ctx.from);

    const parts = ctx.message.text.split(' ');
    const payload = parts[1];

    // referral link:
    // /start ref_123456

    if (
        payload &&
        payload.startsWith('ref_')
    ) {

        const referrerId = Number(
            payload.replace('ref_', '')
        );

        if (
            referrerId &&
            referrerId !== user.id &&
            !user.referred_by
        ) {

            const referrer = db
                .prepare(
                    'SELECT id FROM users WHERE id = ?'
                )
                .get(referrerId);

            if (referrer) {

                db.prepare(`
                    UPDATE users
                    SET referred_by = ?
                    WHERE id = ?
                `).run(
                    referrerId,
                    user.id
                );
            }
        }
    }

    // Перевіряємо, можливо користувач уже підписаний

    await ctx.reply(
    `🔒 Для запуску гри потрібно бути підписаним на канал.`,
        {
            reply_markup: {
    inline_keyboard: [

        [
    {
        text: '📢 ПІДПИСАТИСЯ НА КАНАЛ',
        url: process.env.CHANNEL_URL
    }
],

[
    {
        text: '🔄 ПЕРЕВІРИТИ ПІДПИСКУ',
        callback_data: 'check_subscription'
    }
]

    ]
}
}
);
});


// ==================== CHECK SUBSCRIPTION ====================

bot.action('check_subscription', async (ctx) => {

    const userId = ctx.from.id;

    const subscribed =
        await checkSubscription(userId);

    await ctx.answerCbQuery();

    if (!subscribed) {

        return ctx.reply(
            `❌ Ви не підписані на канал!`,
            {
                reply_markup: {
                    inline_keyboard: [

                        [
                            {
                                text: '📢 ПІДПИСАТИСЯ НА КАНАЛ',
                                url: process.env.CHANNEL_URL
                            }
                        ],

                        [
                            {
                                text: '🔄 ПЕРЕВІРИТИ ПІДПИСКУ',
                                callback_data: 'check_subscription'
                            }
                        ]

                    ]
                }
            }
        );
    }

    await processReferral(userId);

    return ctx.reply(
    `🎉 Вітаємо! Гра доступна 👇`,
    {
        reply_markup: {
            inline_keyboard: [

                [
                    {
                        text: '🎰 ГРАТИ',
                        web_app: {
                            url: process.env.WEBAPP_URL
                        }
                    }
                ]

            ]
        }
    }
);
});

// ==================== USER INFO ====================
app.get('/api/me', auth, async (req, res) => {

    await processReferral(req.telegramUser.id);

    const user = db.prepare(`
        SELECT
            id,
            username,
            first_name,
            tickets,
            invited_count
        FROM users
        WHERE id = ?
    `).get(req.telegramUser.id);

    const subscribed =
        await checkSubscription(req.telegramUser.id);

    res.json({
        user,
        subscribed,
        botUsername: process.env.BOT_USERNAME
    });
});

// ==================== LEADERBOARD ====================

app.get('/api/leaderboard', (req, res) => {

    const users = db.prepare(`
        SELECT
            username,
            first_name,
            invited_count
        FROM users
        ORDER BY invited_count DESC
        LIMIT 50
    `).all();

    res.json(users);
});

// ==================== SPIN ====================

function getRandomPrize() {

    const prizes = db.prepare(`
        SELECT *
        FROM prizes
        WHERE active = 1
    `).all();

    const totalWeight = prizes.reduce(
        (sum, prize) => sum + prize.weight,
        0
    );

    let random =
        Math.random() * totalWeight;

    for (const prize of prizes) {

        random -= prize.weight;

        if (random < 0) {
            return prize;
        }
    }

    return prizes[prizes.length - 1];
}

app.post('/api/spin', auth, async (req, res) => {

    const userId = req.telegramUser.id;

    // Обов'язкова підписка
    const subscribed =
        await checkSubscription(userId);

    if (!subscribed) {

        return res.status(403).json({
            error:
                '❌ Спочатку підпишіться на @nlkaman1'
        });
    }

    // Реферальна нагорода
    await processReferral(userId);

    const user = db.prepare(`
        SELECT tickets
        FROM users
        WHERE id = ?
    `).get(userId);

    if (!user || user.tickets < 1) {

        return res.status(400).json({
            error: '🎟️ У тебе немає квитків'
        });
    }

    const prize = getRandomPrize();

    const spin = db.transaction(() => {

        // -1 квиток
        db.prepare(`
            UPDATE users
            SET tickets = tickets - 1
            WHERE id = ?
        `).run(userId);

        // Зберігаємо виграш
        const result = db.prepare(`
            INSERT INTO spins
            (user_id, prize_id, prize_name)
            VALUES (?, ?, ?)
        `).run(
            userId,
            prize.id,
            `${prize.emoji} ${prize.name}`
        );

        // Якщо це справжній приз —
        // створюємо заявку на виведення
        if (prize.name !== 'Спробуй ще') {

            db.prepare(`
                INSERT INTO withdrawals
                (user_id, spin_id, prize_name)
                VALUES (?, ?, ?)
            `).run(
                userId,
                result.lastInsertRowid,
                `${prize.emoji} ${prize.name}`
            );
        }

        return result.lastInsertRowid;

    })();

    const updatedUser = db.prepare(`
        SELECT tickets
        FROM users
        WHERE id = ?
    `).get(userId);

    res.json({
        success: true,
        spinId: spin,
        prize: `${prize.emoji} ${prize.name}`,
        tickets: updatedUser.tickets
    });
});

// ==================== USER HISTORY ====================

app.get('/api/history', auth, (req, res) => {

    const history = db.prepare(`
        SELECT
            id,
            prize_name,
            created_at
        FROM spins
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 50
    `).all(req.telegramUser.id);

    res.json(history);
});

// ==================== ADMIN ====================

function checkAdmin(req) {

    return String(req.query.admin_id) ===
        String(process.env.ADMIN_ID);
}

// Перегляд заявок
app.get('/api/admin/withdrawals', (req, res) => {

    if (!checkAdmin(req)) {

        return res.status(403).json({
            error: 'Access denied'
        });
    }

    const withdrawals = db.prepare(`
        SELECT
            w.id,
            w.user_id,
            w.prize_name,
            w.status,
            w.created_at,
            u.username,
            u.first_name
        FROM withdrawals w
        JOIN users u
        ON u.id = w.user_id
        ORDER BY w.id DESC
    `).all();

    res.json(withdrawals);
});

// Зміна статусу
app.post(
    '/api/admin/withdrawals/:id/status',
    (req, res) => {

        if (
            String(req.body.admin_id) !==
            String(process.env.ADMIN_ID)
        ) {
            return res.status(403).json({
                error: 'Access denied'
            });
        }

        const allowed = [
            'pending',
            'paid',
            'rejected'
        ];

        if (!allowed.includes(req.body.status)) {

            return res.status(400).json({
                error: 'Invalid status'
            });
        }

        db.prepare(`
            UPDATE withdrawals
            SET status = ?
            WHERE id = ?
        `).run(
            req.body.status,
            req.params.id
        );

        res.json({
            success: true
        });
    }
);

// ==================== SERVER ====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        `Server started on port ${PORT}`
    );

});

bot.launch();

console.log('Telegram bot started');

process.once(
    'SIGINT',
    () => bot.stop('SIGINT')
);

process.once(
    'SIGTERM',
    () => bot.stop('SIGTERM')
);
