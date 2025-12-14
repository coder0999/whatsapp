const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { pino } = require('pino');
const fs = require('fs');
const qrcode = require('qrcode-terminal');

// Firebase Admin SDK initialization
const admin = require('firebase-admin');
const serviceAccount = require('./whatsapp-140cd-firebase-adminsdk-fbsvc-ae4aecdbb0.json'); // Path to your service account key

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Initialize Firestore (or Realtime Database if you prefer)
const db = admin.firestore();



// IMPORTANT: Replace 'YOUR_GEMINI_API_KEY_HERE' with your actual Gemini API Key.
// You can get one from Google AI Studio: https://makersuite.google.com/
const GEMINI_API_KEY_PLACEHOLDER = 'AIzaSyAuHVDn-dpZvVash5MpV-6zKTwro6YQLy4'; 

// Function to call Gemini API with conversation history
async function getGeminiResponse(history, newPrompt) {
  const apiKey = GEMINI_API_KEY_PLACEHOLDER;
  if (apiKey === 'YOUR_GEMINI_API_KEY_HERE' || !apiKey) {
    return 'Error: GEMINI_API_KEY not set. Please replace "YOUR_GEMINI_API_KEY_HERE" with your actual API key in index.js';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  // Construct the contents array for the Gemini API from the history
  const contents = history.map(msg => ({
    role: msg.sender === 'bot' ? 'model' : 'user',
    parts: [{ text: msg.text || '' }] // Ensure text is not undefined
  }));

  // Add the new user message
  contents.push({
    role: 'user',
    parts: [{ text: newPrompt }]
  });

  // Prepend a system prompt to the beginning of the conversation
  const currentDate = new Date().toISOString();
  contents.unshift({
    role: 'user',
    parts: [{ text: `You are Mohamed’s personal secretary, and you reply on his behalf to everyone who messages him on WhatsApp. Your personality is simple and direct, speaking in respectful, calm, clear, and non-formal Egyptian Arabic.

**Your Primary Role & Duties:**
Your main duties are to handle communication professionally. This includes:
1.  Receiving messages and understanding requests.
2.  Replying professionally.
3.  Politely declining any requests unrelated to Mohamed's work.

**Current Date for Context: ${currentDate}**

**Communication Rules:**
-   **Tone:** Friendly Egyptian Arabic, short, organized sentences, no filler.
-   **Clarity:** If a message is unclear, ask only one direct clarifying question.
-   **Identity:** Do not say you are an AI. Use phrases like “I’m Mohamed’s secretary” or “I’ll inform Mohamed.”
-   **Language:** Do not use formal Arabic or English unless the user starts with them.
-   **Boundaries:** Never discuss general topics, politics, religion, or make unrealistic promises.

Your ultimate goal is to make all communication with Mohamed smooth, organized, and professional.` }]
  }, {
    role: 'model',
    parts: [{ text: 'Okay, I will.' }]
  });

  const requestBody = {
    contents: contents
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
      controller.abort();
  }, 30000); // 30-second timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Gemini API Error:', errorData);
      return `Sorry, I encountered an error with the AI service: ${response.status}`;
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
      return data.candidates[0].content.parts[0].text;
    } else {
      // Log the unexpected structure for debugging
      console.error('Unexpected Gemini API response structure:', JSON.stringify(data, null, 2));
      return 'Sorry, I received an unexpected response from the AI.';
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Gemini API call timed out.');
      return 'Sorry, the request to the AI service timed out.';
    }
    console.error('Error calling Gemini API:', error);
    return 'Sorry, I was unable to connect to the AI service.';
  } finally {
      clearTimeout(timeoutId);
  }
}

// Function to save messages to Firestore
async function saveMessageToDb(jid, message) {
  // Ensure the message object has a 'sender' field
  if (!message.sender) {
    console.error('Attempted to save a message without a sender.');
    return;
  }
  try {
    const conversationRef = db.collection('conversations').doc(jid);
    await conversationRef.collection('messages').add({
      ...message,
      timestamp: admin.firestore.FieldValue.serverTimestamp() // Use server timestamp
    });
    console.log(`Saved message from ${message.sender} in conversation ${jid} to Firestore.`);
  } catch (error) {
    console.error(`Error saving message to Firestore for ${jid}:`, error);
  }
}

