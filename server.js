const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();

const PORT = process.env.PORT || 3000;

// ===============================
// НАЛАШТУВАННЯ
// ===============================

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_ID = process.env.ADMIN_ID || "";

const BOT_USERNAME = "nlkaman_bot";
const CHANNEL_USERNAME = "@nlkaman1";


// ===============================
// ФАЙЛ БАЗИ
// ===============================

const DATA_FILE = path.join(__dirname, "data.json");

let data = {
  users: {},
  wins: [],
  claims: []
};


if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    console.log("Помилка читання data.json");
  }
}


function saveData() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(data, null, 2)
  );
}


// ===============================
// EXPRESS
// ===============================

app.use(express.json());

app.use(express.static(
  path.join(__dirname, "web")
));


// ===============================
// TELEGRAM API
// ===============================

function telegram(method, params = {}) {

  return new Promise((resolve, reject) => {

    if (!BOT_TOKEN) {
      return reject(
        new Error("BOT_TOKEN не встановлений")
      );
    }

    const body = JSON.stringify(params);

    const request = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${BOT_TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      response => {

        let result = "";

        response.on("data", chunk => {
          result += chunk;
        });

        response.on("end", () => {

          try {

            const json = JSON.parse(result);

            if (!json.ok) {
              return reject(
                new Error(json.description || "Telegram API error")
              );
            }

            resolve(json.result);

          } catch (error) {
            reject(error);
          }

        });

      }
    );

    request.on("error", reject);

    request.write(body);
    request.end();
  });
}


// ===============================
// КОРИСТУВАЧ
// ===============================

function createUser(userId, user = {}) {

  const id = String(userId);

  if (!data.users[id]) {

    data.users[id] = {

      id: userId,

      username: user.username || "",

      first_name: user.first_name || "Користувач",

      tickets: 0,

      referrals: 0,

      invitedBy: null,

      spins: 0,

      wins: []

    };

    saveData();
  }

  return data.users[id];
}


// ===============================
// ПЕРЕВІРКА ПІДПИСКИ
// ===============================

async function checkSubscription(userId) {

  try {

    const member = await telegram(
      "getChatMember",
      {
        chat_id: CHANNEL_USERNAME,
        user_id: userId
      }
    );

    const allowed = [
      "creator",
      "administrator",
      "member"
    ];

    return allowed.includes(member.status);

  } catch (error) {

    console.log(
      "Помилка перевірки підписки:",
      error.message
    );

    return false;
  }
}


// ===============================
// START / РЕФЕРАЛИ
// ===============================

async function handleStart(message) {

  const user = message.from;

  const userId = String(user.id);

  const text =
    message.text || "";

  const parts =
    text.split(" ");

  const startParameter =
    parts[1] || "";


  const existing =
    data.users[userId];


  createUser(user.id, user);


  // Якщо користувач новий
  // і прийшов за реферальним посиланням

  if (
    !existing &&
    startParameter.startsWith("ref_")
  ) {

    const referrerId =
      startParameter.replace("ref_", "");


    if (
      referrerId !== userId &&
      data.users[referrerId]
    ) {

      data.users[userId].invitedBy =
        referrerId;

      saveData();

      // Перевіряємо підписку нового користувача

      const subscribed =
        await checkSubscription(user.id);


      if (subscribed) {

        data.users[referrerId].referrals += 1;

        data.users[referrerId].tickets += 1;

        saveData();

        try {

          await telegram(
            "sendMessage",
            {
              chat_id: referrerId,

              text:
                "🎉 Новий реферал!\n\n" +
                "Ти отримав +1 🎟 квиток."
            }
          );

        } catch {}
      }
    }
  }


  const keyboard = {

    inline_keyboard: [

      [
        {
          text: "🎮 ВІДКРИТИ ГРУ",
          web_app: {
            url:
              getWebAppUrl()
          }
        }
      ],

      [
        {
          text: "📢 ПІДПИСАТИСЯ НА КАНАЛ",
          url:
            "https://t.me/nlkaman1"
        }
      ]

    ]

  };


  await telegram(
    "sendMessage",
    {
      chat_id: user.id,

      text:
        `🎁 Вітаємо, ${user.first_name || "друже"}!\n\n` +
        `Тут ти можеш отримувати 🎟 квитки,\n` +
        `крутити 🎡 колесо та вигравати подарунки.\n\n` +
        `Запрошуй друзів та отримуй +1 квиток за кожного нового учасника!`,

      reply_markup: keyboard
    }
  );
}


