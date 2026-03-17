/**
 * Serverless API route: POST /api/sms
 *
 * TWILIO SMS WEBHOOK
 * This endpoint receives incoming SMS messages on +1 (229) 597-2468.
 * When a user texts a flight code (e.g. "AAL100"), this function:
 *   1. Parses the flight code from the SMS body
 *   2. Looks up the flight via FlightAware AeroAPI
 *   3. Replies via SMS with the flight details
 *   4. Places an outbound voice call to the sender and reads the info aloud
 *
 * TWILIO SETUP:
 * 1. Go to Twilio Console → Phone Numbers → +12295972468
 * 2. Under "Messaging", set the webhook for "A message comes in" to:
 *      https://your-vercel-domain.vercel.app/api/sms   (HTTP POST)
 * 3. Save. Now incoming texts will hit this endpoint.
 *
 * ENVIRONMENT VARIABLES NEEDED:
 * - FLIGHTAWARE_API_KEY (same one used by /api/flight)
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 * - TWILIO_PHONE_NUMBER  (your Twilio number for outbound calls: +12295972468)
 */

const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

const EVENTS_FILE = path.join("/tmp", "flight-events.json");
const MAX_EVENTS = 50;

/**
 * Read and parse the raw request body.
 * Vercel may or may not auto-parse the body depending on the runtime.
 * We handle every case: pre-parsed object, raw string, or stream.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    // Case 1: Vercel already parsed it into an object
    if (req.body && typeof req.body === "object") {
      return resolve(req.body);
    }
    // Case 2: Vercel read it but left it as a raw string
    if (req.body && typeof req.body === "string") {
      return resolve(querystring.parse(req.body));
    }
    // Case 3: Body not yet consumed — read from stream
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try {
        resolve(querystring.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

/** Append an event to the /tmp events file so the frontend can poll it. */
function storeEvent(event) {
  let events = [];
  try {
    events = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
  } catch {
    // file doesn't exist yet
  }
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
}

