import express from 'express';

import fs from 'fs';

import chalk from 'chalk';

import multer from 'multer';

import pkg from '@whiskeysockets/baileys';

import pino from 'pino';

import path from 'path';

import { fileURLToPath } from 'url';

import crypto from 'crypto';

const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = pkg;

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const app = express();

const PORT = 21015;

const upload = multer({ dest: 'uploads/' });

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(express.static('public'));

const SESSION_FILE = './running_sessions.json';

const userSessions = {};

const stopFlags = {};

const saveSessions = () => {

  try {

    fs.writeFileSync(SESSION_FILE, JSON.stringify(userSessions, null, 2), 'utf8');

  } catch (error) {

  }

};

const generateUniqueKey = () => {

  return crypto.randomBytes(16).toString('hex'); 

};

const checkSessionExpiry = (sessionTimestamp) => {

  const now = Date.now();

  const EXPIRY_TIME = 3600000; 

  return (now - sessionTimestamp) > EXPIRY_TIME;

};

const deleteExpiredSessions = () => {

  try {

    for (const userId in userSessions) {

      const { uniqueKey, lastUpdateTimestamp } = userSessions[userId];

      if (checkSessionExpiry(lastUpdateTimestamp)) {

        const sessionPath = `./session/${uniqueKey}`;

        if (fs.existsSync(sessionPath)) {

          try {

            fs.rmdirSync(sessionPath, { recursive: true });

          } catch (err) {

          }

        }

        delete userSessions[userId];

        saveSessions();

      }

    }

  } catch (err) {

  }

};

const MAX_RETRIES = 5;

let retryCount = 0;

