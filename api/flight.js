/**
 * Serverless API route: GET /api/flight?ident=FLIGHTNUMBER
 *
 * HOW THIS WORKS:
 * 1. The frontend sends a GET request to /api/flight?ident=AAL100
 * 2. This serverless function reads the flight identifier from the query string
 * 3. It calls the FlightAware AeroAPI using the API key stored in an environment variable
 * 4. It returns the JSON response to the frontend
 *
 * WHY THE API KEY MUST STAY ON THE SERVER:
 * - If the API key were in the frontend JavaScript, anyone could view it in their browser
 *   (View Source, DevTools, or Network tab) and use it to make unlimited API calls at your expense.
 * - By keeping the key on the server, only your backend can access it.
 * - The frontend never sees the key — it only talks to YOUR /api/flight endpoint.
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

  const { ident } = req.query;

  // Validate that a flight identifier was provided
  if (!ident) {
    return res
      .status(400)
      .json({ error: "Missing required query parameter: ident" });
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
    // Call the FlightAware AeroAPI
    // Documentation: https://www.flightaware.com/aeroapi/portal/documentation
    const apiUrl = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}`;

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

    // Return the full AeroAPI response to the frontend
    return res.status(200).json(data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to fetch flight data", detail: err.message });
  }
};