module.exports = async function handler(req, res) {
  console.log("[sms] method:", req.method);
  console.log("[sms] content-type:", req.headers["content-type"]);
  console.log("[sms] req.body type:", typeof req.body);
  console.log("[sms] req.body:", JSON.stringify(req.body));

  // Twilio sends webhooks as POST requests
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "text/xml");
    return res.status(405).send(twiml("This endpoint only accepts POST requests from Twilio."));
  }

  // Parse the form-encoded body that Twilio sends
  const fields = await parseBody(req);
  console.log("[sms] parsed fields:", JSON.stringify(fields));
  const body = (fields.Body || "").trim();
  // "From" contains the sender's phone number, e.g. "+15551234567"
  const from = (fields.From || "").trim();
  console.log("[sms] body:", body, "from:", from);

  if (!body) {
    return res
      .status(200)
      .setHeader("Content-Type", "text/xml")
      .send(twiml("Send a flight code (e.g. AAL100, DL245, UAL354) to look up flight details."));
  }

  // Use the first word as the flight identifier (ignore anything extra)
  const ident = body.split(/\s+/)[0].toUpperCase();

  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) {
    return res
      .status(200)
      .setHeader("Content-Type", "text/xml")
      .send(twiml("Server configuration error. Please try again later."));
  }

  try {
    const apiUrl = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}`;
    const apiRes = await fetch(apiUrl, {
      headers: { "x-apikey": apiKey },
    });

    if (!apiRes.ok) {
      return res
        .status(200)
        .setHeader("Content-Type", "text/xml")
        .send(twiml(`Could not find flight "${ident}". Check the code and try again.`));
    }

    const data = await apiRes.json();

    if (!data.flights || data.flights.length === 0) {
      return res
        .status(200)
        .setHeader("Content-Type", "text/xml")
        .send(twiml(`No flights found for "${ident}".`));
    }

    // Use the most recent flight (last in the array)
    const f = data.flights[data.flights.length - 1];
    const message = formatFlightMessage(f);

    // Store "received" event for the frontend live feed
    storeEvent({
      type: "sms_received",
      timestamp: new Date().toISOString(),
      from,
      ident,
      flight: {
        ident: f.ident,
        status: f.status,
        origin: formatAirport(f.origin),
        destination: formatAirport(f.destination),
        depDelay: delayMinutes(f.scheduled_out, f.actual_out),
        arrDelay: delayMinutes(f.scheduled_in, f.actual_in),
      },
    });

    // Place an outbound voice call to read the info aloud
    storeEvent({
      type: "calling",
      timestamp: new Date().toISOString(),
      from,
      ident,
    });
    placeVoiceCall(from, formatFlightSpeech(f)).catch(() => {});

    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(twiml(message));
  } catch (err) {
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(twiml("Something went wrong looking up that flight. Please try again."));
  }
};

/**
 * Place an outbound Twilio voice call that reads flight info using <Say>.
 * Uses the Twilio REST API directly (no SDK needed).
 */
async function placeVoiceCall(fromNumber, speechText) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPhone = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !twilioPhone || !fromNumber) return;

  // Build TwiML for the voice call
  const voiceTwiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    '  <Say voice="Polly.Joanna">' + escapeXml(speechText) + "</Say>",
    "</Response>",
  ].join("\n");

  const params = new URLSearchParams({
    To: fromNumber,
    From: twilioPhone,
    Twiml: voiceTwiml,
  });

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
}

/**
 * Format flight data for the SMS text reply.
 */
function formatFlightMessage(f) {
  const origin = formatAirport(f.origin);
  const dest = formatAirport(f.destination);
  const depDelay = delayMinutes(f.scheduled_out, f.actual_out);
  const arrDelay = delayMinutes(f.scheduled_in, f.actual_in);

  const lines = [
    `✈ ${f.ident || "Unknown"}`,
    `Status: ${f.status || "Unknown"}`,
    `From: ${origin}`,
    `To: ${dest}`,
    "",
    `Sched. Dep: ${fmtTime(f.scheduled_out)}`,
    `Actual Dep: ${fmtTime(f.actual_out)}`,
    `Dep Delay: ${fmtDelay(depDelay)}`,
    "",
    `Sched. Arr: ${fmtTime(f.scheduled_in)}`,
    `Actual Arr: ${fmtTime(f.actual_in)}`,
    `Arr Delay: ${fmtDelay(arrDelay)}`,
  ];

  return lines.join("\n");
}

/**
 * Format flight data as natural speech for the voice call.
 */
function formatFlightSpeech(f) {
  const origin = speakAirport(f.origin);
  const dest = speakAirport(f.destination);
  const depDelay = delayMinutes(f.scheduled_out, f.actual_out);
  const arrDelay = delayMinutes(f.scheduled_in, f.actual_in);

  const parts = [
    `Here is the flight information for ${f.ident || "your flight"}.`,
    `Status: ${f.status || "unknown"}.`,
    `Departing from ${origin}, arriving at ${dest}.`,
  ];

  if (depDelay !== null) {
    parts.push(
      depDelay <= 0
        ? "The departure was on time."
        : `The departure was delayed by ${depDelay} minutes.`
    );
  }

  if (arrDelay !== null) {
    parts.push(
      arrDelay <= 0
        ? "The arrival was on time."
        : `The arrival was delayed by ${arrDelay} minutes.`
    );
  }

  return parts.join(" ");
}

function speakAirport(airport) {
  if (!airport) return "an unknown airport";
  const name = airport.name || "";
  const code = airport.code_iata || airport.code || "";
  if (name && code) return `${name} (${code})`;
  return name || code || "an unknown airport";
}

function formatAirport(airport) {
  if (!airport) return "—";
  const code = airport.code_iata || airport.code || "";
  const name = airport.name || "";
  return code + (name ? " — " + name : "");
}

function delayMinutes(scheduled, actual) {
  if (!scheduled || !actual) return null;
  return Math.round((new Date(actual) - new Date(scheduled)) / 60000);
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtDelay(minutes) {
  if (minutes === null) return "N/A";
  if (minutes <= 0) return "On time";
  return `+${minutes} min late`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Wrap a message string in TwiML XML so Twilio sends it as an SMS reply.
 */
function twiml(message) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Message>" + escapeXml(message) + "</Message>",
    "</Response>",
  ].join("\n");
}
