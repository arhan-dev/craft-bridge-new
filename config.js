// Serves the PUBLIC Supabase URL + anon key to the browser at runtime.
//
// This is safe: the Supabase anon key is designed to be public — access to
// data is controlled by Row Level Security policies (see supabase/schema.sql),
// not by keeping this key secret. We still read it from a server-side env
// var instead of hardcoding it in index.html so the project stays static
// (no build step) while remaining easy to reconfigure per-environment.
//
// GEMINI_API_KEY and any other real secret must NEVER be added to this file.
export default function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(200).json({
      supabaseUrl: '',
      supabaseAnonKey: '',
      configured: false
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
    configured: true
  });
}
