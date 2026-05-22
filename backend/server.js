const express = require('express');
const cors = require('cors');
const multer = require('multer');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check route
app.get('/', (req, res) => res.json({ status: 'DOCS Backend OK (Serverless Firebase)' }));

// Configurar Multer (memoria)
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// =========================================
// CONFIGURAR FIREBASE FIRESTORE
// =========================================
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase Admin Inicializado');
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT no configurado en variables de entorno.');
            admin.initializeApp(); // Intentar con credenciales por defecto de entorno
        }
    } catch (e) {
        console.error('Error inicializando Firebase:', e);
    }
}
const db = admin.firestore();

// =========================================
// CONFIGURAR TELEGRAM BOT
// =========================================
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatIds = process.env.TELEGRAM_ADMIN_CHAT_ID ? process.env.TELEGRAM_ADMIN_CHAT_ID.split(',').map(id => id.trim()) : [];
let bot;

if (token && adminChatIds.length > 0) {
    bot = new TelegramBot(token, { polling: false });

    // En Vercel usaremos VERCEL_URL si existe, sino un default
    const SERVER_URL = process.env.VERCEL_URL 
        ? `https://${process.env.VERCEL_URL}` 
        : (process.env.CUSTOM_URL || 'https://tu-app.vercel.app');

    // Registrar webhook con Telegram (se registra automáticamente al recibir un pago o arrancar local)
    bot.setWebHook(`${SERVER_URL}/api/telegram-webhook`).catch(console.error);

    // Ruta de Express para recibir las actualizaciones de Telegram
    app.post('/api/telegram-webhook', (req, res) => {
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

        bot.sendMessage(chatId, "⚠️ <b>ATENCIÓN: CERRAR LISTA</b> ⚠️\n\n¿Estás seguro de que deseas cerrar la lista actual? Esto archivará todos los pagos y <b>desactivará todos los QRs</b> emitidos hasta ahora.", {
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
            const snapshot = await db.collection('tickets').where('status', '==', 'approved').get();
            if (snapshot.empty) return bot.sendMessage(chatId, "⚠️ Aún no hay pagos aprobados.");

            let csv = '\uFEFFNombre y Apellido,Cedula,Correo,Telefono,Banco,Numero de Entradas\n';
            snapshot.forEach(doc => {
                const r = doc.data();
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
            const qrSnapshot = await db.collection('qr_codes').where('status', '==', 'used').get();
            if (qrSnapshot.empty) return bot.sendMessage(chatId, "⚠️ Aún no hay ninguna entrada escaneada.");

            let csv = '\uFEFFNombre y Apellido,Cedula,Hora de Ingreso\n';
            
            // Recopilar datos (puede ser lento si hay muchos, pero en Firebase es aceptable para eventos pequeños)
            const ticketCache = {};
            for (const qrDoc of qrSnapshot.docs) {
                const q = qrDoc.data();
                if (!ticketCache[q.ticket_id]) {
                    const tDoc = await db.collection('tickets').doc(q.ticket_id).get();
                    if (tDoc.exists) ticketCache[q.ticket_id] = tDoc.data();
                }
                const t = ticketCache[q.ticket_id] || {};
                
                let hora = 'Desconocida';
                if (q.scanned_at) {
                    const dateObj = q.scanned_at.toDate ? q.scanned_at.toDate() : new Date(q.scanned_at);
                    hora = dateObj.toLocaleString('es-VE', { timeZone: 'America/Caracas' });
                }
                csv += `"${(t.name||'').replace(/"/g,'""')}","${t.cedula||''}","${hora}"\n`;
            }

            const buf = Buffer.from(csv, 'utf8');
            bot.sendDocument(chatId, buf, { caption: '🎟️ Reporte de asistencias (entradas escaneadas).' }, { filename: 'asistencias.csv', contentType: 'text/csv' })
               .catch(() => bot.sendMessage(chatId, '❌ Error al enviar el archivo.'));
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, '❌ Error generando asistencias.');
        }
    });

    // Comando /pendientes
    bot.onText(/\/pendientes/, async (msg) => {
        const chatId = msg.chat.id;
        if (!adminChatIds.includes(chatId.toString())) return;

        try {
            const snapshot = await db.collection('tickets').where('status', '==', 'pending').get();
            if (snapshot.empty) return bot.sendMessage(chatId, "✅ No hay pagos pendientes.");

            bot.sendMessage(chatId, `⏳ Enviando ${snapshot.size} pago(s) pendiente(s)...`);

            for (const doc of snapshot.docs) {
                const row = doc.data();
                const id = doc.id;
                
                const escapeHTML = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const caption = `🚨 <b>PAGO PENDIENTE RECUPERADO</b> 🚨\n\n` +
                    `👤 <b>Nombre</b>: ${escapeHTML(row.name)}\n` +
                    `📧 <b>Email</b>: ${escapeHTML(row.email)}\n` +
                    `🆔 <b>Cédula</b>: ${escapeHTML(row.cedula)}\n` +
                    `📱 <b>Teléfono</b>: ${escapeHTML(row.phone)}\n` +
                    `🎟 <b>Entradas</b>: ${escapeHTML(row.ticket_count)}\n` +
                    `💰 <b>Total Bs</b>: ${escapeHTML(row.total_bs)}\n` +
                    `🏦 <b>Banco</b>: ${escapeHTML(row.bank)} (Ref: ${escapeHTML(row.ref)})`;

                let photoBuffer;
                let mimeType = 'image/jpeg';
                if (row.photo_path && row.photo_path.startsWith('data:')) {
                    const parts = row.photo_path.split(';base64,');
                    if (parts.length === 2) {
                        mimeType = parts[0].split(':')[1];
                        photoBuffer = Buffer.from(parts[1], 'base64');
                    }
                }

                if (photoBuffer) {
                    await bot.sendPhoto(chatId, photoBuffer, {
                        caption,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Aprobar y Enviar', callback_data: `approve_${id}` },
                                { text: '❌ Rechazar', callback_data: `reject_${id}` }
                            ]]
                        }
                    }, { filename: 'comprobante.jpg', contentType: mimeType }).catch(e => console.error(e));
                } else {
                    await bot.sendMessage(chatId, caption + `\n\n⚠️ <i>No se pudo recuperar la imagen.</i>`, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Aprobar y Enviar', callback_data: `approve_${id}` },
                                { text: '❌ Rechazar', callback_data: `reject_${id}` }
                            ]]
                        }
                    });
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (e) {
            console.error(e);
            bot.sendMessage(chatId, "❌ Error buscando pagos pendientes.");
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

        const ticketRef = await db.collection('tickets').add({
            name, email, cedula, phone, bank, ref, 
            ticket_count: parseInt(ticketCount), 
            total_bs: totalBs, 
            photo_path: photoPath,
            status: 'pending',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        const insertId = ticketRef.id;

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
// LÓGICA DEL BOT (Callbacks)
// =========================================

async function handleApprove(id, chatId, messageId, caption, callbackQueryId) {
    try {
        const ticketRef = db.collection('tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        
        if (!ticketDoc.exists) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        const row = ticketDoc.data();
        
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        await ticketRef.update({ status: 'approved' });

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
            await db.collection('qr_codes').add({
                ticket_id: id,
                uuid: ticketUuid,
                status: 'approved',
                created_at: admin.firestore.FieldValue.serverTimestamp()
            });

            const qrDataUrl = await QRCode.toDataURL(ticketUuid, { color: { dark: '#000000', light: '#FFFFFF' }, margin: 2 });
            const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

            // --- JIMP TICKET GENERATION ---
            const image = new Jimp(600, 1000, '#050505');
            try {
                // En Vercel, paths relativos pueden fallar si no se incluyen los assets. Asegurar usar __dirname.
                const logoPath = path.join(__dirname, 'assets', 'logo.png');
                if (fs.existsSync(logoPath)) {
                    const logo = await Jimp.read(logoPath);
                    logo.resize(Jimp.AUTO, 120);
                    const logoX = (600 - logo.bitmap.width) / 2;
                    image.composite(logo, logoX, 60);
                }
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
        const ticketRef = db.collection('tickets').doc(id);
        const ticketDoc = await ticketRef.get();
        if (!ticketDoc.exists) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        
        const row = ticketDoc.data();
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        await ticketRef.update({ status: 'rejected' });
        
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
            bot.editMessageText("⏳ Procesando el cierre y actualizando base de datos...", { chat_id: chatId, message_id: messageId });

            // Archivar tickets
            const ticketsSnap = await db.collection('tickets').where('status', 'in', ['approved', 'pending']).get();
            const batch = db.batch();
            ticketsSnap.forEach(doc => {
                batch.update(doc.ref, { status: 'archived' });
            });

            // Archivar QRs
            const qrSnap = await db.collection('qr_codes').where('status', 'in', ['approved', 'used']).get();
            qrSnap.forEach(doc => {
                batch.update(doc.ref, { status: 'archived' });
            });

            // Firestore limits batches to 500 operations. If event is small, it's fine.
            await batch.commit();

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
        const qrSnapshot = await db.collection('qr_codes').where('uuid', '==', uuid).limit(1).get();
        if (qrSnapshot.empty) return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA INVÁLIDA (No existe)' });

        const qrDoc = qrSnapshot.docs[0];
        const qrData = qrDoc.data();

        const ticketDoc = await db.collection('tickets').doc(qrData.ticket_id).get();
        if (!ticketDoc.exists) return res.json({ valid: false, status: 'invalid', message: '❌ TICKET NO ENCONTRADO' });
        
        const ticketData = ticketDoc.data();

        if (qrData.status === 'used') return res.json({ valid: false, status: 'used', message: `❌ ENTRADA YA USADA\nNombre: ${ticketData.name}` });
        if (qrData.status === 'archived') return res.json({ valid: false, status: 'invalid', message: `❌ ENTRADA ARCHIVADA (Evento pasado)` });

        if (qrData.status === 'approved') {
            await db.collection('qr_codes').doc(qrDoc.id).update({ 
                status: 'used', 
                scanned_at: admin.firestore.FieldValue.serverTimestamp() 
            });
            return res.json({ valid: true, status: 'success', message: `✅ ACCESO PERMITIDO\nNombre: ${ticketData.name}\nEntrada válida para 1 persona.` });
        }

        return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA NO APROBADA' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ valid: false, message: 'Error del servidor' });
    }
});

// =========================================
// INICIAR SERVIDOR (Local) O EXPORTAR (Vercel)
// =========================================
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 DOCS Backend corriendo localmente en el puerto ${PORT}`);
    });
}

// Exportar para Vercel Serverless Functions
module.exports = app;
