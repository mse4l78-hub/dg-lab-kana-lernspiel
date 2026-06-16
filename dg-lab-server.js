#!/usr/bin/env node
/**
 * DG-Lab WebSocket Server - SOCKET Control Protocol V3
 * Basiert auf dem OpenClaw Plugin von FengYing1314
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const PORT = process.env.DG_LAB_PORT || 18888;
const SERVER_IP = '192.168.0.168';
const CONTROL_ID_FILE = path.join(process.env.HOME, '.dg-lab-control-id');

// Stärke-Werte (werden aus App-Feedback aktualisiert)
let currentStrengthA = 0;
let currentStrengthB = 0;
let maxStrengthA = 200;
let maxStrengthB = 200;

// Lade oder erstelle persistente Control ID
let PERSISTENT_CONTROL_ID;
if (fs.existsSync(CONTROL_ID_FILE)) {
    PERSISTENT_CONTROL_ID = fs.readFileSync(CONTROL_ID_FILE, 'utf8').trim();
    console.log('[DG-Lab] Geladene Control ID:', PERSISTENT_CONTROL_ID);
} else {
    PERSISTENT_CONTROL_ID = `control-${uuidv4().replace(/-/g, '')}`;
    fs.writeFileSync(CONTROL_ID_FILE, PERSISTENT_CONTROL_ID);
    console.log('[DG-Lab] Neue Control ID erstellt:', PERSISTENT_CONTROL_ID);
}

// Maps
const clients = new Map(); // clientId -> { ws, isControl, controlId }
const bindings = new Map(); // clientId -> partnerId
const validControlIds = new Set([PERSISTENT_CONTROL_ID]);

// HTTP Server für QR-Code und Status
const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/qr') {
        // QR-Code Seite
        const qrUrl = `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://${SERVER_IP}:${PORT}/${PERSISTENT_CONTROL_ID}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>DG-Lab QR Code</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a2e; color: #eee; }
        #qrcode { margin: 30px auto; padding: 20px; background: white; display: inline-block; border-radius: 10px; }
        .url { font-family: monospace; background: #16213e; padding: 10px; border-radius: 5px; margin: 20px 0; word-break: break-all; }
    </style>
</head>
<body>
    <h1>🎂 DG-Lab Coyote 3.0 - Socket Control</h1>
    <p>Scanne den QR-Code mit der DG-Lab App</p>
    <div id="qrcode"></div>
    <p>URL:</p>
    <div class="url">${qrUrl}</div>
    <p>Control ID: <strong>${PERSISTENT_CONTROL_ID}</strong></p>
    <script>
        new QRCode(document.getElementById("qrcode"), {
            text: "${qrUrl}",
            width: 256,
            height: 256,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    </script>
</body>
</html>`);
    } else if (url.pathname === '/qr.png') {
        // QR-Code als PNG serverseitig generieren
        try {
            const qrUrl = `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://${SERVER_IP}:${PORT}/${PERSISTENT_CONTROL_ID}`;
            const pngBuffer = await QRCode.toBuffer(qrUrl, { width: 256, margin: 2 });
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(pngBuffer);
        } catch (e) {
            res.writeHead(500);
            res.end('Fehler beim Generieren des QR-Codes');
        }
    } else if (url.pathname === '/status') {
        // Status JSON
        const qrUrl = `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://${SERVER_IP}:${PORT}/${PERSISTENT_CONTROL_ID}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: clients.size > 0,
            clients: clients.size,
            bindings: bindings.size / 2,
            controlId: PERSISTENT_CONTROL_ID,
            url: `ws://${SERVER_IP}:${PORT}/${PERSISTENT_CONTROL_ID}`,
            qrUrl: qrUrl,
            strength: {
                a: currentStrengthA,
                b: currentStrengthB,
                limitA: maxStrengthA,
                limitB: maxStrengthB
            }
        }));
    } else if (url.pathname === '/api/strength' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { channel, value } = JSON.parse(body);
                const result = setStrength(channel, value);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: result, channel, value }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else if (url.pathname === '/api/pulse' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { channel, waveform } = JSON.parse(body);
                const result = sendPulse(channel, waveform);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: result, channel, waveform }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else if (url.pathname === '/command' && req.method === 'POST') {
        // Direkter Befehl
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { message } = JSON.parse(body);
                const result = sendCommandToApps(message);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: result, message }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else if (url.pathname === '/') {
        // Haupt-Controller-Seite
        try {
            const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(500);
            res.end('Fehler beim Laden der Seite: ' + e.message);
        }
    } else {
        res.writeHead(404);
        res.end('Nicht gefunden');
    }
});

// WebSocket Server
const wss = new WebSocket.Server({ server: httpServer });

// Heartbeat
let heartbeatTimer = null;
function startHeartbeat() {
    if (heartbeatTimer) {
        console.log('[DG-Lab] Heartbeat läuft bereits');
        return;
    }
    console.log('[DG-Lab] Starte Heartbeat');
    heartbeatTimer = setInterval(() => {
        console.log(`[DG-Lab] Sende Heartbeats an ${clients.size} Clients`);
        clients.forEach((client, id) => {
            if (client.ws.readyState === WebSocket.OPEN) {
                const hb = {
                    type: 'heartbeat',
                    clientId: id,
                    targetId: '',
                    message: 'heartbeat'
                };
                client.ws.send(JSON.stringify(hb));
                console.log(`[DG-Lab] Heartbeat an: ${id}`);
            }
        });
    }, 20000);
}

// WICHTIG: Sende Befehl an alle gebundenen Apps
function sendCommandToApps(commandStr) {
    let sent = false;
    bindings.forEach((partnerId, myId) => {
        // Prüfe ob myId ein Control ist (im validControlIds Set)
        if (validControlIds.has(myId)) {
            const client = clients.get(partnerId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
                const msg = {
                    type: 'msg',
                    clientId: myId,
                    targetId: partnerId,
                    message: commandStr
                };
                const json = JSON.stringify(msg);
                if (json.length > 1950) {
                    console.warn(`[DG-Lab] Nachricht zu lang (${json.length} > 1950), verworfen`);
                    return;
                }
                client.ws.send(json);
                console.log(`[DG-Lab] Befehl gesendet an App ${partnerId}: ${commandStr}`);
                sent = true;
            }
        }
    });
    return sent;
}

wss.on('connection', (ws, req) => {
    const urlPath = (req.url || '').replace(/^\//, '');
    let assignedControlId = null;
    let isControl = false;

    // Prüfe ob dies ein Control-Endpunkt ist
    if (urlPath && validControlIds.has(urlPath)) {
        assignedControlId = urlPath;
        isControl = true;
        console.log(`[DG-Lab] Control-Endpoint verbunden: ${assignedControlId}`);
    }

    const clientId = uuidv4();
    clients.set(clientId, { ws, isControl, controlId: assignedControlId });

    // Sende initiale BIND Nachricht
    const bindMsg = {
        type: 'bind',
        clientId: clientId,
        targetId: '',
        message: 'targetId'
    };
    ws.send(JSON.stringify(bindMsg));
    console.log(`[DG-Lab] Client verbunden: ${clientId}${assignedControlId ? ` (Control: ${assignedControlId})` : ''}`);

    // Auto-bind für QR-Verbindungen
    if (assignedControlId) {
        bindings.set(assignedControlId, clientId);
        bindings.set(clientId, assignedControlId);

        const successMsg = {
            type: 'bind',
            clientId: assignedControlId,
            targetId: clientId,
            message: '200'
        };
        ws.send(JSON.stringify(successMsg));
        console.log(`[DG-Lab] Auto-bound App (${clientId}) <-> Control (${assignedControlId})`);
    }

    startHeartbeat();

    ws.on('message', (data) => {
        handleMessage(data.toString(), clientId);
    });

    ws.on('close', () => {
        handleDisconnect(clientId);
    });

    ws.on('error', (err) => {
        console.error(`[DG-Lab] WebSocket Fehler für ${clientId}:`, err.message);
    });
});

function handleMessage(jsonData, senderClientId) {
    try {
        const msg = JSON.parse(jsonData);
        const sender = clients.get(senderClientId);

        // Heartbeat ignorieren
        if (msg.type === 'heartbeat') {
            return;
        }

        // BIND Anfrage von App
        if (msg.type === 'bind' && msg.message === 'DGLAB' && msg.clientId && msg.targetId) {
            const controlEndId = msg.clientId;
            const appEndId = msg.targetId;

            if (!validControlIds.has(controlEndId)) {
                console.error(`[DG-Lab] Bind abgelehnt: Ungültige Control ID ${controlEndId}`);
                return;
            }
            if (!clients.has(appEndId)) {
                console.error(`[DG-Lab] Bind abgelehnt: App ${appEndId} nicht verbunden`);
                return;
            }

            // Prüfe ob bereits gebunden
            if (bindings.has(controlEndId) && bindings.get(controlEndId) === appEndId) {
                console.log(`[DG-Lab] Bereits gebunden: ${controlEndId} <-> ${appEndId}`);
                return;
            }

            bindings.set(controlEndId, appEndId);
            bindings.set(appEndId, controlEndId);

            const successMsg = {
                type: 'bind',
                clientId: controlEndId,
                targetId: appEndId,
                message: '200'
            };
            const appClient = clients.get(appEndId);
            if (appClient && appClient.ws.readyState === WebSocket.OPEN) {
                appClient.ws.send(JSON.stringify(successMsg));
            }
            console.log(`[DG-Lab] Bound App (${appEndId}) <-> Control (${controlEndId})`);
        }
        // MSG Weiterleitung
        else if (msg.type === 'msg' && msg.message) {
            // Stärke-Feedback von App
            const strengthFeedback = msg.message.match(/^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/);
            if (strengthFeedback) {
                currentStrengthA = parseInt(strengthFeedback[1]);
                currentStrengthB = parseInt(strengthFeedback[2]);
                maxStrengthA = parseInt(strengthFeedback[3]);
                maxStrengthB = parseInt(strengthFeedback[4]);
                console.log(`[DG-Lab] Stärke A:${currentStrengthA}/${maxStrengthA} B:${currentStrengthB}/${maxStrengthB}`);
            }

            // Feedback Buttons
            const feedbackMatch = msg.message.match(/^feedback-(\d)$/);
            if (feedbackMatch) {
                console.log(`[DG-Lab] APP Feedback Button gedrückt: index=${feedbackMatch[1]}`);
            }

            // Weiterleiten an Partner
            if (msg.targetId) {
                const recipient = clients.get(msg.targetId);
                if (recipient && recipient.ws.readyState === WebSocket.OPEN) {
                    recipient.ws.send(jsonData);
                    console.log(`[DG-Lab] Weiterleiten an: ${msg.targetId}`);
                }
            }
        }
    } catch (error) {
        console.error('[DG-Lab] Fehler beim Verarbeiten:', error.message);
    }
}

function handleDisconnect(clientId) {
    const client = clients.get(clientId);
    clients.delete(clientId);

    const partnerId = bindings.get(clientId);
    if (partnerId) {
        bindings.delete(clientId);
        bindings.delete(partnerId);

        const partner = clients.get(partnerId);
        if (partner && partner.ws.readyState === WebSocket.OPEN) {
            const breakMsg = {
                type: 'break',
                clientId: clientId,
                message: '209'
            };
            partner.ws.send(JSON.stringify(breakMsg));
        }
        console.log(`[DG-Lab] Client ${clientId} getrennt, Partner ${partnerId} benachrichtigt`);
    } else {
        console.log(`[DG-Lab] Client getrennt: ${clientId}`);
    }
}

// API Funktionen für externe Steuerung
function setStrength(channel, value) {
    // channel: 'A' oder 'B', value: 0-200
    // Setzt die Stärke auf einen absoluten Wert
    const ch = channel === 'A' ? '1' : '2';
    const currentValue = channel === 'A' ? currentStrengthA : currentStrengthB;
    const diff = value - currentValue;
    
    console.log(`[DG-Lab] Setze Stärke ${channel}: aktuell=${currentValue}, gewünscht=${value}, diff=${diff}`);
    
    if (diff > 0) {
        // Erhöhen
        console.log(`[DG-Lab] Erhöhe um ${diff}`);
        return sendCommandToApps(`strength-${ch}+1+${diff}`);
    } else if (diff < 0) {
        // Verringern
        console.log(`[DG-Lab] Verringere um ${Math.abs(diff)}`);
        return sendCommandToApps(`strength-${ch}+2+${Math.abs(diff)}`);
    }
    // Keine Änderung nötig
    console.log(`[DG-Lab] Keine Änderung nötig`);
    return true;
}

function addStrength(channel, delta) {
    const ch = channel === 'A' ? '1' : '2';
    return sendCommandToApps(`strength-${ch}+1+${delta}`);
}

function subStrength(channel, delta) {
    const ch = channel === 'A' ? '1' : '2';
    return sendCommandToApps(`strength-${ch}+2+${delta}`);
}

function sendPulse(channel, waveformHexArray) {
    // waveformHexArray ist ein Array von Hex-Strings
    const waveformJson = JSON.stringify(waveformHexArray);
    return sendCommandToApps(`pulse-${channel}:${waveformJson}`);
}

function clearQueue(channel) {
    return sendCommandToApps(`clear-${channel}`);
}

httpServer.listen(PORT, () => {
    console.log(`[DG-Lab] Server läuft auf http://${SERVER_IP}:${PORT}`);
    console.log(`[DG-Lab] WebSocket: ws://${SERVER_IP}:${PORT}/${PERSISTENT_CONTROL_ID}`);
    console.log(`[DG-Lab] QR Code: http://${SERVER_IP}:${PORT}/qr`);
});

// Exportiere API für Module
module.exports = {
    setStrength,
    addStrength,
    subStrength,
    sendPulse,
    clearQueue,
    sendCommandToApps,
    getStatus: () => ({
        connected: clients.size > 0,
        clients: clients.size,
        bindings: bindings.size / 2,
        controlId: PERSISTENT_CONTROL_ID
    })
};