// ===============================
// URL MINI APP
// ===============================

function getWebAppUrl() {

  if (process.env.WEBAPP_URL) {
    return process.env.WEBAPP_URL;
  }

  return "";
}


// ===============================
// TELEGRAM UPDATES
// ===============================

let lastUpdateId = 0;


async function startPolling() {

  if (!BOT_TOKEN) {

    console.log(
      "⚠️ BOT_TOKEN не встановлений."
    );

    return;
  }


  console.log(
    "🤖 Telegram bot polling запущено"
  );


  while (true) {

    try {

      const updates =
        await telegram(
          "getUpdates",
          {
            offset:
              lastUpdateId + 1,

            timeout: 25
          }
        );


      for (const update of updates) {

        lastUpdateId =
          update.update_id;


        if (update.message) {

          if (
            update.message.text &&
            update.message.text.startsWith("/start")
          ) {

            await handleStart(
              update.message
            );
          }

        }

      }

    } catch (error) {

      console.log(
        "Polling error:",
        error.message
      );

      await new Promise(
        resolve =>
          setTimeout(resolve, 3000)
      );
    }
  }
}


// ===============================
// API КОРИСТУВАЧА
// ===============================

app.get(
  "/api/user/:id",
  async (req, res) => {

    const id =
      String(req.params.id);

    const user =
      data.users[id];

    if (!user) {

      return res.json({
        success: false
      });
    }

    res.json({

      success: true,

      user: {

        id: user.id,

        username:
          user.username,

        first_name:
          user.first_name,

        tickets:
          user.tickets,

        referrals:
          user.referrals,

        spins:
          user.spins
      }

    });
  }
);


// ===============================
// API ПЕРЕВІРКИ ПІДПИСКИ
// ===============================

app.post(
  "/api/check-subscription",
  async (req, res) => {

    const {
      userId
    } = req.body;


    if (!userId) {

      return res.status(400).json({
        success: false,
        message: "Немає userId"
      });
    }


    const subscribed =
      await checkSubscription(userId);


    res.json({

      success: true,

      subscribed

    });

  }
);


// ===============================
// API ЛІДЕРБОРДУ
// ===============================

app.get(
  "/api/leaderboard",
  (req, res) => {

    const users =
      Object.values(data.users);


    users.sort(
      (a, b) =>
        b.referrals - a.referrals
    );


    const leaderboard =
      users.slice(0, 20).map(
        (user, index) => ({

          place:
            index + 1,

          id:
            user.id,

          username:
            user.username,

          first_name:
            user.first_name,

          referrals:
            user.referrals,

          tickets:
            user.tickets

        })
      );


    res.json({
      success: true,
      leaderboard
    });

  }
);


// ===============================
// ПРИЗИ
// ===============================

const PRIZES = [

  {
    id: "gift",
    name: "NFT Gift",
    icon: "🎁"
  },

  {
    id: "stars",
    name: "Telegram Stars",
    icon: "⭐"
  },

  {
    id: "nft",
    name: "NFT",
    icon: "💎"
  },

  {
    id: "ticket",
    name: "+1 квиток",
    icon: "🎟"
  }

];


// ===============================
// КОЛЕСО
// ===============================

