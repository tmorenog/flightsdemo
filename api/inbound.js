/**
 * Serverless API route: GET /api/inbound?airport=AIRPORTCODE
 *
 * HOW THIS WORKS:
 * 1. The frontend sends a GET request to /api/inbound?airport=BOS
 * 2. This serverless function reads the airport code from the query string
 * 3. It calls the FlightAware AeroAPI "airport arrivals" endpoint using the
 *    API key stored in an environment variable
 * 4. It filters for flights that are currently en route (airborne with a
 *    known position) and returns a simplified JSON array to the frontend
 *
 * WHY THE API KEY MUST STAY ON THE SERVER:
 * - If the API key were in the frontend JavaScript, anyone could view it in
 *   their browser (View Source, DevTools, or Network tab) and use it to make
 *   unlimited API calls at your expense.
 * - By keeping the key on the server, only your backend can access it.
 * - The frontend never sees the key — it only talks to YOUR /api/inbound endpoint.
 *
 * SETTING UP YOUR API KEY IN VERCEL:
 * 1. Go to your Vercel project dashboard
 * 2. Navigate to Settings → Environment Variables
 * 3. Add a new variable:
 *      Name:  FLIGHTAWARE_API_KEY
 *      Value: your-aeroapi-key-here
 * 4. Redeploy the project for the variable to take effect
 *
 * For local development, create a .env file in the project root:
 *      FLIGHTAWARE_API_KEY=your-aeroapi-key-here
 */

module.exports = async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { airport } = req.query;

  // Validate that an airport code was provided
  if (!airport) {
    return res
      .status(400)
      .json({ error: "Missing required query parameter: airport" });
  }

  // Normalize to uppercase and basic validation (IATA = 3 chars, ICAO = 4 chars)
  const code = airport.trim().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(code)) {
    return res
      .status(400)
      .json({ error: "Airport code must be 3 or 4 letters (e.g. BOS, KBOS)" });
  }

  // Read the API key from the environment variable (never hardcode it!)
  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "FLIGHTAWARE_API_KEY is not configured. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  try {
    // ---------------------------------------------------------------
    //  HOW THE BACKEND CALLS THE AEROAPI
    //  We request the "arrivals" endpoint for this airport.
    //  AeroAPI returns flights arriving at the airport, each with a
    //  last_position object containing latitude, longitude, altitude,
    //  groundspeed, and heading — if the flight is currently tracked.
    //  Documentation: https://www.flightaware.com/aeroapi/portal/documentation
    // ---------------------------------------------------------------
    const apiUrl = `https://aeroapi.flightaware.com/aeroapi/airports/${encodeURIComponent(code)}/flights/arrivals`;

    const response = await fetch(apiUrl, {
      headers: {
        "x-apikey": apiKey, // AeroAPI authenticates via this header
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `AeroAPI returned status ${response.status}`,
        detail: text,
      });
    }

    const data = await response.json();
    const arrivals = data.arrivals || [];

    // ---------------------------------------------------------------
    //  FILTER & SIMPLIFY
    //  We only want flights that are currently en route — meaning they
    //  have a last_position with valid lat/lon and have NOT yet arrived
    //  or been cancelled. We simplify the data so the frontend stays
    //  simple and doesn't need to dig into nested AeroAPI objects.
    // ---------------------------------------------------------------
    const enRouteFlights = arrivals
      .filter((flight) => {
        const lp = flight.last_position;
        // Must have a last_position with valid coordinates
        if (!lp || lp.latitude == null || lp.longitude == null) return false;
        // Exclude flights that have already arrived or been cancelled
        const status = (flight.status || "").toLowerCase();
        if (
          status.includes("arrived") ||
          status.includes("cancelled") ||
          status.includes("canceled")
        )
          return false;
        return true;
      })
      .map((flight) => ({
        ident: flight.ident || "",
        origin:
          flight.origin?.code_iata || flight.origin?.code || "",
        destination:
          flight.destination?.code_iata || flight.destination?.code || "",
        latitude: flight.last_position.latitude,
        longitude: flight.last_position.longitude,
        status: flight.status || "",
        altitude: flight.last_position.altitude ?? null,
        groundspeed: flight.last_position.groundspeed ?? null,
      }));

    // Return the simplified array wrapped in an object
    return res.status(200).json({ flights: enRouteFlights });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to fetch inbound flights", detail: err.message });
  }
};
