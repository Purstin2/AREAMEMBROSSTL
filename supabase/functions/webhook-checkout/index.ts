// Supabase Edge Function — webhook-checkout
// Recebe webhooks de checkout (Kiwify, Hotmart, Monetizze, Eduzz)
// e provisiona automaticamente o acesso do aluno ao produto comprado.
//
// Deploy:
//   supabase functions deploy webhook-checkout --no-verify-jwt
//
// URL do webhook:
//   https://uejtxeqyqqunqhspylmh.supabase.co/functions/v1/webhook-checkout

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface ParsedPayload {
  platform: string;
  email: string;
  name: string;
  productId: string; // checkout_id that maps to products.checkout_id
  productName: string;
  status: string; // approved / refunded / etc
}

function parseKiwify(body: any): ParsedPayload | null {
  // Kiwify webhook format
  const order = body?.order || body;
  const email = order?.Customer?.email || order?.customer?.email || order?.buyer_email;
  const name = order?.Customer?.full_name || order?.customer?.full_name || order?.buyer_name || 'Cliente';
  const productId = order?.Product?.id || order?.product?.id || order?.product_id || '';
  const productName = order?.Product?.name || order?.product?.name || order?.product_name || '';
  const status = (order?.order_status || order?.status || 'approved').toLowerCase();
  if (!email) return null;
  return { platform: 'kiwify', email, name, productId, productName, status };
}

function parseHotmart(body: any): ParsedPayload | null {
  // Hotmart webhook format
  const data = body?.data || body;
  const email = data?.buyer?.email || data?.customer?.email;
  const name = data?.buyer?.name || data?.customer?.name || 'Cliente';
  const productId = String(data?.product?.id || data?.product_id || '');
  const productName = data?.product?.name || data?.product_name || '';
  const status = (data?.purchase?.status || body?.event || 'approved').toLowerCase();
  if (!email) return null;
  return { platform: 'hotmart', email, name, productId, productName, status };
}

function parseMonetizze(body: any): ParsedPayload | null {
  const email = body?.comprador?.email || body?.buyer?.email;
  const name = body?.comprador?.nome || body?.buyer?.name || 'Cliente';
  const productId = String(body?.produto?.codigo || body?.product?.id || '');
  const productName = body?.produto?.nome || body?.product?.name || '';
  const status = (body?.venda?.status || body?.status || 'approved').toLowerCase();
  if (!email) return null;
  return { platform: 'monetizze', email, name, productId, productName, status };
}

function parseEduzz(body: any): ParsedPayload | null {
  const email = body?.client_email || body?.email;
  const name = body?.client_name || body?.name || 'Cliente';
  const productId = String(body?.content_id || body?.product_id || '');
  const productName = body?.content_title || body?.product_name || '';
  const status = (body?.invoice_status || body?.status || 'approved').toLowerCase();
  if (!email) return null;
  return { platform: 'eduzz', email, name, productId, productName, status };
}

function parseGeneric(body: any): ParsedPayload | null {
  const email = body?.email || body?.customer_email || body?.buyer_email;
  const name = body?.name || body?.customer_name || body?.buyer_name || 'Cliente';
  const productId = String(body?.product_id || body?.productId || body?.checkout_id || '');
  const productName = body?.product_name || body?.productName || '';
  const status = (body?.status || 'approved').toLowerCase();
  if (!email) return null;
  return { platform: 'generic', email, name, productId, productName, status };
}

function detectAndParse(body: any): ParsedPayload | null {
  // Try each platform detector
  if (body?.order?.Customer || body?.Customer) return parseKiwify(body);
  if (body?.data?.buyer || body?.data?.product) return parseHotmart(body);
  if (body?.comprador) return parseMonetizze(body);
  if (body?.client_email !== undefined) return parseEduzz(body);
  return parseGeneric(body);
}

const APPROVED_STATUSES = ['approved', 'paid', 'complete', 'completed', 'active', 'aprovado', 'pago'];

Deno.serve(async (req: Request) => {
  // Allow OPTIONS for CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  let rawBody = '';
  let body: any = {};

  try {
    rawBody = await req.text();
    body = JSON.parse(rawBody);
  } catch (_) {
    // Try form-urlencoded
    try {
      const params = new URLSearchParams(rawBody);
      body = Object.fromEntries(params.entries());
    } catch (_) {
      body = { raw: rawBody };
    }
  }

  const parsed = detectAndParse(body);

  if (!parsed) {
    await supabase.from('webhook_logs').insert([{
      payload: body,
      platform: 'unknown',
      status: 'error',
      member_email: null,
      product_name: null,
    }]);
    return new Response(JSON.stringify({ error: 'Could not parse payload' }), { status: 400 });
  }

  const { platform, email, name, productId, productName, status } = parsed;

  // Log the webhook arrival
  await supabase.from('webhook_logs').insert([{
    payload: body,
    platform,
    status: APPROVED_STATUSES.includes(status) ? 'approved' : status,
    member_email: email.toLowerCase(),
    product_name: productName || productId,
  }]);

  // Only provision access for approved purchases
  if (!APPROVED_STATUSES.includes(status)) {
    return new Response(JSON.stringify({ ok: true, message: 'Status not approved, logged only.' }), { status: 200 });
  }

  // Find product by checkout_id
  const { data: products } = await supabase
    .from('products')
    .select('id, name')
    .eq('checkout_id', productId)
    .limit(1);

  const product = products && products[0];

  // Find or create member
  const normalizedEmail = email.toLowerCase().trim();
  let member: any = null;
  const { data: existingMembers } = await supabase
    .from('members')
    .select('id, name, email')
    .eq('email', normalizedEmail)
    .limit(1);

  if (existingMembers && existingMembers.length > 0) {
    member = existingMembers[0];
  } else {
    // Create new member with random password
    const randomPass = Math.random().toString(36).slice(2, 10);
    const { data: newMember } = await supabase
      .from('members')
      .insert([{ name, email: normalizedEmail, pass: randomPass, role: 'student' }])
      .select()
      .single();
    member = newMember;
  }

  // Link member to product
  if (member && product) {
    // Avoid duplicate
    const { data: existing } = await supabase
      .from('member_products')
      .select('id')
      .eq('member_id', member.id)
      .eq('product_id', product.id)
      .limit(1);

    if (!existing || existing.length === 0) {
      await supabase.from('member_products').insert([{
        member_id: member.id,
        product_id: product.id,
      }]);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      platform,
      email: normalizedEmail,
      product: product?.name || 'not found (checkout_id: ' + productId + ')',
      member_created: !existingMembers?.length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