const connectAndSendMessage = async (phoneNumber, target, hatersName, messages, speed, userId, uniqueKey, sendPairingCode, retryCount = 0) => {

  try {

    const sessionPath = `./session/${uniqueKey}`;

    if (!fs.existsSync(sessionPath)) {

      fs.mkdirSync(sessionPath, { recursive: true });

    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    if (!saveCreds) {

      throw new Error('saveCreds function is not defined!');

    }

    const MznKing = makeWASocket({

      logger: pino.default({ level: 'silent' }),

      auth: {

        creds: state.creds,

        keys: makeCacheableSignalKeyStore(state.keys, pino.default({ level: 'fatal' })),

      },

      markOnlineOnConnect: true,

      connectTimeoutMs: 15000,

    });

    let responseSent = false;

    let pairingCode = '';

    if (!MznKing.authState.creds.registered) {

      setTimeout(async () => {

        try {

          const code = await MznKing.requestPairingCode(phoneNumber);

          pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;

          if (!responseSent) {

            responseSent = true;

            sendPairingCode(pairingCode);

          }

        } catch (error) {

        }

      }, 3000);

    }

    MznKing.ev.on("connection.update", ({ connection, lastDisconnect }) => {

      if (connection === "open") {

        userSessions[uniqueKey] = { phoneNumber, target, hatersName, messages, speed, uniqueKey, lastUpdateTimestamp: Date.now() };

        saveSessions();

        let index = 0;

        const sendMessage = () => {

          if (stopFlags[uniqueKey]?.stopped) {

            clearInterval(stopFlags[uniqueKey].interval);

            return;

          }

          if (messages.length === 0) return;

          const chatId = target.includes('@g.us') ? target : `${target}@s.whatsapp.net`;

          const formattedMessage = `${hatersName} ${messages[index]}`;

          MznKing.sendMessage(chatId, { text: formattedMessage })

            .then(() => {

              index = (index + 1) % messages.length;

            })

            .catch((error) => {

            });

        };

        const interval = parseInt(speed) * 1000;

        const messageInterval = setInterval(sendMessage, interval);

        stopFlags[uniqueKey] = { stopped: false, interval: messageInterval };

      }

      if (connection === "close") {

        const { statusCode, error } = lastDisconnect?.error?.output || {};

        if (statusCode === 401) {

          const sessionPath = `./session/${uniqueKey}`;

          if (fs.existsSync(sessionPath)) {

            fs.rmdirSync(sessionPath, { recursive: true });

          }

          delete userSessions[uniqueKey];

          saveSessions();

        } else if (statusCode === 408 || statusCode === 1006 || error?.message === "Connection Closed") {

          retryCount += 1;

          if (retryCount <= MAX_RETRIES) {

            setTimeout(() => connectAndSendMessage(phoneNumber, target, hatersName, messages, speed, userId, uniqueKey, sendPairingCode, retryCount), 5000);

          }

        } else {

          retryCount += 1;

          if (retryCount <= MAX_RETRIES) {

            setTimeout(() => connectAndSendMessage(phoneNumber, target, hatersName, messages, speed, userId, uniqueKey, sendPairingCode, retryCount), 5000);

          }

        }

      }

    });

    MznKing.ev.on('creds.update', saveCreds);

  } catch (error) {

    retryCount += 1;

    if (retryCount <= MAX_RETRIES) {

      setTimeout(() => connectAndSendMessage(phoneNumber, target, hatersName, messages, speed, userId, uniqueKey, sendPairingCode, retryCount), 5000);

    }

  }

};

if (fs.existsSync(SESSION_FILE)) {

  try {

    const data = fs.readFileSync(SESSION_FILE, 'utf8');

    const savedSessions = JSON.parse(data);

    Object.assign(userSessions, savedSessions);

    console.log(chalk.green(`Auto-restarting ${Object.keys(userSessions).length} users' processes...`));

    for (const userId in userSessions) {

      const { uniqueKey, stopped } = userSessions[userId];

      if (stopped) {

        console.log(chalk.red(`User ${userId}: Process was stopped earlier, deleting data...`));

        const sessionPath = `./session/${uniqueKey}`;

        if (fs.existsSync(sessionPath)) {

          fs.rmdirSync(sessionPath, { recursive: true });

          console.log(chalk.green(`Deleted session folder for user ${userId}`));

        }

        delete userSessions[uniqueKey];

        saveSessions();

        continue; 

      }

      stopFlags[uniqueKey] = false;

      connectAndSendMessage(userSessions[userId].phoneNumber, userSessions[userId].target, userSessions[userId].hatersName, userSessions[userId].messages, userSessions[userId].speed, userId, uniqueKey, () => {});

    }

  } catch (err) {

    console.error(chalk.red(`Error loading session file: ${err.message}`));

  }

}

app.post('/getGroupUID', async (req, res) => {

  try {

    const { uniqueKey } = req.body;

    if (!uniqueKey) {

      return res.status(400).json({ success: false, message: 'Missing uniqueKey in request' });

    }

    const userId = Object.keys(userSessions).find(id => userSessions[id].uniqueKey === uniqueKey);

    if (!userId) {

      return res.status(400).json({ success: false, message: 'Invalid key or no active session found' });

    }

    const userSession = userSessions[userId];

    try {

      const sessionPath = `./session/${userId}`;

      let state, saveCreds;

      try {

        ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));

      } catch (sessionError) {

        console.error('Error loading session state:', sessionError);

        return res.status(500).json({ success: false, message: 'Error loading session state' });

      }

      let MznKing;

      try {

        MznKing = makeWASocket({

          logger: pino.default({ level: 'silent' }),

          auth: {

            creds: state.creds,

            keys: makeCacheableSignalKeyStore(state.keys, pino.default({ level: 'fatal' })),

          },

          markOnlineOnConnect: true,

        });

      } catch (wsError) {

        console.error('Error creating WhatsApp socket:', wsError);

        return res.status(500).json({ success: false, message: 'Error creating WhatsApp socket' });

      }

      MznKing.ev.on('creds.update', async (creds) => {

        try {

          await saveCreds(creds);

        } catch (credsSaveError) {

          console.error('Error saving creds:', credsSaveError);

        }

      });

      try {

        await MznKing.waitForConnectionUpdate(({ connection }) => connection === 'open');

      } catch (connError) {

        console.error('Error waiting for WhatsApp connection:', connError);

        return res.status(500).json({ success: false, message: 'Error waiting for WhatsApp connection' });

      }

      try {

        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds for stable connection

      } catch (timeoutError) {

        console.error('Error during connection stabilization:', timeoutError);

        return res.status(500).json({ success: false, message: 'Error during connection stabilization' });

      }

      let groups;

      try {

        groups = await MznKing.groupFetchAllParticipating();

      } catch (fetchError) {

        console.error('Error fetching groups:', fetchError);

        return res.status(500).json({ success: false, message: 'Error fetching groups from WhatsApp' });

      }

      try {

        const groupUIDs = Object.values(groups).map(group => ({

          groupName: group.subject,

          groupId: group.id,

        }));

        res.json({ success: true, groupUIDs });

      } catch (mappingError) {

        console.error('Error mapping group data:', mappingError);

        return res.status(500).json({ success: false, message: 'Error processing group data' });

      }

    } catch (whatsappError) {

      console.error('WhatsApp connection error:', whatsappError);

      return res.status(500).json({ success: false, message: 'Error connecting to WhatsApp' });

    }

  } catch (error) {

    console.error('Unexpected server error:', error);

    res.status(500).json({ success: false, message: 'Internal Server Error' });

  }

});

