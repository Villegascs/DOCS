const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar Express
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check route
app.get('/', (req, res) => res.json({ status: 'DOCS Backend OK' }));

// Configurar Multer (memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// =========================================
// CONFIGURAR BASE DE DATOS POSTGRESQL
// =========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode') 
        ? { rejectUnauthorized: false } 
        : false
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            id SERIAL PRIMARY KEY,
            uuid TEXT,
            name TEXT,
            email TEXT,
            cedula TEXT,
            phone TEXT,
            bank TEXT,
            ref TEXT,
            ticket_count INTEGER,
            total_bs TEXT,
            photo_path TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS qr_codes (
            id SERIAL PRIMARY KEY,
            ticket_id INTEGER REFERENCES tickets(id),
            uuid TEXT,
            status TEXT DEFAULT 'approved',
            scanned_at TIMESTAMP
        )
    `);
    console.log('✅ Base de datos lista');
}
initDB().catch(err => console.error('Error iniciando DB:', err));

// =========================================
// CONFIGURAR TELEGRAM BOT
// =========================================
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
let bot;

if (token && adminChatId) {
    bot = new TelegramBot(token, { polling: true });

    // Manejar botones inline
    bot.on('callback_query', async (query) => {
        const [action, id] = query.data.split('_');
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const callbackQueryId = query.id;

        if (action === 'approve') {
            await handleApprove(id, chatId, messageId, query.message.caption, callbackQueryId);
        } else if (action === 'reject') {
            await handleReject(id, chatId, messageId, query.message.caption, callbackQueryId);
        } else if (action === 'closelist') {
            await handleCloseList(id, chatId, messageId, callbackQueryId);
        }
    });

    // Comando /cerrar_lista
    bot.onText(/\/cerrar_lista/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminChatId.toString()) return;

        bot.sendMessage(chatId, "⚠️ *ATENCIÓN: CERRAR LISTA* ⚠️\n\n¿Estás seguro de que deseas cerrar la lista actual? Esto archivará todos los pagos y *desactivará todos los QRs* emitidos hasta ahora.\n\nSe te enviará un archivo Excel de respaldo final antes de cerrar.", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '⚠️ SÍ, CERRAR LISTA', callback_data: 'closelist_confirm' },
                    { text: '❌ Cancelar', callback_data: 'closelist_cancel' }
                ]]
            }
        });
    });

    // Comando /historial
    bot.onText(/\/historial/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminChatId.toString()) return;

        try {
            const { rows } = await pool.query(`SELECT name, cedula, email, phone, bank, ticket_count FROM tickets WHERE status = 'approved'`);

            if (rows.length === 0) return bot.sendMessage(chatId, "⚠️ Aún no hay pagos aprobados.");

            let csv = '\uFEFFNombre y Apellido,Cedula,Correo,Telefono,Banco,Numero de Entradas\n';
            rows.forEach(r => {
                csv += `"${(r.name||'').replace(/"/g,'""')}","${r.cedula}","${(r.email||'').replace(/"/g,'""')}","${r.phone}","${(r.bank||'').replace(/"/g,'""')}",${r.ticket_count}\n`;
            });

            const buf = Buffer.from(csv, 'utf8');
            bot.sendDocument(chatId, buf, { caption: '📊 Historial de pagos aprobados.' }, { filename: 'aprobados.csv', contentType: 'text/csv' })
               .catch(() => bot.sendMessage(chatId, '❌ Error al enviar el archivo.'));
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Error generando el historial.');
        }
    });

    // Comando /asistencias
    bot.onText(/\/asistencias/, async (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminChatId.toString()) return;

        try {
            const { rows } = await pool.query(`
                SELECT t.name, t.cedula, q.scanned_at
                FROM qr_codes q
                JOIN tickets t ON q.ticket_id = t.id
                WHERE q.status = 'used'
            `);

            if (rows.length === 0) return bot.sendMessage(chatId, "⚠️ Aún no hay ninguna entrada escaneada.");

            let csv = '\uFEFFNombre y Apellido,Cedula,Hora de Ingreso\n';
            rows.forEach(r => {
                let hora = 'Desconocida';
                if (r.scanned_at) {
                    hora = new Date(r.scanned_at).toLocaleString('es-VE', { timeZone: 'America/Caracas' });
                }
                csv += `"${(r.name||'').replace(/"/g,'""')}","${r.cedula}","${hora}"\n`;
            });

            const buf = Buffer.from(csv, 'utf8');
            bot.sendDocument(chatId, buf, { caption: '🎟️ Reporte de asistencias (entradas escaneadas).' }, { filename: 'asistencias.csv', contentType: 'text/csv' })
               .catch(() => bot.sendMessage(chatId, '❌ Error al enviar el archivo.'));
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Error generando asistencias.');
        }
    });

} else {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN o ADMIN_CHAT_ID no configurados.");
}

