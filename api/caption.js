export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed. Use POST."
    });
  }

  // Read the API key securely from Vercel Environment Variables
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured on this Vercel project."
    });
  }

  // Require a signed-in artisan before spending Gemini quota on this request.
  // Without this check, this endpoint is reachable by anyone who loads the
  // page — no login needed — which is exactly what drives up the 429s you'd
  // see on the Gemini usage dashboard from anonymous/automated hits.
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({
      error: "Supabase is not configured on this Vercel project, so signed-in access cannot be verified."
    });
  }
  if (!token) {
    return res.status(401).json({
      error: "Sign in as an artisan to use AI Product Listing."
    });
  }

  let userId;
  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey
      }
    });
    if (!userRes.ok) {
      return res.status(401).json({
        error: "Your session has expired. Please sign in again."
      });
    }
    const userData = await userRes.json();
    userId = userData.id;
  } catch (err) {
    return res.status(401).json({
      error: "Could not verify your session. Please sign in again."
    });
  }

  // Rate limit: cap each artisan to RATE_LIMIT Gemini calls per hour.
  // Auth alone stops anonymous abuse, but a signed-in user could still loop
  // this endpoint indefinitely — each call costs real Gemini quota. This
  // check and the insert below both run as the calling user (via their own
  // token, not a service-role key), so Postgres RLS on ai_usage enforces
  // that nobody can read or write another artisan's usage rows.
  const RATE_LIMIT = 15;
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  try {
    const usageRes = await fetch(
      `${supabaseUrl}/rest/v1/ai_usage?select=id&user_id=eq.${userId}&created_at=gte.${windowStart}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: supabaseAnonKey
        }
      }
    );
    if (usageRes.ok) {
      const rows = await usageRes.json();
      if (Array.isArray(rows) && rows.length >= RATE_LIMIT) {
        return res.status(429).json({
          error: `You've reached the limit of ${RATE_LIMIT} AI listings per hour. Please try again later, or fill in the listing details manually.`
        });
      }
    }
    // If the usage check itself fails (e.g. table missing before a migration
    // is applied), fail open rather than blocking legitimate listings —
    // but still record this call below so the table starts filling in.
  } catch (err) {
    // Same fail-open reasoning as above.
  }

  // Record this call before contacting Gemini, so a burst of concurrent
  // requests can't all sneak in under the same stale count. Awaited (not
  // fire-and-forget) because a serverless function can be frozen/torn down
  // as soon as it looks idle — an un-awaited write here isn't guaranteed
  // to finish.
  try {
    await fetch(`${supabaseUrl}/rest/v1/ai_usage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ user_id: userId })
    });
  } catch (err) {
    // Non-fatal: if this write fails, the worst case is the rate limit
    // undercounts slightly. Never block the artisan's request over it.
  }

  try {
    const { image, mimeType } = req.body || {};

    if (!image || !mimeType) {
      return res.status(400).json({
        error: 'Request must include base64 "image" and "mimeType".'
      });
    }

    // Only allow image files
    if (!mimeType.startsWith("image/")) {
      return res.status(400).json({
        error: "mimeType must be an image type."
      });
    }

    // Prevent excessively large uploads
    if (image.length > 12_000_000) {
      return res.status(413).json({
        error: "Image is too large. Please use a file under 8MB."
      });
    }

    const prompt = `You are a cataloging assistant for an Indian artisan marketplace. Look at this product photo and respond with ONLY a raw JSON object (no markdown fences, no preamble) with exactly these keys:

{
  "title": "a short, appealing product title (max 8 words)",
  "category": "the single best-fit category, chosen ONLY from this exact list: Pottery, Home Decor, Textiles & Weaves, Metal Craft, Woodwork, Jewelry, Paintings",
  "description": "a warm 2-3 sentence craft-focused product description, written as if for a marketplace listing",
  "tags": ["3 to 5 short category/material tags, e.g. Pottery, Handmade, Terracotta"]
}`;

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: image
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024,
          responseMimeType: "application/json"
        }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();

      return res.status(502).json({
        error: `Gemini API error (${geminiRes.status}): ${errText.slice(0, 300)}`
      });
    }

    const geminiData = await geminiRes.json();

    const rawText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Remove markdown code fences if Gemini adds them
    const cleaned = rawText
      .replace(/```json|```/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
    } catch (error) {
      // Gemini's raw text wasn't valid JSON (e.g. got cut off, or included
      // stray formatting). Don't dump the broken JSON into the description —
      // return a 502 instead so the frontend shows a clear error and the
      // artisan can just fill the form in manually.
      return res.status(502).json({
        error: "Gemini returned a response that wasn't valid JSON, so no listing details could be extracted. Please try again."
      });
    }

    // Guard against missing/odd fields even when JSON parsing succeeds.
    parsed = {
      title: typeof parsed.title === "string" ? parsed.title : "",
      category: typeof parsed.category === "string" ? parsed.category : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(t => typeof t === "string") : []
    };

    return res.status(200).json(parsed);

  } catch (error) {
    return res.status(502).json({
      error: "Failed to reach Gemini API: " + error.message
    });
  }
}
