// Définition locale des types pour supprimer l'erreur de module non trouvé dans l'IDE.
// Au moment du déploiement, Vercel injectera ses propres types Node.js.
interface VercelRequest {
  method?: string;
  body: any;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  // URL du Webhook de production
  const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://n8n.srv1071841.hstgr.cloud/webhook/AMAI_Voice_v1_gais";

  try {
    const auditData = request.body;

    const n8nResponse = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(auditData),
    });

    if (!n8nResponse.ok) {
      throw new Error(`n8n responded with ${n8nResponse.status}`);
    }

    return response.status(200).json({ success: true });
  } catch (error) {
    console.error('Proxy Error:', error);
    return response.status(500).json({ error: 'Failed to submit audit data' });
  }
}