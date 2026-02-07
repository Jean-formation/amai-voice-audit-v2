// api/normalize.ts
// Fonction serverless Vercel : normalisation IA côté serveur (clé non exposée au client)

import { GoogleGenAI } from '@google/genai';

// Types locaux (comme api/submit.ts) pour éviter les erreurs IDE
interface VercelRequest {
  method?: string;
  body: any;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

const FLASH_MODEL = 'gemini-3-flash-preview';

// Timeout côté serveur (ms) : garde une marge < ton timeout client
const SERVER_NORMALIZE_TIMEOUT_MS = 90_000;

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // On renvoie un "candidate: null" pour laisser le frontend fallback proprement
    return response.status(200).json({ candidate: null, error: 'MISSING_SERVER_API_KEY' });
  }

  try {
    const { transcript, rawData, questionsContext, prompt } = request.body || {};

    // Validation minimale
    if (!rawData || !Array.isArray(transcript) || !Array.isArray(questionsContext) || typeof prompt !== 'string') {
      return response.status(400).json({ error: 'Invalid payload', candidate: null });
    }

    const ai = new GoogleGenAI({ apiKey });

    // --- Guardrails de normalisation (Q01–Q05) : priorité sémantique ---
    // Objectif : empêcher le modèle de tomber sur l'option la plus basse ("absence")
    // quand la réponse indique clairement une maturité existante ("en cours", "structuré", "experts", etc.).
    const SEMANTIC_PRIORITY_RULES = `
    RÈGLE PRIORITAIRE — PRIORITÉ SÉMANTIQUE (Q01–Q05) :
    - Ces questions mesurent une maturité. "Pas terminé" ne veut pas dire "inexistant".
    - INTERDICTION : si la réponse utilisateur contient des indices d'existence / maturité, tu ne dois JAMAIS sélectionner l'option la plus basse (niveau 1 / absence).
    Indices typiques d'existence / maturité :
    - stratégie / déploiement : "en cours", "mise en œuvre", "pilotage", "POC", "test", "déployé partiellement"
    - données : "structuré", "consolidé", "centralisé", "plateforme", "DWH", "data lake"
    - compétences : "équipe", "experts", "ingénieurs", "développeurs", "R&D", "référent", "dédié"
    Conséquence :
    - si au moins un de ces indices apparaît, la valeur Q01–Q05 ne peut pas être le niveau 1.
    - dans ce cas, choisis au minimum le niveau 2, voire 3 si les indices sont forts (ex. plateforme bien gérée, équipe dédiée solide).

    EXEMPLES (à appliquer strictement) :
    - "en cours de mise en œuvre" => Q01 ne peut pas être "pas de stratégie".
    - "structurées, consolidées" => Q02 ne peut pas être "données cloisonnées et inaccessibles".
    - "3 ingénieurs font de la R&D IA" => Q03 ne peut pas être "très faibles / peu ou pas d'expertise".
    `;

    const finalPrompt = `${prompt}\n\n${SEMANTIC_PRIORITY_RULES}`;


    const aiPromise = ai.models.generateContent({
      model: FLASH_MODEL,
      contents: [{ parts: [{ text: finalPrompt }] }],
      config: {
        responseMimeType: 'application/json',
        temperature: 0,
      },
    });

    // Timeout simple (sans auto-référence)
    let timeoutId: any = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("SERVER_NORMALIZE_TIMEOUT"));
      }, SERVER_NORMALIZE_TIMEOUT_MS);
    });

    const resp: any = await Promise.race([aiPromise, timeoutPromise]);

    // Nettoyage du timer si la requête IA a gagné la course
    if (timeoutId) clearTimeout(timeoutId);

    // Parsing tolérant (même logique que ton client)
    let candidate: any = null;
    try {
      const rawText =
        typeof resp?.text === 'function'
          ? await resp.text()
          : (resp?.text ?? '{}');

      const cleaned = String(rawText).replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned || '{}');
      candidate = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      candidate = null;
    }

    // ... log temporaire après le parsing (candidate = ...)
    console.log('NORMALIZE CANDIDATE:', JSON.stringify(candidate, null, 2));

    return response.status(200).json({ candidate });
  } catch (e) {
    console.error('api/normalize error:', e);
    return response.status(200).json({ candidate: null, error: 'SERVER_NORMALIZE_FAIL' });
  }
}