// Configurar Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// =========================================
// RUTAS DE LA API
// =========================================

// Recibir formulario de pago
app.post('/api/tickets/request', upload.single('receipt'), async (req, res) => {
    try {
        const { name, email, cedula, phone, bank, ref, ticketCount, totalBs } = req.body;
        if (!req.file) return res.status(400).json({ error: 'Falta el comprobante de pago' });

        const photoBase64 = req.file.buffer.toString('base64');
        const photoMimeType = req.file.mimetype;
        const photoPath = `data:${photoMimeType};base64,${photoBase64}`;

        const result = await pool.query(
            `INSERT INTO tickets (name, email, cedula, phone, bank, ref, ticket_count, total_bs, photo_path) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [name, email, cedula, phone, bank, ref, ticketCount, totalBs, photoPath]
        );
        const insertId = result.rows[0].id;

        if (bot && adminChatId) {
            const caption = `🚨 *NUEVO PAGO RECIBIDO* 🚨\n\n` +
                `👤 *Nombre*: ${name}\n` +
                `📧 *Email*: ${email}\n` +
                `🆔 *Cédula*: ${cedula}\n` +
                `📱 *Teléfono*: ${phone}\n` +
                `🎟 *Entradas*: ${ticketCount}\n` +
                `💰 *Total Bs*: ${totalBs}\n` +
                `🏦 *Banco*: ${bank} (Ref: ${ref})`;

            const photoBuffer = Buffer.from(photoBase64, 'base64');
            bot.sendPhoto(adminChatId, photoBuffer, {
                caption,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Aprobar y Enviar', callback_data: `approve_${insertId}` },
                        { text: '❌ Rechazar', callback_data: `reject_${insertId}` }
                    ]]
                }
            }, { filename: 'comprobante.jpg', contentType: photoMimeType }).catch(e => console.error("Error Telegram:", e));
        }

        res.json({ success: true, message: 'Pago registrado. Esperando verificación.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// =========================================
// LÓGICA DEL BOT
// =========================================

async function handleApprove(id, chatId, messageId, caption, callbackQueryId) {
    try {
        const { rows } = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [id]);
        const row = rows[0];
        if (!row) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        await pool.query(`UPDATE tickets SET status = 'approved' WHERE id = $1`, [id]);

        bot.editMessageCaption(`${caption || 'NUEVO PAGO'}\n\n✅ *APROBADO*`, {
            chat_id: chatId, message_id: messageId,
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
        });
        bot.answerCallbackQuery(callbackQueryId).catch(console.error);

        const ticketCount = row.ticket_count;
        const attachments = [];
        let qrHtml = '';

        for (let i = 0; i < ticketCount; i++) {
            const ticketUuid = uuidv4();
            await pool.query(`INSERT INTO qr_codes (ticket_id, uuid) VALUES ($1, $2)`, [id, ticketUuid]);

            const qrDataUrl = await QRCode.toDataURL(ticketUuid, { color: { dark: '#000000', light: '#FFFFFF' } });
            const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

            attachments.push({ filename: `ticket-${i+1}.png`, content: qrBuffer, cid: `qrcode_image_${i}` });
            qrHtml += `<h3 style="color:#ccc;">Entrada ${i+1} de ${ticketCount}</h3><img src="cid:qrcode_image_${i}" style="margin:10px 0;border-radius:10px;width:250px;">`;
        }

        const mailOptions = {
            from: `"DOCS Underground" <${process.env.EMAIL_USER}>`,
            to: row.email,
            subject: 'Tus Entradas para DOCS Vol. 1',
            html: `<div style="background:#050505;color:white;padding:40px;font-family:sans-serif;text-align:center;">
                <h1 style="color:#FFFFFF;letter-spacing:2px;">DOCS</h1>
                <h2>¡Pago Verificado!</h2>
                <p>Hola ${row.name}, tu pago de ${row.total_bs} ha sido verificado con éxito.</p>
                <p>Aquí tienes tus códigos QR. <strong>Cada QR es válido para 1 persona.</strong></p>
                ${qrHtml}
                <p style="color:#A0A0A0;margin-top:30px;">No compartas estos códigos. Serán escaneados individualmente en la puerta.</p>
            </div>`,
            attachments
        };

        transporter.sendMail(mailOptions, (err, info) => {
            if (err) console.error("Error email:", err);
            else console.log("Email enviado:", info.response);
        });

    } catch (e) {
        console.error("Error en handleApprove:", e);
    }
}

async function handleReject(id, chatId, messageId, caption, callbackQueryId) {
    try {
        const { rows } = await pool.query(`SELECT * FROM tickets WHERE id = $1`, [id]);
        const row = rows[0];
        if (!row) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        await pool.query(`UPDATE tickets SET status = 'rejected' WHERE id = $1`, [id]);
        bot.editMessageCaption(`${caption || 'NUEVO PAGO'}\n\n❌ *RECHAZADO*`, {
            chat_id: chatId, message_id: messageId,
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
        });
        bot.answerCallbackQuery(callbackQueryId, { text: "Pago rechazado." }).catch(console.error);
    } catch (e) {
        console.error("Error en handleReject:", e);
    }
}

async function handleCloseList(type, chatId, messageId, callbackQueryId) {
    if (type === 'cancel') {
        bot.editMessageText("Cierre de lista cancelado. Nada ha cambiado.", { chat_id: chatId, message_id: messageId });
        bot.answerCallbackQuery(callbackQueryId);
        return;
    }
    if (type === 'confirm') {
        try {
            const { rows } = await pool.query(`SELECT name, cedula, email, phone, bank, ticket_count FROM tickets WHERE status = 'approved'`);

            let csv = '\uFEFFNombre y Apellido,Cedula,Correo,Telefono,Banco,Numero de Entradas\n';
            rows.forEach(r => {
                csv += `"${(r.name||'').replace(/"/g,'""')}","${r.cedula}","${(r.email||'').replace(/"/g,'""')}","${r.phone}","${(r.bank||'').replace(/"/g,'""')}",${r.ticket_count}\n`;
            });

            bot.editMessageText("⏳ Procesando el cierre y generando respaldo final...", { chat_id: chatId, message_id: messageId });

            const buf = Buffer.from(csv, 'utf8');
            await bot.sendDocument(chatId, buf, { caption: "📦 Respaldo final del evento." }, { filename: 'respaldo_cierre_lista.csv', contentType: 'text/csv' });

            await pool.query(`UPDATE tickets SET status = 'archived' WHERE status != 'archived'`);
            await pool.query(`UPDATE qr_codes SET status = 'archived' WHERE status != 'archived'`);

            bot.sendMessage(chatId, "✅ *La lista ha sido cerrada exitosamente.*\nLos QRs antiguos ya no funcionarán. ¡Listo para el próximo evento!", { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(callbackQueryId);
        } catch (e) {
            console.error("Error cerrando lista:", e);
            bot.sendMessage(chatId, "❌ Error al cerrar la lista.");
            bot.answerCallbackQuery(callbackQueryId);
        }
    }
}

// =========================================
// RUTA DEL ESCÁNER
// =========================================
app.post('/api/verify', async (req, res) => {
    const { uuid } = req.body;
    if (!uuid) return res.status(400).json({ valid: false, message: 'No se proveyó código QR' });

    try {
        const { rows } = await pool.query(`
            SELECT qr_codes.*, tickets.name, tickets.ticket_count
            FROM qr_codes
            JOIN tickets ON qr_codes.ticket_id = tickets.id
            WHERE qr_codes.uuid = $1
        `, [uuid]);

        const row = rows[0];
        if (!row) return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA INVÁLIDA (No existe)' });

        if (row.status === 'used') return res.json({ valid: false, status: 'used', message: `❌ ENTRADA YA USADA\nNombre: ${row.name}` });

        if (row.status === 'approved') {
            await pool.query(`UPDATE qr_codes SET status = 'used', scanned_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
            return res.json({ valid: true, status: 'success', message: `✅ ACCESO PERMITIDO\nNombre: ${row.name}\nEntrada válida para 1 persona.` });
        }

        return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA NO APROBADA' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ valid: false, message: 'Error del servidor' });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 DOCS Backend corriendo en el puerto ${PORT}`);
});
