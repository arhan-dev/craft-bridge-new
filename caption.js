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
  // this endpoint indefinitely — each call costs real Gemini quota.
  //
  // The check (how many calls in the last hour) and the record (insert this
  // call) happen atomically inside a single Postgres function — see
  // check_and_record_ai_usage in supabase/schema.sql — so two simultaneous
  // requests from the same user can't both read the same under-limit count
  // and both slip through. This call runs as the calling user (via their
  // own token, not a service-role key).
  //
  // If the rate-limit call itself fails for any reason, we fail CLOSED:
  // do not call Gemini. Failing open here would mean a database hiccup
  // turns into unlimited Gemini spend.
  const RATE_LIMIT = 15;
  const WINDOW_SECONDS = 60 * 60; // 1 hour

  let allowed;
  try {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/check_and_record_ai_usage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_limit: RATE_LIMIT, p_window_seconds: WINDOW_SECONDS })
    });

    if (!rpcRes.ok) {
      return res.status(503).json({
        error: "AI Product Listing is temporarily unavailable. Please try again in a moment, or fill in the listing details manually."
      });
    }

    allowed = await rpcRes.json();
  } catch (err) {
    return res.status(503).json({
      error: "AI Product Listing is temporarily unavailable. Please try again in a moment, or fill in the listing details manually."
    });
  }

  if (allowed !== true) {
    return res.status(429).json({
      error: `You've reached the limit of ${RATE_LIMIT} AI listings per hour. Please try again later, or fill in the listing details manually.`
    });
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

    // Defense-in-depth: the frontend compresses/resizes the photo before
    // sending it (targeting ~3MB original size), but never trust the client
    // alone. Base64 inflates the original bytes by ~4/3, and Vercel
    // Serverless Functions cap the whole request body well under typical
    // photo sizes once encoded — this keeps us safely under that ceiling
    // regardless of what the client actually sent.
    const MAX_BASE64_CHARS = 4_600_000; // ~3.4MB decoded, ~4.4MB request body
    if (image.length > MAX_BASE64_CHARS) {
      return res.status(413).json({
        error: "Image is too large for AI analysis, even after compression. Please use a smaller or simpler photo, or fill in the listing manually."
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
