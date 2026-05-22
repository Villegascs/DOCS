const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
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
// CONFIGURAR BASE DE DATOS SQLITE (GLITCH PERSISTENT)
// =========================================
// En Glitch, la carpeta .data persiste entre reinicios.
const dbFolder = path.join(__dirname, '.data');
if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder);
}
const dbPath = path.join(dbFolder, 'docs_tickets.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Error conectando a SQLite:', err);
    else console.log('✅ Base de datos conectada en .data/docs_tickets.db');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS qr_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER,
            uuid TEXT,
            status TEXT DEFAULT 'approved',
            scanned_at DATETIME,
            FOREIGN KEY(ticket_id) REFERENCES tickets(id)
        )
    `);
});

// Función auxiliar para SQLite asíncrono
const runQuery = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});

const getQuery = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const allQuery = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});


// =========================================
// CONFIGURAR TELEGRAM BOT
// =========================================
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatIds = process.env.TELEGRAM_ADMIN_CHAT_ID ? process.env.TELEGRAM_ADMIN_CHAT_ID.split(',').map(id => id.trim()) : [];
let bot;

if (token && adminChatIds.length > 0) {
    bot = new TelegramBot(token, { polling: false });

    // En Railway, usamos RAILWAY_PUBLIC_DOMAIN que es la variable de entorno automática del dominio público.
    const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
        : 'https://docs-events-backend-production.up.railway.app';

    // Registrar webhook con Telegram
    bot.setWebHook(`${RAILWAY_URL}/telegram-webhook`).then(() => {
        console.log(`Webhook registrado en ${RAILWAY_URL}/telegram-webhook`);
    }).catch(console.error);

    // Ruta de Express para recibir las actualizaciones de Telegram
    app.post('/telegram-webhook', (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

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

    const escapeHTML = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Comando /cerrar_lista
    bot.onText(/\/cerrar_lista/, (msg) => {
        const chatId = msg.chat.id;
        if (!adminChatIds.includes(chatId.toString())) return;

        bot.sendMessage(chatId, "⚠️ <b>ATENCIÓN: CERRAR LISTA</b> ⚠️\n\n¿Estás seguro de que deseas cerrar la lista actual? Esto archivará todos los pagos y <b>desactivará todos los QRs</b> emitidos hasta ahora.\n\nSe te enviará un archivo Excel de respaldo final antes de cerrar.", {
            parse_mode: 'HTML',
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
        if (!adminChatIds.includes(chatId.toString())) return;

        try {
            const rows = await allQuery(`SELECT name, cedula, email, phone, bank, ticket_count FROM tickets WHERE status = 'approved'`);

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
        if (!adminChatIds.includes(chatId.toString())) return;

        try {
            const rows = await allQuery(`
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

        const result = await runQuery(
            `INSERT INTO tickets (name, email, cedula, phone, bank, ref, ticket_count, total_bs, photo_path) VALUES (?,?,?,?,?,?,?,?,?)`,
            [name, email, cedula, phone, bank, ref, ticketCount, totalBs, photoPath]
        );
        const insertId = result.lastID;

        if (bot && adminChatIds.length > 0) {
            const escapeHTML = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const caption = `🚨 <b>NUEVO PAGO RECIBIDO</b> 🚨\n\n` +
                `👤 <b>Nombre</b>: ${escapeHTML(name)}\n` +
                `📧 <b>Email</b>: ${escapeHTML(email)}\n` +
                `🆔 <b>Cédula</b>: ${escapeHTML(cedula)}\n` +
                `📱 <b>Teléfono</b>: ${escapeHTML(phone)}\n` +
                `🎟 <b>Entradas</b>: ${escapeHTML(ticketCount)}\n` +
                `💰 <b>Total Bs</b>: ${escapeHTML(totalBs)}\n` +
                `🏦 <b>Banco</b>: ${escapeHTML(bank)} (Ref: ${escapeHTML(ref)})`;

            const photoBuffer = Buffer.from(photoBase64, 'base64');
            adminChatIds.forEach(chatId => {
                bot.sendPhoto(chatId, photoBuffer, {
                    caption,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Aprobar y Enviar', callback_data: `approve_${insertId}` },
                            { text: '❌ Rechazar', callback_data: `reject_${insertId}` }
                        ]]
                    }
                }, { filename: 'comprobante.jpg', contentType: photoMimeType }).catch(e => console.error(`Error Telegram enviando a ${chatId}:`, e));
            });
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
        const row = await getQuery(`SELECT * FROM tickets WHERE id = ?`, [id]);
        if (!row) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        await runQuery(`UPDATE tickets SET status = 'approved' WHERE id = ?`, [id]);

        bot.editMessageCaption(`${caption || 'NUEVO PAGO'}\n\n✅ <b>APROBADO</b>`, {
            chat_id: chatId, message_id: messageId,
            parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
        });
        bot.answerCallbackQuery(callbackQueryId).catch(console.error);

        const ticketCount = row.ticket_count;
        const attachments = [];
        let qrHtml = '';

        for (let i = 0; i < ticketCount; i++) {
            const ticketUuid = uuidv4();
            await runQuery(`INSERT INTO qr_codes (ticket_id, uuid) VALUES (?, ?)`, [id, ticketUuid]);

            const qrDataUrl = await QRCode.toDataURL(ticketUuid, { color: { dark: '#000000', light: '#FFFFFF' }, margin: 2 });
            const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

            // --- JIMP TICKET GENERATION ---
            const image = new Jimp(600, 1000, '#050505');
            try {
                const logo = await Jimp.read(path.join(__dirname, 'assets', 'logo.png'));
                logo.resize(Jimp.AUTO, 120);
                const logoX = (600 - logo.bitmap.width) / 2;
                image.composite(logo, logoX, 60);
            } catch (e) { console.error("Logo no encontrado", e); }
            
            const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
            const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

            image.print(fontTitle, 0, 240, { text: "ENTRADA OFICIAL", alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 600);
            image.print(fontSub, 0, 300, { text: `Titular: ${row.name}`, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 600);
            image.print(fontSub, 0, 330, { text: `Entrada: ${i+1} de ${ticketCount}`, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 600);
            
            const qr = await Jimp.read(qrBuffer);
            qr.resize(350, 350);
            const qrX = (600 - qr.bitmap.width) / 2;
            image.composite(qr, qrX, 420);

            image.print(fontSub, 0, 830, { text: "NO COMPARTAS ESTE CÓDIGO", alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 600);
            image.print(fontSub, 0, 860, { text: `ID: ${ticketUuid.split('-')[0]}`, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 600);

            const finalBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
            // --------------------------------

            attachments.push({ filename: `entrada-docs-${i+1}.png`, content: finalBuffer, cid: `qrcode_image_${i}` });
            qrHtml += `<h3 style="color:#ccc;">Entrada ${i+1} de ${ticketCount}</h3><img src="cid:qrcode_image_${i}" style="margin:10px 0;border-radius:10px;width:100%;max-width:350px;">`;
        }

        const mailOptions = {
            from: `"DOCS Underground" <${process.env.EMAIL_USER}>`,
            to: row.email,
            subject: `Tus Entradas para ${process.env.EVENT_NAME || 'DOCS'}`,
            html: `<div style="background:#050505;color:white;padding:40px;font-family:sans-serif;text-align:center;">
                <img src="https://docsevents.web.app/Logos/docs%20png.png" style="max-height:80px;margin-bottom:20px;" alt="DOCS">
                <h2>¡Pago Verificado!</h2>
                <p>Hola ${row.name}, tu pago de Bs. ${row.total_bs} ha sido verificado con éxito.</p>
                <p>Aquí tienes tus códigos QR. <strong>Cada entrada es válida para 1 persona.</strong></p>
                ${qrHtml}
                <p style="color:#A0A0A0;margin-top:30px;">No compartas estos códigos. Serán escaneados individualmente en la puerta.</p>
            </div>`,
            attachments
        };

        if (process.env.APPS_SCRIPT_WEBHOOK_URL) {
            // Enviar correo usando el puente de Google Apps Script para evitar bloqueos SMTP de Railway
            const payload = {
                to: mailOptions.to,
                subject: mailOptions.subject,
                html: mailOptions.html,
                attachments: attachments.map(att => ({
                    filename: att.filename,
                    mimeType: 'image/png',
                    base64: att.content.toString('base64'),
                    cid: att.cid
                }))
            };
            
            fetch(process.env.APPS_SCRIPT_WEBHOOK_URL, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: { 'Content-Type': 'application/json' }
            })
            .then(res => res.json())
            .then(data => console.log("Email enviado vía Apps Script:", data))
            .catch(err => console.error("Error en Apps Script:", err));
        } else {
            // Usar Nodemailer clásico (falla en Railway si los puertos SMTP están bloqueados)
            transporter.sendMail(mailOptions, (err, info) => {
                if (err) console.error("Error email SMTP:", err);
                else console.log("Email enviado SMTP:", info.response);
            });
        }

    } catch (e) {
        console.error("Error en handleApprove:", e);
    }
}

async function handleReject(id, chatId, messageId, caption, callbackQueryId) {
    try {
        const row = await getQuery(`SELECT * FROM tickets WHERE id = ?`, [id]);
        if (!row) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        await runQuery(`UPDATE tickets SET status = 'rejected' WHERE id = ?`, [id]);
        bot.editMessageCaption(`${caption || 'NUEVO PAGO'}\n\n❌ <b>RECHAZADO</b>`, {
            chat_id: chatId, message_id: messageId,
            parse_mode: 'HTML', reply_markup: { inline_keyboard: [] }
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
            const rows = await allQuery(`SELECT name, cedula, email, phone, bank, ticket_count FROM tickets WHERE status = 'approved'`);

            let csv = '\uFEFFNombre y Apellido,Cedula,Correo,Telefono,Banco,Numero de Entradas\n';
            rows.forEach(r => {
                csv += `"${(r.name||'').replace(/"/g,'""')}","${r.cedula}","${(r.email||'').replace(/"/g,'""')}","${r.phone}","${(r.bank||'').replace(/"/g,'""')}",${r.ticket_count}\n`;
            });

            bot.editMessageText("⏳ Procesando el cierre y generando respaldo final...", { chat_id: chatId, message_id: messageId });

            const buf = Buffer.from(csv, 'utf8');
            await bot.sendDocument(chatId, buf, { caption: "📦 Respaldo final del evento." }, { filename: 'respaldo_cierre_lista.csv', contentType: 'text/csv' });

            await runQuery(`UPDATE tickets SET status = 'archived' WHERE status != 'archived'`);
            await runQuery(`UPDATE qr_codes SET status = 'archived' WHERE status != 'archived'`);

            bot.sendMessage(chatId, "✅ <b>La lista ha sido cerrada exitosamente.</b>\nLos QRs antiguos ya no funcionarán. ¡Listo para el próximo evento!", { parse_mode: 'HTML' });
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
        const row = await getQuery(`
            SELECT qr_codes.*, tickets.name, tickets.ticket_count
            FROM qr_codes
            JOIN tickets ON qr_codes.ticket_id = tickets.id
            WHERE qr_codes.uuid = ?
        `, [uuid]);

        if (!row) return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA INVÁLIDA (No existe)' });

        if (row.status === 'used') return res.json({ valid: false, status: 'used', message: `❌ ENTRADA YA USADA\nNombre: ${row.name}` });

        if (row.status === 'approved') {
            await runQuery(`UPDATE qr_codes SET status = 'used', scanned_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
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