// Function to manage user profile history
async function updateUserProfile(sock, jid, msg) {
  try {
    const conversationRef = db.collection('conversations').doc(jid);
    const conversationDoc = await conversationRef.get();
    const currentPushName = msg.pushName || 'غير متوفر';

    let pfpUrl = 'https://via.placeholder.com/50'; // Default placeholder
    try {
      pfpUrl = await sock.profilePictureUrl(jid, 'image');
    } catch (e) {
      console.error(`Could not fetch profile picture for ${jid}:`, e);
      // Keep the placeholder URL on error
    }

    const newProfileSnapshot = {
      pushName: currentPushName,
      pfpUrl: pfpUrl,
      capturedAt: new Date()
    };

    if (!conversationDoc.exists) {
      // For a new conversation, set the initial profile history.
      // Use { merge: true } to avoid overwriting the messages subcollection.
      await conversationRef.set({
        profileHistory: [newProfileSnapshot]
      }, { merge: true });
      console.log(`Created initial profile for new user ${jid}.`);
    } else {
      // User exists, check if their profile has changed
      const conversationData = conversationDoc.data();
      const history = conversationData.profileHistory || [];
      const lastSnapshot = history.length > 0 ? history[history.length - 1] : null;

      if (!lastSnapshot || lastSnapshot.pushName !== newProfileSnapshot.pushName || lastSnapshot.pfpUrl !== newProfileSnapshot.pfpUrl) {
        // Profile has changed, add the new snapshot to the history
        await conversationRef.update({
          profileHistory: admin.firestore.FieldValue.arrayUnion(newProfileSnapshot)
        });
        console.log(`Profile changed for ${jid}. Added new snapshot to history.`);
      }
    }
  } catch (error) {
    console.error(`Error updating user profile for ${jid}:`, error);
  }
}

// Function to find a user's name from past interactions stored in Firestore
async function findUserNameInDb(jid) {
    try {
        const conversationRef = db.collection('conversations').doc(jid);
        const doc = await conversationRef.get();
        if (doc.exists) {
            const data = doc.data();
            if (data.profileHistory && data.profileHistory.length > 0) {
                // Get the most recent name from the profile history
                return data.profileHistory[data.profileHistory.length - 1].pushName;
            }
        }
    } catch (error) {
        console.error(`Error fetching user name from DB for ${jid}:`, error);
    }
    return null;
}




// Function to format 24-hour time to 12-hour time with AM/PM
function formatTo12Hour(time24h) {
  if (!time24h) return '';
  const [hourStr, minuteStr] = time24h.split(':');
  let hours = parseInt(hourStr, 10);
  const minutes = parseInt(minuteStr, 10);
  const ampm = hours >= 12 ? 'م' : 'ص'; // Arabic for PM/AM

  hours = hours % 12;
  hours = hours === 0 ? 12 : hours; // The hour '0' should be '12'

  const formattedMinutes = minutes < 10 ? '0' + minutes : minutes;

  return `${hours}:${formattedMinutes} ${ampm}`;
}


// --- New Scheduling Functions ---

