/**
 * Serverless API route: POST /api/sms
 *
 * TWILIO WHATSAPP SANDBOX WEBHOOK
 * This endpoint receives incoming WhatsApp messages via the Twilio Sandbox.
 * When a user sends a flight code (e.g. "AAL100") to the sandbox number,
 * this function:
 *   1. Parses the flight code from the message body
 *   2. Looks up the flight via FlightAware AeroAPI
 *   3. Formats the flight details as a plain-text reply
 *   4. Returns TwiML XML so Twilio sends the reply back via WhatsApp
 *
 * TWILIO WHATSAPP SANDBOX SETUP:
 * 1. Go to Twilio Console → Messaging → Try it out → Send a WhatsApp message
 * 2. Follow the instructions to join your sandbox (send "join <your-keyword>"
 *    to the sandbox number, typically +1 (415) 523-8886)
 * 3. Under "Sandbox settings", set "WHEN A MESSAGE COMES IN" webhook to:
 *      https://your-vercel-domain.vercel.app/api/sms   (HTTP POST)
 * 4. Save. Now WhatsApp messages to the sandbox will hit this endpoint.
 *
 * NOTE: The WhatsApp Sandbox does NOT require A2P 10DLC campaign registration
 * or phone number verification, making it ideal for development and demos.
 *
 * ENVIRONMENT VARIABLES NEEDED:
 * - FLIGHTAWARE_API_KEY (same one used by /api/flight)
 */

module.exports = async function handler(req, res) {
  // Twilio sends webhooks as POST requests
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "text/xml");
    return res.status(405).send(twiml("This endpoint only accepts POST requests from Twilio."));
  }

  // Twilio sends the SMS text in the "Body" field (URL-encoded form data)
  const body = (req.body.Body || "").trim();

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
    const message = formatFlightSMS(f);

    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(twiml(message));
  } catch (err) {
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send(twiml("Something went wrong looking up that flight. Please try again."));
  }
};

/**
 * Format flight data into a concise SMS-friendly string.
 * SMS has a 1600-char limit per segment, so keep it tight.
 */
function formatFlightSMS(f) {
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

/**
 * Wrap a message string in TwiML XML so Twilio sends it as a WhatsApp reply.
 * We build the XML by hand to avoid needing any dependencies.
 */
function twiml(message) {
  // Escape XML special characters in the message
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Message>" + escaped + "</Message>",
    "</Response>",
  ].join("\n");
}
