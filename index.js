require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; // ej: -100xxxxx o @tugrupo
const CHANNEL_INVITE_LINK = process.env.CHANNEL_INVITE_LINK; // fallback
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const PORT = Number(process.env.PORT || 3000);

// suscripción y referidos
const SUBSCRIPTION_DAYS = 30;
const REFERRAL_BONUS_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- CHEQUEOS BÁSICOS ----------
if (!TG_BOT_TOKEN) {
  console.error('❌ Falta TG_BOT_TOKEN en .env');
  process.exit(1);
}
if (!CHANNEL_ID && !CHANNEL_INVITE_LINK) {
  console.error('❌ Tenés que definir CHANNEL_ID o CHANNEL_INVITE_LINK en .env');
  process.exit(1);
}

// ---------- DB JSON SIMPLE ----------
const DB_PATH = path.join(__dirname, 'db.json');

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { users: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function ensureUser(db, userId) {
  if (!db.users[userId]) {
    db.users[userId] = {
      expiresAt: null,
      referredBy: null,
      referralsCount: 0,
      firstPaymentDone: false,
      totalPaidCycles: 0,
      bonusDays: 0
    };
  }
  return db.users[userId];
}

function getNow() {
  return Date.now();
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ---------- BOT ----------
const bot = new Telegraf(TG_BOT_TOKEN);
let BOT_USERNAME = process.env.BOT_USERNAME || '';

// helpers callback
function buildCallback(action, userId) {
  return `${action}:${userId}`;
}
function parseCallback(data) {
  const [action, userId] = data.split(':');
  return { action, userId: Number(userId) };
}

// genera código de referido
function getReferralCode(userId) {
  return `ref_${userId}`;
}

// ---------- LÓGICA DE SUSCRIPCIONES ----------

// otorgar suscripción al usuario (por pago)
async function grantSubscription(userId, baseDays = SUBSCRIPTION_DAYS) {
  const db = loadDb();
  const now = getNow();
  const user = ensureUser(db, userId);

  const bonusDays = user.bonusDays || 0;
  const totalDays = baseDays + bonusDays;
  user.bonusDays = 0; // consumimos bonus acumulado

  if (user.expiresAt && user.expiresAt > now) {
    // extiende desde la fecha de vencimiento actual
    user.expiresAt += totalDays * DAY_MS;
  } else {
    // nuevo o vencido: arranca desde ahora
    user.expiresAt = now + totalDays * DAY_MS;
  }

  user.totalPaidCycles = (user.totalPaidCycles || 0) + 1;

  saveDb(db);
  return user.expiresAt;
}

// lógica de referidos: se llama al aprobar el PRIMER pago de un usuario
async function handleReferralOnFirstPayment(userId) {
  const db = loadDb();
  const user = ensureUser(db, userId);

  if (user.firstPaymentDone) {
    // ya se contó este usuario antes, nada que hacer
    return;
  }

  user.firstPaymentDone = true;

  if (user.referredBy && db.users[user.referredBy]) {
    const refUser = db.users[user.referredBy];

    refUser.referralsCount = (refUser.referralsCount || 0) + 1;

    const now = getNow();
    const extraMs = REFERRAL_BONUS_DAYS * DAY_MS;

    if (refUser.expiresAt && refUser.expiresAt > now) {
      refUser.expiresAt += extraMs;
    } else {
      // si no tenía suscripción activa, arranca desde ahora
      refUser.expiresAt = now + extraMs;
    }

    saveDb(db);

    // notificamos al referente
    try {
      await bot.telegram.sendMessage(
        user.referredBy,
        `🎁 Uno de tus referidos realizó su primera compra.\n\n` +
          `Se te acreditaron *${REFERRAL_BONUS_DAYS} días extra* de acceso al canal.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('Error notificando al referido:', e.message);
    }
  } else {
    saveDb(db);
  }
}

// genera link único de invitación
async function createUniqueInviteLink(userId, expiresAt) {
  if (!CHANNEL_ID) return CHANNEL_INVITE_LINK;

  try {
    const nowSec = Math.floor(getNow() / 1000);
    const expiresSec = Math.floor(expiresAt / 1000);

    // el link dura como máximo 24h, pero nunca más allá del vencimiento del usuario
    const maxLifetimeSec = 24 * 60 * 60;
    const expireDate = Math.min(expiresSec, nowSec + maxLifetimeSec);

    const invite = await bot.telegram.createChatInviteLink(CHANNEL_ID, {
      expire_date: expireDate,
      member_limit: 1
    });

    return invite.invite_link;
  } catch (e) {
    console.error('Error creando invite único, uso fallback:', e.message);
    return CHANNEL_INVITE_LINK;
  }
}

// check expirados y expulsar
async function checkExpirations() {
  if (!CHANNEL_ID) return;

  const db = loadDb();
  const now = getNow();
  let changed = false;

  for (const [userIdStr, data] of Object.entries(db.users)) {
    const userId = Number(userIdStr);
    if (!data.expiresAt) continue;

    if (data.expiresAt <= now) {
      // vencido
      console.log(`⏳ Suscripción vencida para ${userId}, expulsando...`);
      try {
        // expulsar y permitir reingreso futuro
        await bot.telegram.banChatMember(CHANNEL_ID, userId);
        await bot.telegram.unbanChatMember(CHANNEL_ID, userId);
      } catch (e) {
        console.error('Error expulsando usuario vencido:', e.message);
      }

      // marcar como expirado
      db.users[userIdStr].expiresAt = null;
      changed = true;

      // avisarle al usuario
      try {
        await bot.telegram.sendMessage(
          userId,
          '⏳ Tu suscripción al canal VIP venció.\n\n' +
            'Si querés volver a entrar, pagá nuevamente y enviá el comprobante al bot.'
        );
      } catch (e) {
        console.error('Error avisando vencimiento al usuario:', e.message);
      }
    }
  }

  if (changed) saveDb(db);
}

// ---------- COMANDOS ----------

// /start (puede venir con payload de referido)
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username ? '@' + ctx.from.username : '(sin username)';
  const payload = ctx.startPayload; // ej: "ref_123456"

  const db = loadDb();
  const user = ensureUser(db, userId);

  // manejo de referido
  if (payload && payload.startsWith('ref_')) {
    const refId = Number(payload.replace('ref_', ''));
    if (refId && refId !== userId) {
      if (!user.referredBy) {
        user.referredBy = refId;
        saveDb(db);
        try {
          await bot.telegram.sendMessage(
            refId,
            `👥 Nuevo usuario entró con tu código de referido: ${username} (ID: ${userId}).`
          );
        } catch (e) {
          console.error('Error notificando nuevo referido:', e.message);
        }
      }
    }
  }

  await ctx.reply(
    '👋 Bienvenido.\n\n' +
      'Este bot gestiona el acceso a un canal VIP pago.\n\n' +
      '1️⃣ Pagá *5 USDT (TRC20)* usando /pagar\n' +
      '2️⃣ Enviá el comprobante (captura o TXID)\n' +
      '3️⃣ Un admin revisa el pago\n' +
      '4️⃣ Si está todo ok, recibís un link de acceso *único* al canal\n\n' +
      'Podés ver el estado de tu suscripción con /status\n' +
      'Y tu sistema de referidos con /referidos',
    { parse_mode: 'Markdown' }
  );
});

// /whoami para sacar ADMIN_CHAT_ID
bot.command('whoami', async (ctx) => {
  await ctx.reply(
    `🆔 Tu chat ID es: ${ctx.from.id}\n` +
      'Ponelo en ADMIN_CHAT_ID en tu archivo .env (y redeploy).'
  );
});

// /status
bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  const db = loadDb();
  const user = db.users[userId];

  if (!user || !user.expiresAt) {
    await ctx.reply('⚠️ No tenés una suscripción activa actualmente.');
    return;
  }

  const now = getNow();
  const msLeft = user.expiresAt - now;
  if (msLeft <= 0) {
    await ctx.reply(
      '⏳ Tu suscripción ya está vencida.\nEscribí /pagar para renovar.'
    );
    return;
  }

  const daysLeft = Math.ceil(msLeft / DAY_MS);
  await ctx.reply(
    `✅ Suscripción activa.\n\n` +
      `Vence el: *${formatDate(user.expiresAt)}*\n` +
      `Te quedan aproximadamente *${daysLeft} días* de acceso.`,
    { parse_mode: 'Markdown' }
  );
});

// /referidos
bot.command('referidos', async (ctx) => {
  const userId = ctx.from.id;
  const db = loadDb();
  const user = ensureUser(db, userId);

  const code = getReferralCode(userId);
  const username = BOT_USERNAME || 'TuBot';
  const referralLink = `https://t.me/${username}?start=${code}`;

  await ctx.reply(
    `👥 *Programa de referidos*\n\n` +
      `Tu código: \`${code}\`\n\n` +
      `Tu link para invitar: ${referralLink}\n\n` +
      `Cada persona que use tu link y pague su primera suscripción te suma *${REFERRAL_BONUS_DAYS} días extra* de acceso.\n\n` +
      `Referidos confirmados: *${user.referralsCount || 0}*`,
    { parse_mode: 'Markdown' }
  );
});

// /admin básico: solo muestra contadores
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_CHAT_ID) return;

  const db = loadDb();
  const totalUsers = Object.keys(db.users).length;
  const now = getNow();
  let actives = 0;
  for (const u of Object.values(db.users)) {
    if (u.expiresAt && u.expiresAt > now) actives++;
  }

  await ctx.reply(
    `👑 Panel admin:\n\n` +
      `Usuarios registrados: ${totalUsers}\n` +
      `Suscripciones activas: ${actives}`
  );
});

// /pagar – instrucciones + QR
bot.command('pagar', async (ctx) => {
  const qrPath = path.join(__dirname, 'QR-binance.png');

  await ctx.reply(
    `💳 *Instrucciones de pago en USDT (TRC20)*\n\n` +
      `➡️ Monto: *5 USDT*\n` +
      `➡️ Red: *TRC20*\n\n` +
      `📥 Dirección:\n\`TGLwGZwvyvtYDqPGvaWF4dN4LKjYhuxAoY\`\n\n` +
      `📸 Luego de enviar, mandá acá la captura de la transacción o el TXID para revisión.`,
    { parse_mode: 'Markdown' }
  );

  try {
    await ctx.replyWithPhoto(
      { source: qrPath },
      { caption: '📌 Escaneá este QR para pagar 5 USDT (TRC20)' }
    );
  } catch (e) {
    console.error('Error enviando QR:', e.message);
  }
});

// ---------- RECIBO DE COMPROBANTES (SOLO PRIVADO) ----------
bot.on(['photo', 'document', 'text'], async (ctx, next) => {
  // ignorar mensajes de otros bots
  if (ctx.from.is_bot) return;

  // solo aceptar comprobantes en chat privado
  if (ctx.chat.type !== 'private') {
    return next();
  }

  // ignorar textos que sean comandos (/start, /status, etc)
  if (ctx.message.text && ctx.message.text.startsWith('/')) {
    return next();
  }

  const userId = ctx.from.id;
  const username = ctx.from.username ? '@' + ctx.from.username : '(sin username)';
  const name =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
    '(sin nombre)';

  if (!ADMIN_CHAT_ID) {
    await ctx.reply(
      '⚠️ El bot aún no está configurado con un administrador. Avisale al dueño.'
    );
    return;
  }

  await ctx.reply('📩 Recibí tu comprobante. Un admin lo va a revisar.');

  const caption =
    `🧾 *Comprobante recibido*\n\n` +
    `👤 Usuario: ${name} (${username})\n` +
    `🆔 ID: ${userId}\n\n` +
    `Revisá el pago en Binance y decidí si aprobás.\n\n` +
    `💡 Recordá: suscripción = ${SUBSCRIPTION_DAYS} días.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Aprobar y enviar acceso', buildCallback('approve', userId))],
    [Markup.button.callback('❌ Rechazar', buildCallback('reject', userId))]
  ]);

  if (ctx.message.photo) {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, fileId, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  } else if (ctx.message.document) {
    const fileId = ctx.message.document.file_id;
    await ctx.telegram.sendDocument(ADMIN_CHAT_ID, fileId, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: keyboard.reply_markup
    });
  } else if (ctx.message.text) {
    await ctx.telegram.sendMessage(
      ADMIN_CHAT_ID,
      caption + `\n\n📌 *TXID / mensaje enviado:* ${ctx.message.text}`,
      {
        parse_mode: 'Markdown',
        reply_markup: keyboard.reply_markup
      }
    );
  }
});

// ---------- CALLBACKS (APROBAR / RECHAZAR) ----------
bot.on('callback_query', async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const fromAdminId = ctx.from.id;

    if (fromAdminId !== ADMIN_CHAT_ID) {
      await ctx.answerCbQuery('No tenés permisos para usar este botón.', {
        show_alert: true
      });
      return;
    }

    const { action, userId } = parseCallback(data);
    const msg = ctx.callbackQuery.message;

    // helper para actualizar mensaje del admin según sea media o texto
    const appendStatus = async (extra) => {
      if (msg.photo || msg.document) {
        const oldCaption = msg.caption || '';
        await ctx.editMessageCaption(oldCaption + extra, { parse_mode: 'Markdown' });
      } else if (msg.text) {
        const oldText = msg.text || '';
        await ctx.editMessageText(oldText + extra, { parse_mode: 'Markdown' });
      }
    };

    if (action === 'approve') {
      // 1) otorgar suscripción
      const expiresAt = await grantSubscription(userId, SUBSCRIPTION_DAYS);

      // 2) manejar referidos (primera compra)
      await handleReferralOnFirstPayment(userId);

      // 3) crear link único
      const inviteLink = await createUniqueInviteLink(userId, expiresAt);
      const formattedDate = formatDate(expiresAt);

      // 4) mandar onboarding al usuario
      await bot.telegram.sendMessage(
        userId,
        `✅ *Pago aprobado*\n\n` +
          `🎉 Bienvenido al canal VIP.\n\n` +
          `⏳ Tu suscripción vence el: *${formattedDate}*\n` +
          `🔑 Acceso al canal (link único, un solo uso):`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Entrar al canal 🔐', url: inviteLink }]]
          }
        }
      );

      await bot.telegram.sendMessage(
        userId,
        `📘 *Guía rápida:*\n\n` +
          `• Usá este canal para ver todo el contenido VIP.\n` +
          `• Podés consultar tu estado en cualquier momento con /status.\n` +
          `• Para recomendar el canal y ganar días extra, usá /referidos.`
      );

      await appendStatus(
        `\n\n✔ Aprobado. Suscripción hasta: *${formattedDate}*`
      );
      await ctx.answerCbQuery('Acceso enviado al usuario ✅');
    } else if (action === 'reject') {
      await bot.telegram.sendMessage(
        userId,
        '❌ Tu comprobante fue rechazado.\n\n' +
          'Si creés que es un error, reenviá una captura clara o el TXID correcto.'
      );

      await appendStatus('\n\n❌ Rechazado.');
      await ctx.answerCbQuery('Pago rechazado.');
    }
  } catch (err) {
    console.error('Error en callback_query:', err);
    try {
      await ctx.answerCbQuery('Ocurrió un error al procesar tu acción.', {
        show_alert: true
      });
    } catch (_) {}
  }
});

// ---------- SERVER PARA RAILWAY ----------
const app = express();
app.get('/', (_req, res) => res.send('Bot corriendo'));
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});

// ---------- LAUNCH + USERNAME + CRON ----------
bot.launch().then(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log(`🤖 Bot iniciado como @${BOT_USERNAME}`);
  } catch (e) {
    console.error('No se pudo obtener el username del bot:', e.message);
  }

  // chequeo inicial de expiraciones y luego cada 15 minutos
  await checkExpirations();
  setInterval(checkExpirations, 15 * 60 * 1000);
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