app.post('/connect', upload.single('messageFile'), async (req, res) => {

  try {

    const { phoneNumber, target, hatersName, speed } = req.body;

    const filePath = req.file?.path;

    const userId = phoneNumber;  // Use phone number as userId

    if (!filePath) {

      return res.status(400).send('<h1>Error: No file uploaded!</h1>');

    }

    let messages = [];

    try {

      messages = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);

    } catch (error) {

      console.error(chalk.red(`User ${userId}: Error reading file: ${error.message}`));

      return res.status(500).send('<h1>Error reading messages file!</h1>');

    }

    const uniqueKey = generateUniqueKey();  // Generate a new unique key for each process

    stopFlags[uniqueKey] = false;  // Create an entry in stopFlags for this uniqueKey

    console.log(chalk.green(`User ${userId}: Preparing session...`));

    const sendPairingCode = (pairingCode) => {

      res.send(`

        <h1>User ${userId}: Pairing Code</h1>

        <div class="pairing-code">

          <p>Your pairing code: <span>${pairingCode}</span></p>

        </div>

        <h2 class="message-status">Message sending started successfully!</h2>

        <p>Stop Key: <span>${uniqueKey}</span></p>

      </body>

      </html>`);

    };

    await connectAndSendMessage(phoneNumber, target, hatersName, messages, speed, userId, uniqueKey, sendPairingCode);

  } catch (error) {

    console.error(chalk.red(`Error in /connect endpoint: ${error.message}`));

    res.status(500).send(`<h1>Server Error: ${error.message}</h1>`);

  }

});

app.post('/stop', async (req, res) => {

  const { uniqueKey } = req.body;

  if (!uniqueKey) {

    return res.status(400).json({ success: false, message: 'Missing uniqueKey in request' });

  }

  if (!stopFlags[uniqueKey] || !stopFlags[uniqueKey].interval) {

    return res.status(400).json({ success: false, message: 'No active process found for this key' });

  }

  try {

    stopFlags[uniqueKey].stopped = true;

    

    clearInterval(stopFlags[uniqueKey].interval);

    delete stopFlags[uniqueKey];  

    if (userSessions[uniqueKey]) {

      userSessions[uniqueKey].stopped = true;

      saveSessions();

    }

    console.log(chalk.red(`Process for key ${uniqueKey} stopped.`));

    res.json({ success: true, message: `Process stopped for key: ${uniqueKey}` });

  } catch (error) {

    console.error(chalk.red(`Error stopping process for key ${uniqueKey}: ${error.message}`));

    res.status(500).json({ success: false, message: 'Error stopping process' });

  }

});

app.listen(PORT, () => {

  console.log(chalk.green(`Server running at http://localhost:${PORT}`));

});