async function connectToWhatsApp() {
  const authDir = 'baileys_auth';
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  
  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
  });

  // State management for the new command
  const lastBotMessageForJid = new Map();
  const lastReactionForJid = new Map();
  const messageStatusForJid = new Map();


  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => { // Added 'async' keyword here
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
      // If authentication failed (401), clear auth files and restart to generate new QR
      if (lastDisconnect?.error?.output?.statusCode === 401) {
        console.log('Authentication failed. Deleting session files and restarting to generate a new QR code...');
        fs.readdirSync(authDir).forEach(file => fs.unlinkSync(`${authDir}/${file}`));
        await connectToWhatsApp(); // Restart to generate new QR
      } else if (shouldReconnect) {
        console.log('Connection closed, attempting to reconnect...');
        await connectToWhatsApp();
      } else {
        console.log('Connection closed. Not reconnecting due to fatal error.');
      }
    } else if (connection === 'open') {
      console.log('Connection is open!');
    }

    if (qr) {
      console.log('QR code received. Scan it using your WhatsApp app:');
      qrcode.generate(qr, { small: true });
    }
  });

  // Event handler for reactions
  sock.ev.on('messages.reaction', (reactions) => {
    for (const reaction of reactions) {
        const userJid = reaction.key.remoteJid;
        const lastBotMsg = lastBotMessageForJid.get(userJid);
        
        // Check if the reaction is for the last message the bot sent and is from the user
        if (lastBotMsg && reaction.key.id === lastBotMsg.key.id && reaction.reaction && !reaction.reaction.key.fromMe) {
            const reactionText = reaction.reaction.text;
            console.log(`Reaction "${reactionText}" from ${userJid} for message ${reaction.key.id} stored.`);
            lastReactionForJid.set(userJid, reactionText);
        }
    }
  });

  // Event handler for message updates (including read receipts)
  sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
          const { key, update: messageUpdate } = update;
          const userJid = key.remoteJid;
          const lastBotMsg = lastBotMessageForJid.get(userJid);

          // Check if the update is for the last message we sent and has a status update
          if (lastBotMsg && key.id === lastBotMsg.key.id && messageUpdate?.status) {
              // Status 4 appears to be 'READ' based on logs
              if (messageUpdate.status === 4) {
                  console.log(`Read receipt for ${userJid} for message ${key.id} stored.`);
                  messageStatusForJid.set(userJid, 'تمت المشاهدة');
              }
          }
      }
  });

  // Event handler for read receipts (the other possible event)
  sock.ev.on('message-receipt.update', (updates) => {
      console.log('--- MESSAGE RECEIPT UPDATE EVENT ---');
      console.log(JSON.stringify(updates, null, 2));
      for(const { key, receipt } of updates) {
        const lastBotMsg = lastBotMessageForJid.get(key.remoteJid);
        // check if the receipt is for the last message we sent
        if(lastBotMsg && key.id === lastBotMsg.key.id) {
            // if the user has read the message
            if(receipt.receiptType === 'read' || receipt.receiptType === 'read-self') {
               console.log(`Read receipt (via receipt.update) for ${key.remoteJid} for message ${key.id} stored.`);
               messageStatusForJid.set(key.remoteJid, 'تمت المشاهدة');
            }
        }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log('--- MESSAGES.UPSERT EVENT ---');
    console.log(JSON.stringify(messages, null, 2));
    const msg = messages[0];
    if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast' || !msg.message) return;

    const senderJid = msg.key.remoteJid;
    const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    // Handle group messages
    if (senderJid.endsWith('@g.us')) {
        if (messageText.trim() === '.هام') {
            try {
                // Fetch group metadata
                const groupMetadata = await sock.groupMetadata(senderJid);
                
                // Get the sender's participant object
                const senderParticipant = groupMetadata.participants.find(p => p.id === msg.key.participant);

                // Check if the sender is an admin
                const isAdmin = senderParticipant?.admin === 'admin' || senderParticipant?.admin === 'superadmin';

                if (isAdmin) {
                    // Fetch all participant JIDs
                    const participants = groupMetadata.participants.map(p => p.id);
                    
                    // Create the "Read More" separator
                    const readMore = '‌​‌‌‌‌‌‌​‌​‌‌‌‌‌​​​​‌‌‌‌‌‌​‌‌‌‌‌‌‌​​‌‌‌‌‌‌‌‌​‌‌​‌‌‌‌​‌​​‌​​​​​‌​‌​‌‌‌‌‌​‌‌​‌‌‌‌‌​‌‌​‌‌‌‌‌‌‌‌​‌​‌‌‌​​​‌​‌​‌‌​​‌‌​‌​‌‌‌‌​‌‌​‌​​​​​‌‌‌​​‌‌‌​​‌​‌‌​‌‌​​‌​‌​‌​​‌‌​‌‌​​‌‌​‌‌‌‌‌‌​‌​‌‌​​‌‌‌‌‌​‌​‌‌​‌​​​‌‌‌‌‌‌‌‌​‌‌​‌​​​‌‌‌‌‌​​​‌​‌​​​​‌​​‌‌​‌‌‌​‌​‌‌‌‌‌‌‌​​‌​​​​‌​‌​​​‌​‌​‌‌‌‌‌‌‌‌‌‌​​‌‌​​‌​​​‌‌​​‌‌​‌‌​‌​‌‌‌‌​​‌‌‌​‌​‌​​​‌‌‌‌​​​​‌​​‌‌‌​‌‌‌‌‌‌​‌‌‌‌‌‌​‌‌‌​​‌​‌‌‌​​‌‌‌​​‌‌‌‌‌‌‌‌​‌​​‌​‌​‌​​‌​‌‌‌​‌‌​‌​‌‌‌‌​‌‌​‌​‌​‌​‌‌‌‌‌‌​​‌​‌​‌‌‌‌‌​​‌​‌‌​‌​​​‌​​‌‌‌‌‌‌‌‌​​‌​‌​‌‌‌‌​‌‌‌‌‌‌‌‌‌‌​‌‌​‌‌​‌‌‌‌‌‌‌‌‌‌‌‌‌‌‌‌‌​​‌‌​‌‌‌​‌​‌​​‌​​‌​​‌‌‌‌‌‌​​‌‌​‌​​‌‌‌‌​‌​‌‌‌‌​​‌‌‌‌‌‌‌‌‌​​​‌‌‌‌‌‌‌‌‌‌​‌‌‌‌‌‌​​​​‌​​‌‌​‌‌‌‌‌​‌​​​‌‌​‌​​​‌​‌​​‌​‌‌​‌​​​​‌​​‌​‌​‌​‌‌‌‌​‌‌‌​​‌‌‌‌​‌​​​‌​‌‌‌​‌‌‌‌​‌‌​​‌​‌‌​​‌​‌‌​‌‌‌‌​‌​​‌​‌‌‌​‌‌​​‌‌‌‌​‌‌​‌‌‌​‌​‌‌​‌‌​‌​‌‌‌​‌‌‌​‌‌‌‌‌‌​​​​​​‌​‌‌​​‌‌‌​‌​‌​‌‌​​‌​​‌​‌‌‌‌‌‌‌‌‌​‌‌​‌‌‌‌​​​​‌‌​‌‌​‌‌‌‌‌‌‌​‌‌​‌‌‌​​‌​​​​​‌​​‌​‌‌​‌​‌​‌‌‌‌‌‌‌‌​​‌‌​‌​‌‌‌​‌‌‌‌​‌‌‌‌​​‌‌‌​‌​‌​‌‌‌​‌​​‌​‌​​​‌‌​‌‌​‌‌‌‌‌​‌‌‌‌‌​​‌‌‌​‌‌​‌​​​‌​‌​‌‌​‌‌​‌​​‌​‌‌​‌‌‌‌‌‌​‌‌​‌‌​‌‌‌​‌​​‌‌​​​​​​​‌‌‌‌‌​‌‌‌‌‌​‌‌‌‌​‌​​​​‌‌​​​​​‌‌‌​​‌‌​‌‌​​‌‌‌‌‌‌‌‌‌‌​​​‌‌‌‌‌‌‌‌‌​‌​‌‌‌​​‌‌​‌​‌‌‌​‌​‌‌​‌‌‌‌‌​​‌​‌‌‌​​​​‌‌‌‌‌‌​‌​‌‌‌​​​‌‌‌‌​‌‌​‌‌​‌‌‌‌‌‌‌‌​‌‌‌‌‌​​‌‌‌​​‌‌‌‌​‌‌​​​​‌‌‌‌​‌‌‌‌‌‌​‌​‌‌‌‌‌​​​​‌‌‌‌‌‌​‌‌‌‌‌‌‌​​‌‌‌‌‌‌‌‌​‌‌​‌‌‌‌​‌​​‌​​​​​‌​‌​‌‌‌‌‌​‌‌​‌‌‌‌‌​‌‌​‌‌‌‌‌‌‌‌​‌​‌‌‌​​​‌​‌​‌‌​​‌‌​‌​‌‌‌‌​‌‌​‌​​​​​‌‌‌​​‌‌‌​​‌​‌‌​‌‌​​‌​‌​‌​​‌‌​‌‌​​‌‌​‌‌‌‌‌‌​‌​‌‌​​‌‌‌‌‌​‌​‌‌​‌​​​‌‌‌‌‌‌‌‌​‌‌​‌​​​‌‌‌‌‌​​​‌​‌​​​​‌​​‌‌​‌‌‌​‌​‌‌‌‌‌‌‌​​‌​​​​‌​‌​​​‌​‌​‌‌‌‌‌‌‌‌‌‌​​‌‌​​‌​​​‌‌​​‌‌​‌‌​‌​‌‌‌‌​​‌‌‌​‌​‌​​​‌‌‌‌​​​​‌​​‌‌‌​‌‌‌‌‌‌​‌‌‌‌‌‌​‌‌‌​​‌​‌‌‌​​‌‌‌​​‌‌‌‌‌‌‌‌​‌​​‌​‌​‌​​‌​‌‌‌​‌‌​‌​‌‌‌‌​‌‌​‌​‌​‌​‌‌‌‌‌‌​​‌​‌​‌‌‌‌‌​​‌​‌‌​‌​​​‌​​‌‌‌‌‌‌‌‌​​‌​‌​‌‌‌‌​‌‌‌‌‌‌‌‌‌‌​‌‌​‌‌​‌‌‌‌‌‌‌‌‌‌‌‌‌‌‌‌‌​​‌‌​‌‌‌​‌​‌​​‌​​‌​​‌‌‌‌‌‌​​‌‌​‌​​‌‌‌‌​‌​‌‌‌‌​​‌‌‌‌‌‌‌‌‌​​​‌‌‌‌‌‌‌‌‌‌​‌‌‌‌‌‌​​​​‌​​‌‌​‌‌‌‌‌​‌​​​‌‌​‌​​​‌​‌​​‌​‌‌​‌​​​​‌​​‌​‌​‌​‌‌‌‌​‌‌‌​​‌‌‌‌​‌​​​‌​‌‌‌​‌‌‌‌​‌‌​​‌​‌‌​​‌​‌‌​‌‌‌‌​‌​​‌​‌‌‌​‌‌​​‌‌‌‌​‌‌​‌‌‌​‌​‌‌​‌‌​‌​‌‌‌​‌‌‌​‌‌‌‌‌‌​​​​​​‌​‌‌​​‌‌‌​‌​‌​‌‌​​‌​​‌​‌‌‌‌‌‌‌‌‌​‌‌​‌‌‌‌​​​​‌‌​‌‌​‌‌‌‌‌‌‌​‌‌​‌‌‌​​‌​​​​​‌​​‌​‌‌​‌​‌​‌‌‌‌‌‌‌‌​​‌‌​‌​‌‌‌​‌‌‌‌​‌‌‌‌​​‌‌‌​‌​‌​‌‌‌​‌​​‌​‌​​​‌‌​‌‌​‌‌‌‌‌​‌‌‌‌‌​​‌‌‌​‌‌​‌​​​‌​‌​‌‌​‌‌​‌​​‌​‌‌​‌‌‌‌‌‌​‌‌​‌‌​‌‌‌​‌​​‌‌​​​​​​​‌‌‌‌‌​‌‌‌‌‌​‌‌‌‌​‌​​​​‌‌​​​​​‌‌‌​​‌‌​‌‌​​‌‌‌‌‌‌‌‌‌‌​​​‌‌‌‌‌‌‌‌‌​‌​‌‌‌​​‌‌​‌​‌‌‌​‌​‌‌​‌‌‌‌‌​​‌​‌‌‌​​​​‌‌‌‌‌‌​‌​‌‌‌​​​‌‌‌‌​‌‌​‌‌​‌‌‌‌‌‌‌‌​‌‌‌‌‌​​‌‌‌​​‌‌‌‌​‌‌​​​​‌‌‌‌'

                    // Create the mention text
                    let mentions = "";
                    for(const jid of participants) {
                        // The `@{number}` format is a placeholder; Baileys replaces it with the actual mention.
                        mentions += `@${jid.split('@')[0]} `;
                    }
                    
                    const mentionText = "رسالة هامة للجميع:" + readMore + "\n\n" + mentions;

                    // Send the message with mentions
                    await sock.sendMessage(senderJid, { 
                        text: mentionText, 
                        mentions: participants 
                    });
                    console.log(`Sent important message to all members in group ${senderJid} by admin ${msg.key.participant}`);
                } else {
                    console.log(`User ${msg.key.participant} in group ${senderJid} tried to use .هام command without admin privileges.`);
                }
            } catch (error) {
                console.error(`Failed to handle .هام command in group ${senderJid}:`, error);
            }
        }
        // Always return after processing a group message, as the bot's main purpose is 1-on-1 chats.
        return;
    }

    if (!messageText) {
        return; // Ignore messages with no text content
    }
    
    // Save incoming user message to Firestore so it appears in the admin panel
    await saveMessageToDb(senderJid, {
        text: messageText,
        sender: senderJid,
        id: msg.key.id
    });

    // Update user profile history
    await updateUserProfile(sock, senderJid, msg);

    // Command: "حالة الرسالة" (Message Status)
    if (messageText.toLowerCase() === 'حالة الرسالة') {
        const lastBotMsg = lastBotMessageForJid.get(senderJid);
        if (!lastBotMsg) {
            await sock.sendMessage(senderJid, { text: 'لم أرسل لك أي رسالة بعد.' });
            return;
        }

        const reaction = lastReactionForJid.get(senderJid) || 'لا يوجد تفاعل';
        const readStatus = messageStatusForJid.get(senderJid) || 'لم تتم المشاهدة بعد';

        const statusReport = [
            `تقرير عن آخر رسالة أرسلتها لك:`,
            `- التفاعل: ${reaction}`,
            `- حالة المشاهدة: ${readStatus}`
        ].join('\n');
        const sentMsg = await sock.sendMessage(senderJid, { text: statusReport });
        await saveMessageToDb(senderJid, {
            text: statusReport,
            sender: 'bot',
            id: sentMsg.key.id
        });
        return;
    }

    // Check for "my number" command using the user's specified logic
    if (messageText.toLowerCase().includes('my number') || messageText.includes('رقمي')) {
        const userJid = senderJid; // isGroup is always false here
        const phoneNumber = userJid.split('@')[0];
        const sentMsg = await sock.sendMessage(senderJid, { text: phoneNumber });
        await saveMessageToDb(senderJid, {
            text: phoneNumber,
            sender: 'bot',
            id: sentMsg.key.id
        });
        lastBotMessageForJid.set(senderJid, sentMsg);
        messageStatusForJid.delete(senderJid); // Reset status for new message
        lastReactionForJid.delete(senderJid); // Reset reaction for new message
        return; // Stop further processing
    }

    // Command: "معلوماتي" (My Information)
    if (messageText.toLowerCase() === 'معلوماتي') {
        const userJid = senderJid;
        const shortJid = userJid.split('@')[0];
        const pushName = msg.pushName || 'غير متوفر'; // Name is not always available

        let accountType = 'غير متوفر';
        try {
            const businessProfile = await sock.getBusinessProfile(userJid);
            if (businessProfile && Object.keys(businessProfile).length > 0) {
                accountType = 'حساب تجاري';
            } else {
                accountType = 'حساب شخصي';
            }
        } catch (e) {
            console.error(`Could not fetch business profile for ${userJid}:`, e);
            accountType = 'لا يمكن تحديد (خطأ أو إعدادات الخصوصية)';
        }



        let pfpUrl = 'غير متوفر';
        try {
            pfpUrl = await sock.profilePictureUrl(userJid, 'image');
        } catch (e) {
            console.error(`Could not fetch profile picture for ${userJid}:`, e);
            pfpUrl = 'لا يمكن الوصول إليه (خطأ أو إعدادات الخصوصية)';
        }
        
        const profileInfo = [
            `معلومات ملفك الشخصي:`, 
            `- رقم المعرف (JID): ${shortJid}`,
            `- الاسم: ${pushName}`,
            `- نوع الحساب: ${accountType}`,
            `- رابط صورة الملف الشخصي: ${pfpUrl}`
        ].join('\n');

        const sentMsg = await sock.sendMessage(senderJid, { text: profileInfo });
        await saveMessageToDb(senderJid, {
            text: profileInfo,
            sender: 'bot',
            id: sentMsg.key.id
        });
        lastBotMessageForJid.set(senderJid, sentMsg);
        messageStatusForJid.delete(senderJid); // Reset status for new message
        lastReactionForJid.delete(senderJid); // Reset reaction for new message
        return; // Stop further processing
    }

    // Command: "!معلومات-الجروب" (Group Info)
    if (messageText.toLowerCase().startsWith('!معلومات-الجروب')) {
        const parts = messageText.split(' ');
        if (parts.length < 2 || !parts[1].includes('chat.whatsapp.com/')) {
            const sentMsg = await sock.sendMessage(senderJid, { text: 'يرجى إرسال رابط مجموعة واتساب صالح بعد الأمر. مثال:\n!معلومات-الجروب https://chat.whatsapp.com/ABCDEFG' });
            await saveMessageToDb(senderJid, { text: 'يرجى إرسال رابط مجموعة واتساب صالح بعد الأمر. مثال:\n!معلومات-الجروب https://chat.whatsapp.com/ABCDEFG', sender: 'bot', id: sentMsg.key.id });
            return;
        }

        const inviteLink = parts[1];
        // Extract the code from the link, handling potential trailing characters
        const match = inviteLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
        if (!match || !match[1]) {
             const sentMsg = await sock.sendMessage(senderJid, { text: 'لم أتمكن من استخراج رمز الدعوة من الرابط.' });
             await saveMessageToDb(senderJid, { text: 'لم أتمكن من استخراج رمز الدعوة من الرابط.', sender: 'bot', id: sentMsg.key.id });
            return;
        }
        const inviteCode = match[1];

        try {
            await sock.sendMessage(senderJid, { text: 'جاري البحث عن معلومات المجموعة...' });
            const groupInfo = await sock.groupGetInviteInfo(inviteCode);
            
            const creatorJid = groupInfo.owner;
            if (!creatorJid) {
                const sentMsg = await sock.sendMessage(senderJid, { text: 'لم أتمكن من تحديد منشئ المجموعة.' });
                await saveMessageToDb(senderJid, { text: 'لم أتمكن من تحديد منشئ المجموعة.', sender: 'bot', id: sentMsg.key.id });
                return;
            }

            const creatorPhoneNumber = creatorJid.split('@')[0];
            
            // Try to find the name in our database from past interactions
            let creatorName = await findUserNameInDb(creatorJid);
            if (!creatorName) {
                // If not found in DB, default to a message
                creatorName = 'غير معروف (لم يتفاعل مع البوت من قبل)';
            }

            let creatorPfpUrl = 'لا توجد صورة للملف الشخصي أو أنها خاصة.';
            try {
                creatorPfpUrl = await sock.profilePictureUrl(creatorJid, 'image');
            } catch (pfpError) {
                console.error(`Could not fetch profile picture for ${creatorJid}:`, pfpError);
            }

            const responseText = [
                `*معلومات منشئ المجموعة*`,
                `*اسم المجموعة:* ${groupInfo.subject}`,
                `---`,
                `*الاسم:* ${creatorName}`,
                `*الرقم:* ${creatorPhoneNumber}`
            ].join('\n');

            if (creatorPfpUrl.startsWith('http')) {
                 const sentMsg = await sock.sendMessage(senderJid, { image: { url: creatorPfpUrl }, caption: responseText });
                 await saveMessageToDb(senderJid, {
                     text: `Sent group creator info for ${groupInfo.subject} (with image)`,
                     sender: 'bot',
                     id: sentMsg.key.id
                 });
            } else {
                 const sentMsg = await sock.sendMessage(senderJid, { text: `${responseText}\n*الصورة:* ${creatorPfpUrl}` });
                 await saveMessageToDb(senderJid, {
                     text: `${responseText}\n*الصورة:* ${creatorPfpUrl}`,
                     sender: 'bot',
                     id: sentMsg.key.id
                 });
            }

        } catch (error) {
            console.error('Error fetching group invite info:', error);
            const sentMsg = await sock.sendMessage(senderJid, { text: 'عفوًا، لم أتمكن من الحصول على معلومات المجموعة. قد يكون الرابط غير صالح أو تم إبطاله.' });
            await saveMessageToDb(senderJid, { text: 'عفوًا، لم أتمكن من الحصول على معلومات المجموعة. قد يكون الرابط غير صالح أو تم إبطاله.', sender: 'bot', id: sentMsg.key.id });
        }
        return; // Stop further processing
    }

    // Command: ".الصلاة" (Prayer Times)
    if (messageText.toLowerCase().startsWith('.الصلاة')) {
        const city = "قوص"; // Fixed city to "قوص"
        const country = "مصر"; // Fixed country to "مصر"

        try {
            await sock.sendMessage(senderJid, { text: `جاري جلب مواقيت الصلاة في ${city}, ${country}...` });
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
            }, 30000); // 30-second timeout

            const response = await fetch(`http://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=8`, {
                signal: controller.signal
            });
            
            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error(`لم أتمكن من العثور على مدينة "${city}" أو دولة "${country}". يرجى التحقق من الاسم.`);
                }
                throw new Error(`حدث خطأ في الشبكة: ${response.status}`);
            }

            const data = await response.json();

            if (data.code === 200) {
                const timings = data.data.timings;
                const prayerTimes = [
                    `مواقيت الصلاة في ${city}, ${country}:`,
                    `الفجر: ${formatTo12Hour(timings.Fajr)}`,
                    `الشروق: ${formatTo12Hour(timings.Sunrise)}`,
                    `الظهر: ${formatTo12Hour(timings.Dhuhr)}`,
                    `العصر: ${formatTo12Hour(timings.Asr)}`,
                    `المغرب: ${formatTo12Hour(timings.Maghrib)}`,
                    `العشاء: ${formatTo12Hour(timings.Isha)}`
                ].join('\n');

                const sentMsg = await sock.sendMessage(senderJid, { text: prayerTimes });
                await saveMessageToDb(senderJid, {
                    text: prayerTimes,
                    sender: 'bot',
                    id: sentMsg.key.id
                });
            } else {
                 throw new Error(data.data?.readable || 'حدث خطأ غير معروف'); // Use readable error if available
            }
        } catch (error) {
            let errorText = 'عفواً، حدث خطأ أثناء جلب مواقيت الصلاة.';
            if (error.name === 'AbortError') {
                errorText = 'عفواً، استغرق طلب مواقيت الصلاة وقتاً طويلاً جداً.';
            } else if (error.message.includes('لم أتمكن من العثور')) {
                errorText = error.message;
            } else if (error.message.includes('حدث خطأ في الشبكة')) {
                 errorText = `عفواً، حدث خطأ في الشبكة أثناء الاتصال بخدمة مواقيت الصلاة: ${error.message}`;
            }
            console.error('Error fetching prayer times:', error);
            const sentMsg = await sock.sendMessage(senderJid, { text: errorText });
            await saveMessageToDb(senderJid, {
                text: errorText,
                sender: 'bot',
                id: sentMsg.key.id
            });
        } finally {
            clearTimeout(timeoutId);
        }
        return; // Stop further processing
    }


    try {
        await sock.sendPresenceUpdate('composing', senderJid);

        // Fetch the last 10 messages for conversation history
        const conversationRef = db.collection('conversations').doc(senderJid);
        const messagesQuery = conversationRef.collection('messages')
                                             .orderBy('timestamp', 'desc')
                                             .limit(10);
        const messagesSnapshot = await messagesQuery.get();
        
        let history = [];
        if (!messagesSnapshot.empty) {
            messagesSnapshot.forEach(doc => {
                history.push(doc.data());
            });
            history.reverse(); // Order from oldest to newest
        }

        let aiResponse = await getGeminiResponse(history, messageText);
        
        
        const sentMsg = await sock.sendMessage(senderJid, { text: aiResponse });
        await saveMessageToDb(senderJid, {
            text: aiResponse,
            sender: 'bot',
            id: sentMsg.key.id
        });
        lastBotMessageForJid.set(senderJid, sentMsg);
        messageStatusForJid.delete(senderJid); // Reset status for new message
        lastReactionForJid.delete(senderJid); // Reset reaction for new message
        
        await sock.sendPresenceUpdate('available', senderJid);

    } catch (error) {
        console.error('Error in message handler:', error);
        const errorText = 'Sorry, an internal error occurred.';
        const sentMsg = await sock.sendMessage(senderJid, { text: errorText });
        await saveMessageToDb(senderJid, {
            text: errorText,
            sender: 'bot',
            id: sentMsg.key.id
        });
    }
  });
}

connectToWhatsApp();