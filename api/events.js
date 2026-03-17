/**
 * Serverless API route: GET /api/events
 *
 * Returns recent SMS events so the frontend can display them in real time.
 * Events are stored in /tmp/flight-events.json by the SMS webhook handler.
 * The frontend polls this endpoint every few seconds.
 *
 * Query params:
 * - since (optional): ISO timestamp — only return events newer than this
 */
const fs = require("fs");
const path = require("path");

const EVENTS_FILE = path.join("/tmp", "flight-events.json");

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  const since = req.query.since || null;

  let events = [];
  try {
    const raw = fs.readFileSync(EVENTS_FILE, "utf-8");
    events = JSON.parse(raw);
  } catch {
    // File doesn't exist yet — no events
  }

  if (since) {
    const sinceMs = new Date(since).getTime();
    events = events.filter((e) => new Date(e.timestamp).getTime() > sinceMs);
  }

  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).json({ events });
};