app.post(
  "/api/spin",
  async (req, res) => {

    const {
      userId
    } = req.body;


    if (!userId) {

      return res.status(400).json({

        success: false,

        message:
          "Не вказаний користувач"

      });
    }


    const id =
      String(userId);


    const user =
      data.users[id];


    if (!user) {

      return res.status(404).json({

        success: false,

        message:
          "Користувача не знайдено"

      });
    }


    // Перевірка підписки

    const subscribed =
      await checkSubscription(userId);


    if (!subscribed) {

      return res.json({

        success: false,

        reason:
          "not_subscribed",

        message:
          "Спочатку підпишись на канал @nlkaman1"

      });
    }


    // Перевірка квитків

    if (user.tickets < 1) {

      return res.json({

        success: false,

        reason:
          "no_tickets",

        message:
          "Недостатньо квитків"

      });
    }


    // Списуємо квиток

    user.tickets -= 1;

    user.spins += 1;


    // Випадковий приз

    const prize =
      PRIZES[
        Math.floor(
          Math.random() *
          PRIZES.length
        )
      ];


    // Якщо це квиток

    if (prize.id === "ticket") {

      user.tickets += 1;
    }


    const win = {

      id:
        Date.now(),

      userId:
        user.id,

      prizeId:
        prize.id,

      prizeName:
        prize.name,

      prizeIcon:
        prize.icon,

      date:
        new Date().toISOString(),

      claimed:
        false

    };


    user.wins.push(win);

    data.wins.push(win);

    saveData();


    res.json({

      success: true,

      prize: {

        id:
          prize.id,

        name:
          prize.name,

        icon:
          prize.icon

      },

      tickets:
        user.tickets,

      winId:
        win.id

    });

  }
);


// ===============================
// ЗАЯВКА НА ОТРИМАННЯ ПРИЗУ
// ===============================

app.post(
  "/api/claim",
  async (req, res) => {

    const {
      userId,
      winId
    } = req.body;


    if (!userId || !winId) {

      return res.status(400).json({

        success: false,

        message:
          "Недостатньо даних"

      });
    }


    const win =
      data.wins.find(
        w =>
          String(w.id) === String(winId) &&
          String(w.userId) === String(userId)
      );


    if (!win) {

      return res.status(404).json({

        success: false,

        message:
          "Виграш не знайдено"

      });
    }


    if (win.claimed) {

      return res.json({

        success: false,

        message:
          "Заявка вже була створена"

      });
    }


    const claim = {

      id:
        Date.now(),

      winId:
        win.id,

      userId:
        userId,

      prize:
        win.prizeName,

      status:
        "pending",

      date:
        new Date().toISOString()

    };


    win.claimed = true;

    data.claims.push(claim);

    saveData();


    // Повідомлення адміну

    if (ADMIN_ID) {

      try {

        await telegram(
          "sendMessage",
          {
            chat_id:
              ADMIN_ID,

            text:
              `🎁 НОВА ЗАЯВКА НА ПРИЗ\n\n` +
              `👤 User ID: ${userId}\n` +
              `🎁 Приз: ${win.prizeName}\n` +
              `🆔 Win ID: ${win.id}\n\n` +
              `📅 ${new Date().toLocaleString("uk-UA")}`
          }
        );

      } catch (error) {

        console.log(
          "Не вдалося повідомити адміна:",
          error.message
        );

      }
    }


    res.json({

      success: true,

      message:
        "Заявку відправлено адміну"

    });

  }
);


// ===============================
// АДМІН — СПИСОК ЗАЯВОК
// ===============================

app.get(
  "/api/admin/claims",
  (req, res) => {

    if (
      !ADMIN_ID ||
      String(req.query.adminId) !==
      String(ADMIN_ID)
    ) {

      return res.status(403).json({

        success: false,

        message:
          "Доступ заборонено"

      });
    }


    res.json({

      success: true,

      claims:
        data.claims

    });

  }
);


// ===============================
// ГОЛОВНА
// ===============================

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "web",
        "index.html"
      )
    );

  }
);


// ===============================
// ЗАПУСК
// ===============================

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 Server started on port ${PORT}`
    );

    startPolling();

  }
);
