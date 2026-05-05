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

// Configurar Multer para subir imágenes a la Memoria (Base64)
const storage = multer.memoryStorage();
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
        db.run(`CREATE TABLE IF NOT EXISTS qr_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER,
            uuid TEXT,
            status TEXT DEFAULT 'approved',
            scanned_at DATETIME,
            FOREIGN KEY(ticket_id) REFERENCES tickets(id)
        )`, () => {
            // Migración por si la tabla ya existía sin la columna scanned_at
            db.run(`ALTER TABLE qr_codes ADD COLUMN scanned_at DATETIME`, (err) => {
                // Se ignora el error si la columna ya existe
            });
        });
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
        } else if (action === 'closelist') {
            await handleCloseList(id, chatId, messageId, callbackQueryId);
        }
    });

    // Comando para cerrar lista y archivar datos
    bot.onText(/\/cerrar_lista/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId.toString() !== adminChatId.toString()) return;

        bot.sendMessage(chatId, "⚠️ **ATENCIÓN: CERRAR LISTA** ⚠️\n\n¿Estás seguro de que deseas cerrar la lista actual? Esto archivará todos los pagos y **desactivará todos los QRs** emitidos hasta ahora.\n\nSe te enviará un archivo Excel de respaldo final antes de cerrar.", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '⚠️ SÍ, CERRAR LISTA', callback_data: 'closelist_confirm' },
                        { text: '❌ Cancelar', callback_data: 'closelist_cancel' }
                    ]
                ]
            }
        });
    });

    // Comando para descargar historial en Excel (CSV)
    bot.onText(/\/historial/, (msg) => {
        const chatId = msg.chat.id;
        
        // Verificar que solo el administrador pueda pedir el historial
        if (chatId.toString() !== adminChatId.toString()) return;

        db.all(`SELECT name, cedula, email, phone, bank, ticket_count FROM tickets WHERE status = 'approved'`, [], (err, rows) => {
            if (err) {
                console.error("Error leyendo historial:", err);
                return bot.sendMessage(chatId, "❌ Error generando el historial.");
            }
            
            if (rows.length === 0) {
                return bot.sendMessage(chatId, "⚠️ Aún no hay pagos aprobados.");
            }

            // Crear contenido CSV (agregando BOM UTF-8 para que Excel reconozca acentos)
            let csvContent = '\uFEFF'; 
            csvContent += "Nombre y Apellido,Cedula,Correo,Telefono,Banco,Numero de Entradas\n";
            
            rows.forEach(row => {
                // Limpiar posibles comillas en los datos para evitar errores en el CSV
                const cleanName = row.name ? row.name.replace(/"/g, '""') : '';
                const cleanEmail = row.email ? row.email.replace(/"/g, '""') : '';
                const cleanBank = row.bank ? row.bank.replace(/"/g, '""') : '';
                
                csvContent += `"${cleanName}","${row.cedula}","${cleanEmail}","${row.phone}","${cleanBank}",${row.ticket_count}\n`;
            });
            
            const fileBuffer = Buffer.from(csvContent, 'utf8');
            const options = { caption: "📊 ¡Aquí tienes el historial de aprobados! Puedes abrir este archivo en Excel." };
            const fileOptions = { filename: 'aprobados.csv', contentType: 'text/csv' };
            
            bot.sendDocument(chatId, fileBuffer, options, fileOptions).catch(e => {
                console.error("Error enviando documento:", e);
                bot.sendMessage(chatId, "❌ Hubo un problema al enviar el archivo.");
            });
        });
    });

    // Comando para descargar reporte de asistencias (entradas escaneadas)
    bot.onText(/\/asistencias/, (msg) => {
        const chatId = msg.chat.id;
        
        if (chatId.toString() !== adminChatId.toString()) return;

        db.all(`SELECT t.name, t.cedula, q.scanned_at 
                FROM qr_codes q 
                JOIN tickets t ON q.ticket_id = t.id 
                WHERE q.status = 'used'`, [], (err, rows) => {
            if (err) {
                console.error("Error leyendo asistencias:", err);
                return bot.sendMessage(chatId, "❌ Error generando el reporte de asistencias.");
            }
            
            if (rows.length === 0) {
                return bot.sendMessage(chatId, "⚠️ Aún no hay ninguna entrada escaneada (lista de asistencia vacía).");
            }

            let csvContent = '\uFEFFNombre y Apellido,Cedula,Hora de Ingreso\n';
            
            rows.forEach(row => {
                const cleanName = row.name ? row.name.replace(/"/g, '""') : '';
                let horaIngreso = 'Hora Desconocida';
                
                if (row.scanned_at) {
                    // SQLite almacena el CURRENT_TIMESTAMP en UTC, lo convertimos a Caracas
                    const date = new Date(row.scanned_at + 'Z');
                    horaIngreso = date.toLocaleString('es-VE', { timeZone: 'America/Caracas' });
                }
                
                csvContent += `"${cleanName}","${row.cedula}","${horaIngreso}"\n`;
            });
            
            const fileBuffer = Buffer.from(csvContent, 'utf8');
            const options = { caption: "🎟️ ¡Aquí tienes el reporte de asistencias! Entradas ya escaneadas." };
            const fileOptions = { filename: 'asistencias.csv', contentType: 'text/csv' };
            
            bot.sendDocument(chatId, fileBuffer, options, fileOptions).catch(e => {
                console.error("Error enviando documento:", e);
                bot.sendMessage(chatId, "❌ Hubo un problema al enviar el archivo.");
            });
        });
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

        if (!req.file) return res.status(400).json({ error: 'Falta el comprobante de pago' });

        const photoBase64 = req.file.buffer.toString('base64');
        const photoMimeType = req.file.mimetype;
        const photoPath = `data:${photoMimeType};base64,${photoBase64}`;

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

                const photoBuffer = Buffer.from(photoBase64, 'base64');
                
                bot.sendPhoto(adminChatId, photoBuffer, {
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
                }, { filename: 'comprobante.jpg', contentType: photoMimeType }).catch(e => console.error("Error enviando a Telegram:", e));
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
        db.run(`UPDATE tickets SET status = 'approved' WHERE id = ?`, [id], async (err) => {
            if (err) return console.error(err);

            // Cambiar mensaje en Telegram
            bot.editMessageCaption(`${caption || 'NUEVO PAGO RECIBIDO'}\n\n✅ **APROBADO**`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] }
            });

            // Generar QRs
            try {
                const ticketCount = row.ticket_count;
                const attachments = [];
                let qrHtml = '';
                
                for(let i=0; i<ticketCount; i++) {
                    const ticketUuid = uuidv4();
                    
                    // Insertar QR individual
                    await new Promise((resolve) => {
                        db.run(`INSERT INTO qr_codes (ticket_id, uuid) VALUES (?, ?)`, [id, ticketUuid], resolve);
                    });
                    
                    const qrDataUrl = await QRCode.toDataURL(ticketUuid, { color: { dark: '#000000', light: '#E0FF00' } });
                    const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
                    
                    attachments.push({
                        filename: `ticket-${i+1}.png`,
                        content: qrBuffer,
                        cid: `qrcode_image_${i}`
                    });
                    
                    qrHtml += `
                        <h3 style="color: #ccc;">Entrada ${i+1} de ${ticketCount}</h3>
                        <img src="cid:qrcode_image_${i}" alt="QR Entrada ${i+1}" style="margin: 10px 0; border-radius: 10px; width: 250px;">
                    `;
                }
                
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
                            <p>Aquí tienes tus códigos QR para ingresar al evento. <strong>Cada QR es válido para 1 persona.</strong></p>
                            ${qrHtml}
                            <p style="color: #A0A0A0; margin-top: 30px;">No compartas estos códigos con nadie. Serán escaneados individualmente en la puerta.</p>
                        </div>
                    `,
                    attachments: attachments
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

async function handleCloseList(type, chatId, messageId, callbackQueryId) {
    if (type === 'cancel') {
        bot.editMessageText("Cierre de lista cancelado. Nada ha cambiado.", {
            chat_id: chatId,
            message_id: messageId
        });
        bot.answerCallbackQuery(callbackQueryId);
        return;
    }

    if (type === 'confirm') {
        // Enviar el backup primero
        db.all(`SELECT name, cedula, email, phone, bank, ticket_count FROM tickets WHERE status = 'approved'`, [], (err, rows) => {
            if (err) return bot.answerCallbackQuery(callbackQueryId, { text: "Error leyendo la base de datos." });
            
            let csvContent = '\uFEFFNombre y Apellido,Cedula,Correo,Telefono,Banco,Numero de Entradas\n';
            rows.forEach(row => {
                const cleanName = row.name ? row.name.replace(/"/g, '""') : '';
                const cleanEmail = row.email ? row.email.replace(/"/g, '""') : '';
                const cleanBank = row.bank ? row.bank.replace(/"/g, '""') : '';
                csvContent += `"${cleanName}","${row.cedula}","${cleanEmail}","${row.phone}","${cleanBank}",${row.ticket_count}\n`;
            });

            const fileBuffer = Buffer.from(csvContent, 'utf8');
            
            bot.editMessageText("⏳ Procesando el cierre de lista y generando respaldo final...", {
                chat_id: chatId,
                message_id: messageId
            });

            bot.sendDocument(chatId, fileBuffer, { 
                caption: "📦 Aquí está el respaldo final. Procediendo a archivar la lista..." 
            }, { 
                filename: 'respaldo_cierre_lista.csv', 
                contentType: 'text/csv' 
            }).then(() => {
                // Actualizar status a 'archived' en ambas tablas
                db.run(`UPDATE tickets SET status = 'archived' WHERE status != 'archived'`, [], (err) => {
                    if (err) console.error(err);
                    db.run(`UPDATE qr_codes SET status = 'archived' WHERE status != 'archived'`, [], (err) => {
                        if (err) console.error(err);
                        bot.sendMessage(chatId, "✅ **La lista ha sido cerrada exitosamente.**\nLos QRs antiguos ya no funcionarán en el escáner. ¡Estás listo para iniciar la lista del próximo evento!", { parse_mode: 'Markdown' });
                        bot.answerCallbackQuery(callbackQueryId);
                    });
                });
            }).catch(e => {
                console.error("Error enviando respaldo:", e);
                bot.sendMessage(chatId, "❌ Error al enviar el respaldo. No se vació la lista por seguridad.");
                bot.answerCallbackQuery(callbackQueryId);
            });
        });
    }
}

// ================= RUTA DEL ESCÁNER =================

app.post('/api/verify', (req, res) => {
    const { uuid } = req.body;
    if (!uuid) return res.status(400).json({ valid: false, message: 'No se proveyó código QR' });

    db.get(`SELECT qr_codes.*, tickets.name, tickets.ticket_count 
            FROM qr_codes 
            JOIN tickets ON qr_codes.ticket_id = tickets.id 
            WHERE qr_codes.uuid = ?`, [uuid], (err, row) => {
        if (err) return res.status(500).json({ valid: false, message: 'Error del servidor' });
        
        if (!row) return res.json({ valid: false, status: 'invalid', message: '❌ ENTRADA INVÁLIDA (No existe)' });
        
        if (row.status === 'used') {
            return res.json({ valid: false, status: 'used', message: `❌ ENTRADA YA USADA\nNombre: ${row.name}` });
        }
        
        if (row.status === 'approved') {
            // Marcar como usada y registrar hora
            db.run(`UPDATE qr_codes SET status = 'used', scanned_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id], (err) => {
                if (err) return res.status(500).json({ valid: false, message: 'Error actualizando ticket' });
                return res.json({ 
                    valid: true, 
                    status: 'success', 
                    message: `✅ ACCESO PERMITIDO\nNombre: ${row.name}\nEntrada válida para 1 persona.` 
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
