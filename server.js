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

// Helper to post a message to Slack
async function postToSlack(channel, text) {
  await axios.post(
    "https://slack.com/api/chat.postMessage",
    { channel, text },
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
  );
}

// Process event in background
async function processSlackEvent(event) {
  if (event.user === HOME_ASSISTANT_BOT_ID) {
    console.log("Ignoring message from Home Assistant bot");
    return;
  }

  const text = event.text || "";
  const channel = event.channel || "";

  if (!text) return;

  console.log("Forwarding message to Home Assistant:", text);

  try {
    const haResponse = await axios.post(
      `${HA_URL}/api/conversation/process`,
      {
        language: "en",
        text,
        agent_id: "conversation.chatgpt", // Adjust if needed
      },
      {
        headers: {
          Authorization: `Bearer ${HA_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Home Assistant response:", JSON.stringify(haResponse.data));

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

  // Handle Slack verification challenge
  if (data.challenge) {
    return res.send(data.challenge);
  }

  // Immediately acknowledge Slack so it won’t retry
  res.json({ ok: true });

  // Check for event duplication
  const eventId = data.event_id;
  if (!eventId) {
    // No event_id => nothing to deduplicate, just process
    if (data.event) {
      processSlackEvent(data.event);
    }
    return;
  }

  if (processedEvents.has(eventId)) {
    console.log(`Duplicate event_id ${eventId} - ignoring`);
    return;
  }

  // Mark this event_id as processed
  processedEvents.add(eventId);
  setTimeout(() => {
    processedEvents.delete(eventId);
  }, DEDUPE_EXPIRATION_MS);

  // Process in background
  if (data.event) {
    processSlackEvent(data.event);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
