// Shared helper for uploading/deleting files in Supabase Storage. The exact
// same pattern already used for invoice PDFs (routes/invoices.js), pulled
// out here so room and banquet hall photos don't duplicate it.

const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB decoded — generous given client-side resize keeps real uploads far smaller

async function uploadImageToSupabase(bucket, pathPrefix, base64Data, contentType) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, error: 'Photo storage isn\'t configured on the server yet.' };
  }
  if (!ALLOWED_IMAGE_TYPES[contentType]) {
    return { ok: false, status: 400, error: 'Only JPEG, PNG or WEBP images are allowed.' };
  }
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 400, error: 'That image is too large. Please use a smaller photo.' };
  }
  const path = `${pathPrefix}/${Date.now()}.${ALLOWED_IMAGE_TYPES[contentType]}`;
  if (path.includes('//') || path.startsWith('/')) {
    return { ok: false, status: 500, error: 'Could not build a valid file path for this photo.' };
  }
  // SUPABASE_URL must be the bare project origin — see the identical note in
  // routes/invoices.js for why this normalization matters.
  const supabaseOrigin = new URL(process.env.SUPABASE_URL).origin;
  const auth = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
  const uploadRes = await fetch(`${supabaseOrigin}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': contentType, 'x-upsert': 'true' }, auth),
    body: buffer
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error('Supabase Storage upload failed:', { bucket, path, status: uploadRes.status, body: errText });
    return { ok: false, status: 502, error: 'Could not upload the photo. Please try again.' };
  }
  return { ok: true, url: `${supabaseOrigin}/storage/v1/object/public/${bucket}/${path}` };
}

// Best-effort delete — never throws, since a failed storage cleanup should
// never block removing the photo reference from the database.
async function deleteImageFromSupabase(bucket, publicUrl) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return;
  const path = publicUrl.slice(idx + marker.length);
  try {
    const supabaseOrigin = new URL(process.env.SUPABASE_URL).origin;
    const auth = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
    await fetch(`${supabaseOrigin}/storage/v1/object/${bucket}/${path}`, { method: 'DELETE', headers: auth });
  } catch (err) {
    console.error('Supabase Storage delete failed (non-fatal):', err);
  }
}

module.exports = { uploadImageToSupabase, deleteImageFromSupabase };