/**
 * Serverless API route: GET /api/hotels?city=CITYNAME
 *
 * HOW THIS WORKS:
 * 1. The frontend sends a GET request to /api/hotels?city=LosAngeles
 * 2. This function calls the MakCorps Hotel API to fetch hotel prices
 * 3. It simplifies the response to only the most useful fields
 * 4. It returns the simplified data to the frontend
 *
 * WHY THE API KEY MUST STAY ON THE SERVER:
 * - Set MAKCORPS_API_KEY in Vercel environment variables.
 * - Do not expose it in frontend code.
 *
 * SETTING UP YOUR API KEY IN VERCEL:
 * 1. Go to your Vercel project dashboard
 * 2. Navigate to Settings → Environment Variables
 * 3. Add a new variable:
 *      Name:  MAKCORPS_API_KEY
 *      Value: your-makcorps-api-key-here
 * 4. Redeploy the project for the variable to take effect
 *
 * For local development, add to your .env file:
 *      MAKCORPS_API_KEY=your-makcorps-api-key-here
 */

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { city } = req.query;

  if (!city) {
    return res.status(400).json({ error: "Missing required query parameter: city" });
  }

  // Set MAKCORPS_API_KEY in Vercel environment variables. Do not expose it in frontend code.
  const apiKey = process.env.MAKCORPS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "MAKCORPS_API_KEY is not configured. Add it in Vercel → Settings → Environment Variables.",
    });
  }

  // Default check-in to tomorrow and check-out to the day after.
  // The MakCorps API requires dates in YYYY-MM-DD format.
  const today = new Date();
  const checkin = new Date(today);
  checkin.setDate(today.getDate() + 1);
  const checkout = new Date(today);
  checkout.setDate(today.getDate() + 2);

  const fmt = (d) => d.toISOString().split("T")[0]; // "YYYY-MM-DD"

  try {
    // MakCorps "citysearch" endpoint uses path-based parameters:
    //   /citysearch/{city}/{page}/{currency}/{rooms}/{adults}/{checkin}/{checkout}
    // The api_key is passed as a query parameter.
    const apiUrl =
      `https://api.makcorps.com/citysearch` +
      `/${encodeURIComponent(city)}` +
      `/0`    + // page 0 (first 30 results)
      `/USD`  + // currency
      `/1`    + // 1 room
      `/2`    + // 2 adults
      `/${fmt(checkin)}` +
      `/${fmt(checkout)}` +
      `?api_key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `MakCorps API returned status ${response.status}`,
        detail: text,
      });
    }

    const raw = await response.json();

    // Simplify the response — return only the most useful fields.
    // The MakCorps API returns an array of hotel objects. Each hotel may
    // contain nested vendor/price data in varying formats, so we normalise
    // it into a flat list the frontend can render easily.
    const hotels = simplifyHotels(raw, fmt(checkin), fmt(checkout));

    return res.status(200).json({
      city,
      checkin: fmt(checkin),
      checkout: fmt(checkout),
      hotels,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Failed to fetch hotel data", detail: err.message });
  }
};

/**
 * Simplify the raw MakCorps response into a flat array of hotel objects
 * with only the fields the frontend needs: name, price, vendor, checkin, checkout.
 *
 * The MakCorps API can return data in multiple shapes depending on the
 * endpoint. We handle the common patterns defensively so the frontend
 * always gets a consistent structure.
 */
function simplifyHotels(raw, checkin, checkout) {
  // The citysearch endpoint typically returns an array of objects.
  // Each object has a hotel name and one or more vendor/price entries.
  let items = [];

  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object") {
    // Some responses wrap results in a key like "result" or "comparison"
    const key = Object.keys(raw).find((k) => Array.isArray(raw[k]));
    if (key) items = raw[key];
  }

  const hotels = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    // Try to extract hotel name — MakCorps uses different keys
    const name = item.name || item.hotel_name || item.Name || null;
    if (!name) continue;

    // Try to extract the cheapest price and its vendor
    let price = null;
    let vendor = null;

    // Pattern 1: item has price1/vendor1 style keys (common in citysearch)
    if (item.price1 !== undefined) {
      price = item.price1;
      vendor = item.vendor1 || null;
    }

    // Pattern 2: item has a "vendors" or "comparison" array
    if (price === null && Array.isArray(item.vendors)) {
      const v = item.vendors[0];
      if (v) {
        price = v.price || v.Price || null;
        vendor = v.vendor || v.name || v.Vendor || null;
      }
    }

    // Pattern 3: direct price field
    if (price === null) {
      price = item.price || item.Price || item.min_price || null;
      vendor = item.vendor || item.source || item.Vendor || vendor;
    }

    hotels.push({
      name: String(name),
      price: price !== null && price !== undefined ? String(price) : null,
      vendor: vendor ? String(vendor) : null,
      checkin,
      checkout,
    });
  }

  return hotels;
}
