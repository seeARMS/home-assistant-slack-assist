// server.js
//
// Requires:
//   npm install express body-parser axios
//
// Environment variables:
//   SLACK_BOT_TOKEN  - Slack bot token (xoxb-...)
//   HA_TOKEN         - Home Assistant long-lived token
//   HA_URL           - Base URL to your Home Assistant instance (e.g. https://myha.duckdns.org)
//

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const HA_TOKEN = process.env.HA_TOKEN;
const HA_URL = process.env.HA_URL; // no trailing slash
const HOME_ASSISTANT_BOT_ID = "U088Z942Z4H";

// Dedup cache for Slack event_ids
const processedEvents = new Set();
const DEDUPE_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes

// Track conversation IDs by channel
const conversationCache = {};
const CONVERSATION_EXPIRATION_MS = 30 * 60 * 1000; // 30 minutes

async function postToSlack(channel, text) {
  await axios.post(
    "https://slack.com/api/chat.postMessage",
    { channel, text },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
}

// Process event in background
async function processSlackEvent(event) {
  if (event.user === HOME_ASSISTANT_BOT_ID) return;

  const text = event.text || "";
  const channel = event.channel || "";
  if (!text) return;

  console.log("Forwarding message to Home Assistant:", text);

  let convId;
  const now = Date.now();

  if (
    conversationCache[channel] &&
    now - conversationCache[channel].lastUsed < CONVERSATION_EXPIRATION_MS
  ) {
    convId = conversationCache[channel].id;
  }

  try {
    const haResponse = await axios.post(
      `${HA_URL}/api/conversation/process`,
      {
        language: "en",
        text,
        agent_id: "conversation.chatgpt",
        ...(convId ? { conversation_id: convId } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Home Assistant response:", JSON.stringify(haResponse.data));

    const newConvId = haResponse.data.conversation_id;
    if (newConvId) {
      conversationCache[channel] = {
        id: newConvId,
        lastUsed: now,
      };
    }

    const resultText =
      haResponse.data.speech ||
      haResponse.data?.response?.speech?.plain?.speech ||
      "No response";

    await postToSlack(channel, resultText);
  } catch (err) {
    console.error("Error calling Home Assistant:", err);
  }
}

// Main Slack event endpoint
app.post("/slack/events", async (req, res) => {
  const data = req.body;
  if (data.challenge) return res.send(data.challenge);
  res.json({ ok: true });

  const eventId = data.event_id;
  if (!eventId) {
    if (data.event) processSlackEvent(data.event);
    return;
  }

  if (processedEvents.has(eventId)) {
    console.log(`Duplicate event_id ${eventId} - ignoring`);
    return;
  }

  processedEvents.add(eventId);
  setTimeout(() => {
    processedEvents.delete(eventId);
  }, DEDUPE_EXPIRATION_MS);

  if (data.event) {
    processSlackEvent(data.event);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
