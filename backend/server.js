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
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar Express
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configurar Multer para subir imágenes
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Configurar Base de Datos SQLite
const db = new sqlite3.Database('./docs_tickets.db', (err) => {
    if (err) console.error('Error opening database', err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS tickets (
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
        )`);
    }
});

// Configurar Telegram Bot
const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
let bot;
if (token && adminChatId) {
    bot = new TelegramBot(token, { polling: true });
    
    // Manejar botones del Bot
    bot.on('callback_query', async (query) => {
        const [action, id] = query.data.split('_');
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;

        const callbackQueryId = query.id;

        if (action === 'approve') {
            await handleApprove(id, chatId, messageId, query.message.caption, callbackQueryId);
        } else if (action === 'reject') {
            await handleReject(id, chatId, messageId, query.message.caption, callbackQueryId);
        }
    });
} else {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN o ADMIN_CHAT_ID no configurados.");
}

// Configurar Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ================= RUTAS DE LA API =================

// Ruta para recibir el formulario de pago
app.post('/api/tickets/request', upload.single('receipt'), (req, res) => {
    try {
        const { name, email, cedula, phone, bank, ref, ticketCount, totalBs } = req.body;
        const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

        if (!photoPath) return res.status(400).json({ error: 'Falta el comprobante de pago' });

        const stmt = db.prepare(`INSERT INTO tickets (name, email, cedula, phone, bank, ref, ticket_count, total_bs, photo_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run([name, email, cedula, phone, bank, ref, ticketCount, totalBs, photoPath], function(err) {
            if (err) return res.status(500).json({ error: 'Error en base de datos' });
            
            const insertId = this.lastID;
            
            // Enviar mensaje al Bot de Telegram
            if (bot && adminChatId) {
                const caption = `🚨 **NUEVO PAGO RECIBIDO** 🚨\n\n` +
                                `👤 **Nombre**: ${name}\n` +
                                `📧 **Email**: ${email}\n` +
                                `🆔 **Cédula**: ${cedula}\n` +
                                `📱 **Teléfono**: ${phone}\n` +
                                `🎟 **Entradas**: ${ticketCount}\n` +
                                `💰 **Total Bs**: ${totalBs}\n` +
                                `🏦 **Banco**: ${bank} (Ref: ${ref})`;

                const photoFullPath = path.join(__dirname, photoPath);
                
                bot.sendPhoto(adminChatId, photoFullPath, {
                    caption: caption,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Aprobar y Enviar', callback_data: `approve_${insertId}` },
                                { text: '❌ Rechazar', callback_data: `reject_${insertId}` }
                            ]
                        ]
                    }
                }).catch(e => console.error("Error enviando a Telegram:", e));
            }

            res.json({ success: true, message: 'Pago registrado. Esperando verificación.' });
        });
        stmt.finalize();
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ================= LÓGICA DEL BOT =================

async function handleApprove(id, chatId, messageId, caption, callbackQueryId) {
    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], async (err, row) => {
        if (err || !row) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        const ticketUuid = uuidv4();
        
        // Actualizar BD
        db.run(`UPDATE tickets SET status = 'approved', uuid = ? WHERE id = ?`, [ticketUuid, id], async (err) => {
            if (err) return console.error(err);

            // Cambiar mensaje en Telegram
            bot.editMessageCaption(`${caption || 'NUEVO PAGO RECIBIDO'}\n\n✅ **APROBADO**`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            });

            // Generar QR
            try {
                const qrDataUrl = await QRCode.toDataURL(ticketUuid, { color: { dark: '#000000', light: '#E0FF00' } });
                const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
                
                // Enviar Correo
                const mailOptions = {
                    from: `"DOCS Underground" <${process.env.EMAIL_USER}>`,
                    to: row.email,
                    subject: 'Tus Entradas para DOCS Vol. 1',
                    html: `
                        <div style="background-color: #050505; color: white; padding: 40px; font-family: sans-serif; text-align: center;">
                            <h1 style="color: #E0FF00; letter-spacing: 2px;">DOCS</h1>
                            <h2>¡Pago Verificado!</h2>
                            <p>Hola ${row.name}, tu pago de ${row.total_bs} ha sido verificado con éxito.</p>
                            <p>Aquí tienes tu código QR para ingresar al evento (Válido por ${row.ticket_count} entradas).</p>
                            <img src="cid:qrcode_image" alt="Tu QR de Acceso" style="margin: 20px 0; border-radius: 10px; width: 250px;">
                            <p style="color: #A0A0A0;">No compartas este código con nadie. Será escaneado en la puerta.</p>
                        </div>
                    `,
                    attachments: [
                        {
                            filename: 'ticket-qr.png',
                            content: qrBuffer,
                            cid: 'qrcode_image'
                        }
                    ]
                };
                
                transporter.sendMail(mailOptions, (error, info) => {
                    if (error) console.error("Error enviando email:", error);
                    else console.log("Email enviado:", info.response);
                });

            } catch (e) {
                console.error("Error generando QR:", e);
            }
        });
    });
}

async function handleReject(id, chatId, messageId, caption, callbackQueryId) {
    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], async (err, row) => {
        if (err || !row) return bot.sendMessage(chatId, "Error encontrando el ticket.");
        if (row.status !== 'pending') return bot.answerCallbackQuery(callbackQueryId, { text: "Este pago ya fue procesado." }).catch(console.error);

        db.run(`UPDATE tickets SET status = 'rejected' WHERE id = ?`, [id], (err) => {
            if (err) return console.error(err);
            
            bot.editMessageCaption(`${caption || 'NUEVO PAGO RECIBIDO'}\n\n❌ **RECHAZADO**`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            });
            bot.answerCallbackQuery(callbackQueryId, { text: "Pago rechazado." }).catch(console.error);
        });
    });
}

// ================= RUTA DEL ESCÁNER =================

app.post('/api/verify', (req, res) => {
    const { uuid } = req.body;
    if (!uuid) return res.status(400).json({ valid: false, message: 'No se proveyó código QR' });

    db.get(`SELECT * FROM tickets WHERE uuid = ?`, [uuid], (err, row) => {
        if (err) return res.status(500).json({ valid: false, message: 'Error del servidor' });
        
        if (!row) return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA INVÁLIDA (No existe)' });
        
        if (row.status === 'used') {
            return res.json({ valid: false, status: 'used', message: `❌ ENTRADA YA USADA\nNombre: ${row.name}\nEntradas: ${row.ticket_count}` });
        }
        
        if (row.status === 'approved') {
            // Marcar como usada
            db.run(`UPDATE tickets SET status = 'used' WHERE id = ?`, [row.id], (err) => {
                if (err) return res.status(500).json({ valid: false, message: 'Error actualizando ticket' });
                return res.json({ 
                    valid: true, 
                    status: 'success', 
                    message: `✅ ACCESO PERMITIDO\nNombre: ${row.name}\nEntradas válidas: ${row.ticket_count}` 
                });
            });
        } else {
            return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA NO APROBADA' });
        }
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 DOCS Backend corriendo en el puerto ${PORT}`);
});
