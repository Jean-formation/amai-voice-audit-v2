import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { QUESTIONS, SOURCE_TAG, NORMALIZATION_FALLBACKS_BY_NOTION_KEY } from './constants';
import { QuestionType, AuditData } from './types';
import { createBlobFromAudio, decode, decodeAudioData, encode } from './services/audioService';

const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const FLASH_MODEL = 'gemini-3-flash-preview';
const SESSIONS_STORAGE_KEY = 'amai_audit_v2_sessions';
const CURRENT_SESSION_ID_KEY = 'amai_audit_v2_current_id';
// Proxy Vercel pour la production
const API_SUBMIT_ENDPOINT = "/api/submit";
// URL Directe pour le test/preview (évite le 404 si le dossier /api n'est pas servi localement)
const DIRECT_WEBHOOK_URL = "https://n8n.srv1071841.hstgr.cloud/webhook/AMAI_Voice_v1_gais";
// Timeouts: on garde large côté envoi (réseaux mobiles / n8n), mais on limite strictement l'IA.
const SUBMIT_TIMEOUT_MS = 300000; // 300s
const AI_NORMALIZE_TIMEOUT_MS = 120000; // 120s: laisse le temps au modèle, sans bloquer 5 min

interface Session {
  id: string;
  createdAt: number;
  currentStep: number;
  auditData: AuditData;
  transcript: { role: string; text: string }[];
  isFinished: boolean;
  consecutiveErrors: number;
}

const recordAnswerFunction: FunctionDeclaration = {
  name: 'record_answer',
  parameters: {
    type: Type.OBJECT,
    description: 'Enregistre la réponse validée pour la question courante et avance à la suivante.',
    properties: {
      questionId: { type: Type.STRING, description: "L'ID de la question à laquelle l'utilisateur répond (ex: q01)." },
      value: { type: Type.STRING, description: "La valeur sélectionnée ou saisie." },
      multiValues: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Tableau de valeurs pour les choix multiples." },
      autreValue: { type: Type.STRING, description: "Valeur libre si l'option 'Autre' est choisie." }
    },
    required: ['questionId']
  }
};

const technicalClosureFunction: FunctionDeclaration = {
  name: 'technical_closure',
  parameters: {
    type: Type.OBJECT,
    description: 'Clôture l\'audit suite à des erreurs techniques ou incompréhensions répétées.',
    properties: {}
  }
};

function generateDingDongPCM(sampleRate = 16000): Int16Array {
  const duration = 1.0;
  const numSamples = sampleRate * duration;
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let freq = t < 0.4 ? 523.25 : 392.00;
    const localT = t < 0.4 ? t : t - 0.4;
    const decay = Math.exp(-localT * 6);
    samples[i] = Math.sin(2 * Math.PI * freq * t) * decay * 32767 * 0.4;
  }
  return samples;
}

const App: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>(() => {
    const saved = localStorage.getItem(SESSIONS_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    return localStorage.getItem(CURRENT_SESSION_ID_KEY);
  });
  const [isActive, setIsActive] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isKeySelected, setIsKeySelected] = useState(true);

  const [currentInputText, setCurrentInputText] = useState("");
  const [currentOutputText, setCurrentOutputText] = useState("");

  const currentInputTextRef = useRef("");
  const currentOutputTextRef = useRef("");
  const currentSessionIdRef = useRef<string | null>(null);
  const isPendingFinalSpeechRef = useRef(false);
  const silenceTimerRef = useRef<number | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentSession = useMemo(() => 
    sessions.find(s => s.id === currentSessionId) || null, 
    [sessions, currentSessionId]
  );

  const STAGES = [
    { label: "Maturité IA, Stratégie...", maxIndex: 4 },
    { label: "Votre rôle...", maxIndex: 7 },
    { label: "Votre entreprise...", maxIndex: 15 },
    { label: "Objectifs, Défis...", maxIndex: 18 },
    { label: "Finalisation de l'Audit…", maxIndex: 20 },
  ];

  const stageInfo = useMemo(() => {
    if (!currentSession) return { index: 1, label: STAGES[0].label };
    if (currentSession.isFinished) return { index: 5, label: STAGES[4].label };
    const idx = STAGES.findIndex(s => currentSession.currentStep <= s.maxIndex);
    const foundIdx = idx === -1 ? 4 : idx;
    return { index: foundIdx + 1, label: STAGES[foundIdx].label };
  }, [currentSession]);

  useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);

  useEffect(() => {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    if (currentSessionId) localStorage.setItem(CURRENT_SESSION_ID_KEY, currentSessionId);
  }, [sessions, currentSessionId]);

  useEffect(() => {
    let clearTimer: number | undefined;
    if (currentSession?.isFinished) {
      stopInterview();
      clearTimer = window.setTimeout(() => {
        setCurrentSessionId(null);
      }, 20000);
    }
    return () => {
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [currentSession?.isFinished, currentSession?.id]);

  useEffect(() => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      if (scrollHeight - scrollTop - clientHeight < 100) {
        scrollRef.current.scrollTop = scrollHeight;
      }
    }
  }, [currentSession?.transcript, currentInputText, currentOutputText]);

  useEffect(() => {
  const checkKey = async () => {
    try {
      const aistudio = (window as any)?.aistudio;
      // Si on n'est pas dans Google AI Studio, on considère "OK" pour ne pas bloquer l'app
      if (!aistudio?.hasSelectedApiKey) {
        setIsKeySelected(true);
        return;
      }
      const hasKey = await aistudio.hasSelectedApiKey();
      setIsKeySelected(!!hasKey);
    } catch (e) {
      // en cas d'erreur, on ne bloque pas l'UI
      setIsKeySelected(true);
    }
  };

  checkKey();
}, []);

  const resetSilenceTimer = () => {
    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const startSilenceTimer = () => {
    resetSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      if (sessionRef.current && isActive) {
        const sess = sessionsRef.current.find(s => s.id === currentSessionIdRef.current);
        const errCount = (sess?.consecutiveErrors || 0) + 1;
        sessionRef.current?.sendRealtimeInput({ text: `[SYSTEM_EVENT: SILENCE_10S, ERROR_COUNT: ${errCount}]` });
      }
    }, 10000);
  };

  const updateCurrentSession = (updates: Partial<Session>) => {
    if (!currentSessionIdRef.current) return;
    setSessions(prev => prev.map(s => s.id === currentSessionIdRef.current ? { ...s, ...updates } : s));
  };

  const createNewSession = (baseData: AuditData = {}) => {
    const newId = Date.now().toString();
    const newSession: Session = {
      id: newId,
      createdAt: Date.now(),
      currentStep: 0,
      auditData: baseData,
      transcript: [],
      isFinished: false,
      consecutiveErrors: 0
    };
    currentSessionIdRef.current = newId;
    isPendingFinalSpeechRef.current = false;
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newId);
    setShowHistory(false);
    setSubmissionStatus('idle');
    setCurrentInputText("");
    setCurrentOutputText("");
    currentInputTextRef.current = "";
    currentOutputTextRef.current = "";
    return newSession;
  };

  const stopAllAudio = () => {
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const stopInterview = async () => {
    resetSilenceTimer();
    if (sessionRef.current) {
      try { await sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    sessionPromiseRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    stopAllAudio();
    setIsActive(false);
    setCurrentInputText("");
    setCurrentOutputText("");
    currentInputTextRef.current = "";
    currentOutputTextRef.current = "";
  };

  const playLocalSignal = async (pcmData: Int16Array, sampleRate: number) => {
    if (!outputAudioContextRef.current) return;
    const buffer = outputAudioContextRef.current.createBuffer(1, pcmData.length, sampleRate);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < pcmData.length; i++) channelData[i] = pcmData[i] / 32768;
    const source = outputAudioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(outputAudioContextRef.current.destination);
    source.start();
    return new Promise(resolve => source.onended = resolve);
  };

  /**
 * Garantit le contrat de sortie: valeurs enum valides (ou "Autre" si autorisé) + texte libre conservé.
 * La normalisation LLM peut enrichir, mais ne doit JAMAIS bloquer ni casser le JSON.
 */
const buildGuaranteedPayload = (
  rawData: AuditData,
  transcript: { role: string; text: string }[],
  candidate: Record<string, any> | null
) => {
  const base: Record<string, any> = { ...rawData, ...(candidate || {}) };

  const getAllowed = (q: any): string[] => Array.isArray(q.options) ? q.options : [];
  const hasAutre = (q: any): boolean => {
    const opts = getAllowed(q);
    return !!q.autreKey && (q.triggerAutre ? opts.includes(q.triggerAutre) : opts.includes("Autre"));
  };
  const autreLabel = (q: any): string => (q.triggerAutre && typeof q.triggerAutre === 'string') ? q.triggerAutre : "Autre";

  const ensureSelect = (q: any, value: any): string => {
  const opts = getAllowed(q);
  const vRaw = (value ?? '').toString().trim();

  // 0) Cas vide
  if (!vRaw) {
    // Si "Autre" autorisé, on force Autre (mais Q01–Q05 n'ont pas Autre)
    if (hasAutre(q)) return autreLabel(q);
    // Sinon, on force une option (contrainte métier)
    return opts[0] ?? '';
  }

  // 1) Match direct (libellé exact)
  if (opts.includes(vRaw)) return vRaw;

  // 2) Accepter un index "1..N" (robuste au LLM)
  // Ex: "2" -> opts[1]
  if (/^\d+$/.test(vRaw)) {
    const idx = parseInt(vRaw, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= opts.length) return opts[idx - 1];
  }

  // 3) Normalisation simple (accents / casse / ponctuation)
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’]/g, "'")
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const v = norm(vRaw);
  const optByNorm = new Map(opts.map((o) => [norm(o), o]));
  if (optByNorm.has(v)) return optByNorm.get(v)!;

  // 4) Heuristiques Q01–Q05 (sans "Autre") : choisir une option plausible plutôt que opts[0]
  // On détecte Q01–Q05 via questionId si disponible, sinon via notionKey.
  const qid = (q.questionId ?? q.id ?? '').toString();
  const nk = (q.notionKey ?? '').toString();

  const isQ01toQ05 =
    /^q0[1-5]$/i.test(qid) ||
    /Maturité\s*–\s*(Stratégie|Données|Process|Gouvernance|Compétences)/i.test(nk);

  if (isQ01toQ05 && opts.length >= 4) {
    // Score simple par mots-clés (à affiner si besoin)
    const scoreByIndex = [0, 0, 0, 0]; // pour opts[0..3]

    const add = (i: number, w: number) => { scoreByIndex[i] += w; };

    // Mots-clés "exploration" (option 1)
    if (/\b(explore|exploration|test|pilote|poc|debut|commence)\b/.test(v)) add(0, 2);
    if (/\b(pas\s+de\s+strategie|aucun\s+cadre|rien\s+de\s+structure)\b/.test(v)) add(0, 3);

    // Mots-clés "projets spécifiques" (option 2)
    if (/\b(projet|cas\s+d\s+usage|use\s+case|ponctuel|quelques)\b/.test(v)) add(1, 2);
    if (/\b(non\s+etendu|pas\s+generalise|pas\s+a\s+l\s+echelle)\b/.test(v)) add(1, 2);

    // Mots-clés "entreprise / déploiement" (option 3)
    if (/\b(entreprise|global|transverse|deploi|mise\s+en\s+place|en\s+cours)\b/.test(v)) add(2, 2);
    if (/\b(structure|formalise|strategie\s+claire)\b/.test(v)) add(2, 2);

    // Mots-clés "intégrée / innovation" (option 4)
    if (/\b(integre|integration|aligne|commercial|innovation|avantage|competitif)\b/.test(v)) add(3, 2);
    if (/\b(stimule|accelere|transforme)\b/.test(v)) add(3, 1);

    // Cas Q02 (données) : orienter vers niveau 3 si "structuré/consolidé"
    if (/Donnees|Données/i.test(nk)) {
      if (/\b(structure|consolide|centralise|plateforme|gouvernance)\b/.test(v)) add(2, 3);
      if (/\b(cloisonne|inaccessible)\b/.test(v)) add(0, 3);
    }

    // Choisir le meilleur score
    let bestIdx = 0;
    for (let i = 1; i < 4; i++) {
      if (scoreByIndex[i] > scoreByIndex[bestIdx]) bestIdx = i;
    }

    // Si tout est à 0, on ne force pas option 1 : on passe au fallback métier puis au "plus proche"
    const maxScore = Math.max(...scoreByIndex);
    if (maxScore > 0) return opts[bestIdx];
  }

  // 5) Si "Autre" est autorisé, on force "Autre" et on stocke le brut
  if (hasAutre(q)) {
    if (q.autreKey && !base[q.autreKey]) base[q.autreKey] = vRaw;
    return autreLabel(q);
  }

  // 6) Fallback métier explicite si défini
  const fb = NORMALIZATION_FALLBACKS_BY_NOTION_KEY[q.notionKey];
  if (fb && opts.includes(fb)) return fb;

  // 7) Dernier recours (contrainte métier) : on force une option MAIS PAS forcément opts[0]
  // -> on choisit celle dont la normalisation est la plus proche (simple)
  let best = opts[0] ?? '';
  let bestScore = -1;
  const tokens = new Set(v.split(' ').filter(Boolean));
  for (const o of opts) {
    const on = norm(o);
    const ot = new Set(on.split(' ').filter(Boolean));
    let inter = 0;
    for (const t of tokens) if (ot.has(t)) inter++;
    const union = tokens.size + ot.size - inter;
    const sc = union ? inter / union : 0;
    if (sc > bestScore) { bestScore = sc; best = o; }
  }
  return best;
};

  const ensureMultiSelect = (q: any, value: any): string[] => {
  const opts = getAllowed(q);
  const maxItems = q.maxItems || opts.length;

  // --- helpers
  const norm = (s: string) =>
    String(s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const pushUnique = (arr: string[], v: string) => {
    if (v && !arr.includes(v)) arr.push(v);
  };

  const parseTokens = (v: any): string[] => {
    if (Array.isArray(v)) return v.map(x => String(x ?? '').trim()).filter(Boolean);
    if (typeof v === 'string') {
      // support: "1", "1. xxx", "1,2,3", "a; b; c", lignes, etc.
      return v
        .split(/[\n,;|]+/g)
        .map(x => x.trim())
        .filter(Boolean);
    }
    return [];
  };

  const tokenToOptionByIndex = (t: string): string | null => {
    // "1" / "1." / "1 - ..." => option #1
    const m = /^(\d{1,2})\b/.exec(t);
    if (!m) return null;
    const idx = parseInt(m[1], 10);
    if (!Number.isFinite(idx) || idx < 1 || idx > opts.length) return null;
    return opts[idx - 1];
  };

  // --- 1) Try explicit values (exact match) + index forms
  const rawTokens = parseTokens(value);
  const selected: string[] = [];

  for (const t of rawTokens) {
    const byIndex = tokenToOptionByIndex(t);
    if (byIndex) {
      pushUnique(selected, byIndex);
      continue;
    }
    if (opts.includes(t)) {
      pushUnique(selected, t);
      continue;
    }
    // tolerate "n. Libellé" exact libellé
    const t2 = t.replace(/^\d+\s*[.)-]\s*/g, '').trim();
    if (opts.includes(t2)) pushUnique(selected, t2);
  }

  if (selected.length > 0) return selected.slice(0, maxItems);

  // --- 2) If still empty, infer from "*-Autre" when present (Q17–Q19 mainly)
  const autreText =
    (q.autreKey && typeof base[q.autreKey] === 'string' && base[q.autreKey].trim())
      ? String(base[q.autreKey]).trim()
      : (typeof value === 'string' ? value.trim() : '');

  const nk = String(q.notionKey ?? '');
  const qid = String(q.questionId ?? '');

  const isQ17toQ19 =
    /q17|q18|q19/i.test(qid) ||
    /(Objectifs IA-Digital|Défis prioritaires|Attentes IA-Digital)/i.test(nk);

  if (isQ17toQ19 && autreText) {
    const t = norm(autreText);

    // scoring par regex -> index option
    const scored: number[] = new Array(opts.length).fill(0);
    const add = (idx0: number, w: number) => { if (idx0 >= 0 && idx0 < scored.length) scored[idx0] += w; };

    // Q17 Objectifs (11 options dont "Autre" en dernier)
    if (/Objectifs IA-Digital/i.test(nk) || /q17/i.test(qid)) {
      if (/\b(cycle de vente|vente|crm|prospection|pipeline|commercial)\b/.test(t)) add(0, 3);
      if (/\b(tableau de bord|dashboard|kpi|reporting|pilotage)\b/.test(t)) add(1, 3);
      if (/\b(assistant|automatiser|administratif|factur|compta|rh)\b/.test(t)) add(2, 3);
      if (/\b(recommandation|personnalis|produit|contenu)\b/.test(t)) add(3, 3);
      if (/\b(anomalie|qualite|defaut|controle|production)\b/.test(t)) add(4, 3);
      if (/\b(maintenance|predict|equipement|panne)\b/.test(t)) add(5, 3);
      if (/\b(strategie)\b/.test(t)) {
        if (/\b(commercial)\b/.test(t)) add(6, 2);
        if (/\b(innovation)\b/.test(t)) add(7, 2);
        if (/\b(finance|fiscal)\b/.test(t)) add(8, 2);
        if (/\b(management|organisation)\b/.test(t)) add(9, 2);
      }
    }

    // Q18 Défis (9 options dont "Autre" en dernier)
    if (/Défis prioritaires/i.test(nk) || /q18/i.test(qid)) {
      if (/\b(strategie|data)\b/.test(t)) add(0, 3);
      if (/\b(process|productiv|automatis)\b/.test(t)) add(1, 3);
      if (/\b(croissance|commercial|differenci|concurr)\b/.test(t)) add(2, 3);
      if (/\b(donnees|valoris|data management|qualite)\b/.test(t)) add(3, 3);
      if (/\b(marge|cout)\b/.test(t)) add(4, 3);
      if (/\b(satisfaction|client|experience)\b/.test(t)) add(5, 3);
      if (/\b(rgpd|ai act|ethique|conform)\b/.test(t)) add(6, 3);
      if (/\b(recrut|competenc|formation|skill)\b/.test(t)) add(7, 3);
    }

    // Q19 Attentes (6 options dont "Autre" en dernier)
    if (/Attentes IA-Digital/i.test(nk) || /q19/i.test(qid)) {
      if (/\b(proposition de valeur|valeur)\b/.test(t)) add(0, 3);
      if (/\b(feuille de route|roadmap|strateg)\b/.test(t)) add(1, 3);
      if (/\b(operationnel|automatis|process)\b/.test(t)) add(2, 3);
      if (/\b(productiv|temps|gagner du temps)\b/.test(t)) add(3, 3);
      if (/\b(marge)\b/.test(t)) add(4, 3);
    }

    // sélection des meilleurs scores (>0)
    const ranked = scored
      .map((score, idx) => ({ idx, score }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxItems)
      .map(x => opts[x.idx]);

    if (ranked.length > 0) return ranked;
  }

  // --- 3) Fallback: Autre si autorisé (et stocker le brut), sinon []
  if (hasAutre(q)) {
    if (q.autreKey && !base[q.autreKey]) base[q.autreKey] = String(autreText || value || '').trim();
    return [autreLabel(q)];
  }

  return [];
};

  const ensureBool = (value: any): boolean => {
    if (typeof value === 'boolean') return value;
    const v = String(value ?? '').toLowerCase().trim();
    return (v === 'true' || v === 'oui' || v === 'ok' || v === 'accord' || v === 'yes' || v === "j'accepte" || v === 'accepte');
  };

  // Enforce question-by-question.
  for (const q of QUESTIONS) {
    const current = base[q.notionKey];
    if (q.type === QuestionType.MULTI_SELECT) {
      base[q.notionKey] = ensureMultiSelect(q, current);
    } else if (q.type === QuestionType.BOOL) {
      base[q.notionKey] = ensureBool(current);
    } else if (q.type === QuestionType.SELECT) {
      base[q.notionKey] = ensureSelect(q, current);
    } else {
      // STRING ou autres: garder la valeur brute.
      if (base[q.notionKey] === undefined || base[q.notionKey] === null) base[q.notionKey] = '';
    }
  }

  // Champs meta (compat Notion/n8n existants)
  base.session_id = currentSessionIdRef.current;
  base.source = SOURCE_TAG;
  const nowISO = new Date().toISOString();
  // Tolérant: certains flux existants peuvent attendre l'une ou l'autre clé.
  base["Date soumission"] = (base["Date soumission"] as any) || nowISO;
  base["'Date soumission'"] = (base["'Date soumission'"] as any) || base["Date soumission"];
  base.executionMode = base.executionMode || "production_guarded";

  // Optionnel: si Nom soumission manque, on dérive du mail.
  if (!base["Nom soumission"] && typeof base["e-mail répondant"] === 'string' && base["e-mail répondant"].includes('@')) {
    base["Nom soumission"] = String(base["e-mail répondant"]).split('@')[0];
  }

  return base;
};

const normalizeAuditData = async (
  transcript: { role: string; text: string }[],
  rawData: AuditData,
  signal?: AbortSignal
) => {
  // Contrat: ne JAMAIS bloquer l'envoi. Si IA KO => payload garanti depuis rawData.
  try {
    // Côté client : pas de clé. On appelle le proxy serveur /api/normalize
    const questionsContext = QUESTIONS.map(q => ({
      property: q.notionKey,
      label: q.label,
      options: q.options || [],
      type: q.type,
      autreKey: q.autreKey,
    }));

    // Prompt identique (pas secret). Le serveur renverra un "candidate" JSON.
    const prompt = `
Tu es un assistant de NORMALISATION DE DONNÉES pour un audit vocal.

OBJECTIF
- Proposer un JSON candidat (best-effort) à partir du transcript + données brutes.
- Le système appliquera ensuite des règles de validation/fallback : tu n'as pas besoin d'être parfait.

CONTRAINTES ABSOLUES
- Retourne UNIQUEMENT un objet JSON (aucun texte autour, aucun markdown).
- Une seule tentative : pas de boucle, pas de "réparation".
- Si tu n'es pas sûr d'un champ : laisse-le vide ("") ou omets-le plutôt que d'inventer.

RÈGLES DE MAPPING (BEST-EFFORT)
1) Mapping sémantique : si réponse libre, choisis l'option la plus proche parmi les options autorisées.
2) Fidélité libellés : pour select/multi-select, utilise des libellés EXACTS présents dans les options (copier-coller).
3) Ne reformule jamais un libellé d'option.
4) Logique "Autre" : n'utilise "Autre" que si aucune option ne convient ; dans ce cas conserve le texte libre dans le champ "-Autre" associé quand il existe.
7) Consentement RGPD (bool) : si l'utilisateur exprime un accord (ex: "oui", "d'accord", "ok", "j'accepte"), mets true ; sinon false.

DONNÉES
Transcript: ${JSON.stringify(transcript)}
Données brutes déjà collectées: ${JSON.stringify(rawData)}
Questions / options: ${JSON.stringify(questionsContext, null, 2)}
`.trim();

    // Timeout client + support AbortSignal (si fourni)
    const controller = new AbortController();
    const clientTimeoutMs = 95_000; // doit être > timeout serveur (ex: 90s) + marge
    const t = setTimeout(() => controller.abort(), clientTimeoutMs);

    // Si on a déjà un signal (ex: submit global), on le chaîne au controller local
    if (signal?.addEventListener) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const res = await fetch("/api/normalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        transcript,
        rawData,
        questionsContext,
        prompt,
      }),
    }).finally(() => clearTimeout(t));

    // Même si serveur KO, on ne bloque pas : fallback garanti
    if (!res.ok) {
      return buildGuaranteedPayload(rawData, transcript, null);
    }

    const data = await res.json().catch(() => ({} as any));
    const candidate = data?.candidate && typeof data.candidate === "object" ? data.candidate : null;

    // Contrat final garanti ici (côté client)
    return buildGuaranteedPayload(rawData, transcript, candidate);
  } catch (e) {
    console.error("normalizeAuditData server-proxy fail:", e);
    return buildGuaranteedPayload(rawData, transcript, null);
  }
};

  /**
 * submitToWebhook
 * - Timeout global unique (IA + POST)
 * - Aucun retry client (déterminisme, pas de double envoi)
 * - Compatible Vercel / AbortController
 */
  const submitToWebhook = async (rawData: AuditData) => {
  setSubmissionStatus("submitting");
  setErrorMsg(null);

  // PROD Vercel = /api/submit ; DEV local = webhook direct
  const endpoint = import.meta.env.PROD
    ? API_SUBMIT_ENDPOINT
    : DIRECT_WEBHOOK_URL;

  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    SUBMIT_TIMEOUT_MS // 300s
  );

  try {
    const currentSess = sessionsRef.current.find(
      (s) => s.id === currentSessionIdRef.current
    );
    const transcript = currentSess?.transcript || [];

    const payload = await normalizeAuditData(
      transcript,
      rawData,
      controller.signal
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    setSubmissionStatus("success");
  } catch (error: any) {
    console.error("submitToWebhook failed:", error);

    const isTimeout =
      error?.name === "AbortError" ||
      String(error?.message || "").includes("AI_ABORTED") ||
      String(error?.message || "").includes("AI_NORMALIZE_TIMEOUT");

    setErrorMsg(
      isTimeout
        ? "Le délai de transmission a été dépassé (300s)."
        : "La transmission des données a échoué. Veuillez contacter le support."
    );

    setSubmissionStatus("error");
  } finally {
    window.clearTimeout(timeoutId);
  }
};

  const handleRecordAnswer = (args: any) => {
    if (!currentSessionIdRef.current) return "Erreur session.";
    const { questionId, value, multiValues, autreValue } = args;
    const qIndex = QUESTIONS.findIndex(q => q.id === questionId);
    if (qIndex === -1) return "ID de question invalide.";

    const nextStep = qIndex + 1;
    let resultMsg = "";
    
    const currentSession = sessionsRef.current.find(s => s.id === currentSessionIdRef.current);
    if (!currentSession) return "Session introuvable.";

    const q = QUESTIONS[qIndex];
    const newData = { ...currentSession.auditData };
    if (q.type === QuestionType.MULTI_SELECT) newData[q.notionKey] = multiValues || [];
    else if (q.type === QuestionType.BOOL) {
      const v = String(value).toLowerCase().trim();
      newData[q.notionKey] = (v === 'true' || v === 'oui' || v === 'ok' || v === 'accord' || v === 'yes');
    }
    else newData[q.notionKey] = value;
    
    if (autreValue && q.autreKey) newData[q.autreKey] = autreValue;
    
    setSessions(prev => prev.map(s => s.id === currentSessionIdRef.current 
      ? { ...s, auditData: newData, currentStep: nextStep, consecutiveErrors: 0 } 
      : s
    ));

    if (nextStep >= QUESTIONS.length) {
      resultMsg = "[EVENT: AUDIT_COMPLETED]";
      isPendingFinalSpeechRef.current = true;
      submitToWebhook(newData);
    } else {
      resultMsg = "[EVENT: RECORD_SUCCESS]";
    }

    return resultMsg;
  };

  const handleTechnicalClosure = () => {
    const session = sessionsRef.current.find(s => s.id === currentSessionIdRef.current);
    if (session) submitToWebhook(session.auditData);
    updateCurrentSession({ isFinished: true });
    isPendingFinalSpeechRef.current = true;
    return "[EVENT: TECHNICAL_CLOSURE]";
  };

  const startInterview = async () => {
  const aistudio = (window as any)?.aistudio;

  // Si on est dans AI Studio, on garde le mécanisme d'ouverture de clé
  if (aistudio?.hasSelectedApiKey) {
    const hasKey = await aistudio.hasSelectedApiKey();
    if (!hasKey) {
      await aistudio.openSelectKey?.();
      return;
    }
  }

  // ... le reste de ton startInterview inchangé
    
    setErrorMsg(null);
    setSubmissionStatus('idle');
    stopAllAudio();
    setCurrentInputText("");
    setCurrentOutputText("");
    currentInputTextRef.current = "";
    currentOutputTextRef.current = "";

    let sessionToUse = currentSession;
    if (!sessionToUse || sessionToUse.isFinished) sessionToUse = createNewSession();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      
      setIsActive(true);

      const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GOOGLE_API_KEY });
      
      const currentQ = QUESTIONS[sessionToUse.currentStep] || QUESTIONS[0];

      const systemInstruction = `Tu es AMAI, consultant senior Memo5D. Ta mission est de réaliser un audit de maturité IA et Digital, sous forme d'entretien vocal naturel, professionnel et fluide.

RÈGLES DE VOIX :
- Adopte un ton de voix baryton, très calme et profond.
- Maintiens une assurance sereine et une tessiture basse.
- Ton débit de parole doit être naturel et posé, comme celui d'un consultant senior à l'écoute. 
- Évite toute excitation ou montée dans les aigus. 
- Marque des pauses naturelles entre tes phrases pour renforcer l'aspect analytique et serein.

RÈGLES DE FLUX ET SÉQUENÇAGE (CRITIQUES) :
1. VERROU DE PONCTUATION : Une seule question par intervention.
2. VERROU D'ÉVÉNEMENT : Attends [EVENT: RECORD_SUCCESS] pour valider la réponse et passer à la suivante.
3. PAS DE RÉFÉRENCE TECHNIQUE : Ne prononce jamais de noms d'outils ou d'IDs de questions.

RÈGLES UX CONVERSATIONNELLES (ANTI-FORMULAIRE) :
- INTERDIT À L’ORAL : "Répondez X", "Choisissez X", "Option X", "Précisez en choisissant…", "Autre", ou toute numérotation d’options.
- INTERDIT À L’ORAL : lire une liste complète d’options. Utilise les options uniquement en interne pour choisir.
- SI AMBIGUÏTÉ : reformule brièvement et propose AU MAXIMUM 2 possibilités, sans numéros, puis demande :
  "Qu’est-ce qui se rapproche le plus de votre situation : la première possibilité ou la seconde ?"
  ou "Plutôt A ou plutôt B ?"
- VALIDATION : n'appelle record_answer qu'après que l’utilisateur a clairement choisi (ex: "la première", "A", ou en répétant une des formulations).
- VOCABULAIRE : ne dis jamais "individus". Utilise "collaborateurs", "membres de l’équipe", "personnes", "équipes".

INVARIANT APPLICATIF (PRIORITAIRE SUR L’UX) :
- Dès qu’une correspondance fiable est identifiée entre la réponse utilisateur et une option :
  - appelle record_answer immédiatement.
- L’UX (feedback, reformulation, transition) vient toujours après l’enregistrement.
- Ne saute jamais record_answer pour améliorer la conversation.

RYTHME / TOUR DE PAROLE (CRITIQUE) :
- Ne coupe jamais l’utilisateur.
- Si l’utilisateur parle en plusieurs phrases ou hésite, attends un silence clair avant de répondre.
- Si tu as parlé trop tôt : dis "Pardon, allez-y, je vous écoute." puis laisse terminer.
- INTERDICTION D’AUTO-RÉPONSE : ne jamais proposer une réponse à la place de l’interviewé (interdit : "Donc vous êtes...", "Plutôt X.", "Vous êtes plutôt Y.").
- INTERDIT : terminer une question par une option formulée comme une affirmation (ex : "Plutôt X.").
- OBLIGATION : si tu proposes des possibilités, elles doivent être formulées comme une question (ex : "Plutôt X ou plutôt Y ?"), puis tu te tais.
- UNE SEULE QUESTION PAR TOUR : ne pas enchaîner question + suggestion de réponse dans la même phrase.
- APRÈS UNE QUESTION : tu t’arrêtes et tu attends la réponse, sans conclure.
- SI PAS DE RÉPONSE (pause / silence) : tu dis UNE seule relance courte, puis tu attends (varier entre : "Je vous écoute." / "Souhaitez-vous que je reformule ?" / "Voulez-vous que je précise ?"). Ne pas répéter la même relance en boucle.
- SI L’UTILISATEUR SIGNALE QUE TU AS RÉPONDU À SA PLACE : répondre uniquement "Pardon, vous avez raison. Je vous écoute." puis reposer la question de manière neutre (sans proposer de réponse), puis silence.

FEEDBACK HUMAIN (COURT ET VARIÉ) :
- Après un enregistrement clair, ajoute 1 phrase courte maximum en t'inspirant de ces formulations (en variant) :
  "Très clair.", "Merci, je vois bien.", "Merci pour cette précision.",
  "Intéressant, cela éclaire votre situation.", "Parfait.", "Bien compris."
- Puis enchaîne immédiatement avec la question suivante.
- N’explique jamais l’action interne (ne dis pas : "je sélectionne", "je note", "j’enregistre", "option", "autre").

CLARIFICATION SANS LISTE :
- Ne lis jamais une liste complète d’options.
- En cas de doute :
  - propose 2 ou 3 exemples typiques formulés naturellement,
  - puis laisse l’utilisateur compléter librement.
- Pour les multi-select (Q17–Q19) :
  - mappe les éléments reconnus,
  - enregistre le reste dans "autre" sans le verbaliser.

CONSIGNES DE DIALOGUE :
- Réponds oralement aux demandes de précision sans appeler record_answer.
- Sois naturel mais reste sur les options prévues pour Notion.

RÈGLES d'OR :
1. INTRODUCTION : "Bonjour, Bienvenue, heureux de vous accompagner pour votre audit de maturité IA et digital de votre entreprise, en tant qu'agent IA Amai, consultant senior pour Memo5D. Pour commencer..." puis pose la première question.
2. EMAIL (q20) : Indique que l'email peut être vérifié sous l'avatar.
3. FIN d'AUDIT : Prononce exactement cette phrase : "Merci pour votre participation à cet audit, vous allez recevoir votre rapport d'audit par email d'ici quelques minutes, à bientôt sur memo5d.fr".

RÈGLES DE CLARIFICATION (uniquement Q01–Q05 — questions fermées sans "Autre") :
- L’utilisateur peut répondre librement et longuement.
- Ton objectif est de sélectionner UNE option existante sans jamais demander un numéro à l’oral.
- Tu ne clarifies que si tu ne peux pas choisir une option avec certitude (réponse floue, contradictoire, trop générale).
- Dans ce cas :
  1) Reformule 2 possibilités MAXIMUM, sous forme de formulations naturelles et courtes (sans numéros).
     (Tu peux t’aider des options 1/2 en interne, mais ne les prononce jamais.)
  2) Pose UNE question de choix naturel (utilise l’une de ces 2 formulations) :
     - "Qu’est-ce qui se rapproche le plus de votre situation : la première possibilité ou la seconde ?"
     - "Plutôt la première ou plutôt la seconde ?"
  3) N’appelle PAS record_answer tant que l’utilisateur n’a pas explicitement choisi
     ("la première", "la seconde", ou en répétant une formulation).
- Une fois le choix explicite obtenu :
  - appelle record_answer avec value="1" ou value="2" (repère interne),
  - sans prononcer "1" ou "2" à l’oral.

RÈGLES DE RÉPONSE (Select / Multi-select) :
- Pour les questions SELECT : si tu appelles record_answer, tu peux fournir soit le LIBELLÉ exact, soit un INDEX "1", "2", "3"...
- Pour les questions MULTI_SELECT : multiValues peut contenir des LIBELLÉS exacts ou des INDEX "1", "2", etc. (séparés si besoin).
- Pour Q17–Q19 (si "Autre" est autorisé) : si la réponse ne rentre pas dans les options, utilise "Autre" + autreValue avec le texte libre.

LISTE DES QUESTIONS ET OPTIONS (pour aider la sélection) :
${QUESTIONS.map(q => {
  const opts = Array.isArray((q as any).options) ? (q as any).options : [];
  const optsText = opts.length
    ? opts.map((o: string, i: number) => `${i + 1}) ${o}`).join(' | ')
    : '(pas d’options)';
  return `- ${q.id}: "${q.label}" | type=${q.type} | options: ${optsText}`;
}).join('\n')}`;

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            if (!audioContextRef.current) return;
            const source = audioContextRef.current.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ media: createBlobFromAudio(inputData) }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current.destination);

            playLocalSignal(generateDingDongPCM(16000), 16000).then(() => {
              setTimeout(() => {
                const startEvent = sessionToUse!.currentStep > 0 
                  ? `[EVENT: RESUME_AUDIT, ID: ${currentQ.id}]` 
                  : `[EVENT: START_AUDIT]`;
                sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ text: startEvent }));
              }, 800);
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64 = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64 && outputAudioContextRef.current) {
              resetSilenceTimer();
              const audioBuffer = await decodeAudioData(decode(base64), outputAudioContextRef.current, 24000, 1);
              const source = outputAudioContextRef.current.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContextRef.current.destination);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContextRef.current.currentTime);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) {
              resetSilenceTimer();
              currentInputTextRef.current += message.serverContent.inputTranscription.text;
              setCurrentInputText(currentInputTextRef.current);
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTextRef.current += message.serverContent.outputTranscription.text;
              setCurrentOutputText(currentOutputTextRef.current);
            }

            if (message.serverContent?.turnComplete) {
              const input = currentInputTextRef.current.trim();
              const output = currentOutputTextRef.current.trim();
              
              if (input || output) {
                setSessions(prev => prev.map(s => {
                  if (s.id === currentSessionIdRef.current) {
                    const newT = [...s.transcript];
                    if (input) newT.push({ role: 'User', text: input });
                    if (output) newT.push({ role: 'Agent', text: output });
                    
                    let newErrCount = s.consecutiveErrors;
                    const isErrorResponse = output.toLowerCase().includes("désolé") && (output.toLowerCase().includes("comprends") || output.toLowerCase().includes("compris"));
                    if (isErrorResponse) newErrCount += 1;
                    else if (input.length > 2) newErrCount = 0;

                    return { ...s, transcript: newT, consecutiveErrors: newErrCount };
                  }
                  return s;
                }));
              }
              
              currentInputTextRef.current = "";
              currentOutputTextRef.current = "";
              setCurrentInputText("");
              setCurrentOutputText("");
              startSilenceTimer();

              if (isPendingFinalSpeechRef.current) {
                isPendingFinalSpeechRef.current = false;
                const now = outputAudioContextRef.current?.currentTime || 0;
                const audioRemaining = Math.max(0, (nextStartTimeRef.current - now) * 1000);
                
                setTimeout(() => {
                  updateCurrentSession({ isFinished: true });
                }, audioRemaining + 500);
              }
            }

            if (message.serverContent?.interrupted) stopAllAudio();

            if (message.toolCall) {
              // Ajout d'une sécurité (|| []) pour satisfaire TypeScript strict
              for (const fc of (message.toolCall.functionCalls || [])) {
                let res = "";
                if (fc.name === 'record_answer') res = handleRecordAnswer(fc.args);
                if (fc.name === 'technical_closure') res = handleTechnicalClosure();
                sessionPromiseRef.current?.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: res } }
                }));
              }
            }
          },
          onerror: (e: any) => { 
            console.error("Live API Error:", e);
            setErrorMsg("Service temporairement indisponible."); 
            stopInterview(); 
            setIsActive(false);
          },
          onclose: () => setIsActive(false),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction,
          tools: [{ functionDeclarations: [recordAnswerFunction, technicalClosureFunction] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      sessionPromiseRef.current = sessionPromise;
      sessionPromise.then(s => sessionRef.current = s);
    } catch (err) { 
      console.error("Start Interview Error:", err);
      setErrorMsg("Impossible de démarrer l'entretien."); 
      setIsActive(false); 
    }
  };

  const copyTranscript = () => {
    if (!currentSession) return;
    const text = currentSession.transcript.map(t => `${t.role === 'Agent' ? 'Amai' : 'Interviewé'}: ${t.text}`).join('\n');
    navigator.clipboard.writeText(text);
    alert("Transcript copié !");
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-gray-50 text-gray-900">
      {!isKeySelected && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] p-8 max-sm w-full text-center shadow-2xl">
            <h2 className="text-2xl font-black mb-4">Clé API Requise</h2>
            <p className="text-gray-500 mb-8 text-sm"><a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="text-blue-500 font-bold">Billing Info →</a></p>
            <button onClick={() => { (window as any).aistudio.openSelectKey(); setIsKeySelected(true); }} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold">Sélectionner ma clé</button>
          </div>
        </div>
      )}

      <div className="w-full max-w-md flex justify-between items-center mb-6 px-2">
        <button onClick={() => setShowHistory(true)} className="p-2 text-gray-400 hover:text-blue-500 transition-colors"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></button>
        <span className="text-xl font-black tracking-tighter uppercase">AMAI <span className="text-blue-500">VOICE</span></span>
        <button onClick={() => { stopInterview(); createNewSession(); }} className="p-2 text-gray-400 hover:text-blue-500 transition-colors"><svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357-2H15" /></svg></button>
      </div>

      <div className="w-full max-w-md bg-white rounded-[3rem] shadow-2xl overflow-hidden flex flex-col relative aspect-[9/16] border border-gray-100">
        <div className="h-[42%] flex flex-col items-center justify-center p-8 bg-gradient-to-b from-blue-50/50 via-white to-white relative">
          <div className="relative">
            <div className={`w-36 h-36 rounded-full overflow-hidden shadow-2xl border-4 border-white transition-all duration-500 transform ${isActive ? 'scale-110 shadow-blue-200' : 'scale-100'} relative`}>
              <div className={`absolute inset-0 transition-opacity duration-500 bg-gradient-to-br from-blue-400 to-blue-800 ${isActive ? 'opacity-0' : 'opacity-100'}`} />
              <div className={`absolute inset-0 transition-opacity duration-500 bg-gradient-to-tr from-indigo-500 via-purple-500 to-cyan-400 ${isActive ? 'opacity-100' : 'opacity-0'} ${isActive ? 'animate-orb-rotate' : ''}`} />
              <div className={`absolute inset-0 bg-white/10 ${isActive ? 'animate-pulse' : ''}`} />
            </div>
          </div>
          <button onClick={startInterview} className={`mt-10 w-20 h-20 rounded-full shadow-2xl flex items-center justify-center transition-all duration-300 hover:scale-105 active:scale-95 ${isActive ? 'bg-red-500' : 'bg-gray-900'}`}>{isActive ? <div className="w-6 h-6 bg-white rounded-sm" /> : <svg className="w-10 h-10 text-white ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>}</button>
          
          <div className="absolute top-4 right-8">
            {submissionStatus === 'submitting' && <div className="flex items-center gap-2 text-[10px] font-bold text-blue-500 animate-pulse uppercase"><div className="w-2 h-2 bg-blue-500 rounded-full" /> Transmission...</div>}
            {submissionStatus === 'success' && <div className="flex items-center gap-2 text-[10px] font-bold text-green-500 uppercase"><div className="w-2 h-2 bg-green-500 rounded-full" /> Diagnostic envoyé</div>}
            {submissionStatus === 'error' && <div className="flex items-center gap-2 text-[10px] font-bold text-red-500 uppercase"><div className="w-2 h-2 bg-red-500 rounded-full" /> Échec envoi</div>}
          </div>

          {currentSession && currentSession.currentStep >= 19 && (
            <div className="mt-6 w-full max-w-[260px] animate-in fade-in slide-in-from-top-2">
              <input type="email" value={currentSession.auditData['e-mail répondant'] || ''} onChange={(e) => updateCurrentSession({ auditData: { ...currentSession.auditData, 'e-mail répondant': e.target.value } })} placeholder="votre@email.com" className="w-full px-4 py-2 bg-gray-50/80 border rounded-2xl text-sm text-center focus:ring-2 focus:ring-blue-500/20 text-gray-700 font-bold" />
              <p className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-2 text-center">Confirmation email</p>
            </div>
          )}
        </div>

        <div className="flex-1 bg-white p-6 flex flex-col overflow-hidden">
          <div className="flex justify-between items-center mb-4 border-b border-gray-50 pb-3">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-300">Audit Memo5D</h3>
            {currentSession && (currentSession.transcript.length > 0 || currentSession.isFinished) && <button onClick={copyTranscript} className="text-[10px] text-blue-500 font-bold uppercase hover:underline">Copier Transcript</button>}
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1 custom-scrollbar text-[14px] leading-relaxed text-gray-700">
            {errorMsg && <div className="bg-red-50 text-red-600 p-4 rounded-3xl text-xs font-medium text-center mb-4 border border-red-100">{errorMsg}</div>}
            <div className="space-y-4 pb-4">
              {currentSession?.transcript.map((entry, i) => <div key={i} className="animate-in fade-in slide-in-from-bottom-1"><span className="font-bold text-gray-900">{entry.role === 'Agent' ? 'Amai :' : 'Interviewé :'}</span> {entry.text}</div>)}
              {currentOutputText && <div className="text-gray-400 italic"><span className="font-bold text-gray-500 not-italic">Amai :</span> {currentOutputText}...</div>}
              {currentInputText && <div className="text-blue-400"><span className="font-bold text-blue-500">Interviewé :</span> {currentInputText}</div>}
            </div>
          </div>
        </div>

        {currentSession && !currentSession.isFinished && (
          <div className="px-8 py-6 bg-white border-t border-gray-50">
            <div className="flex justify-between text-[10px] font-black text-gray-300 uppercase mb-3"><span>Progression</span><span className="text-blue-500">{stageInfo.index} / 5</span></div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 transition-all duration-1000" style={{ width: `${(stageInfo.index / 5) * 100}%` }} /></div>
            <div className="mt-2 text-[10px] font-bold text-gray-400 italic text-center">{stageInfo.label}</div>
          </div>
        )}
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-[110] bg-black/30 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-xs bg-white h-full shadow-2xl p-8 flex flex-col animate-slide-in">
            <div className="flex justify-between items-center mb-10"><h2 className="text-xl font-black uppercase">SESSIONS <span className="text-blue-500">AMAI</span></h2><button onClick={() => setShowHistory(false)} className="text-gray-400 text-xl">✕</button></div>
            <div className="flex-1 overflow-y-auto space-y-4">
              {sessions.map(s => (
                <div key={s.id} onClick={() => { setCurrentSessionId(s.id); setShowHistory(false); }} className={`p-5 rounded-3xl border transition-all cursor-pointer hover:border-blue-300 ${s.id === currentSessionId ? 'border-blue-500 bg-blue-50/50' : 'border-gray-100'}`}>
                  <span className="text-[10px] font-black text-gray-300 uppercase">{new Date(s.createdAt).toLocaleDateString()}</span>
                  <p className="text-xs font-bold text-gray-700 truncate">{s.auditData['e-mail répondant'] || 'Anonyme'}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <style>{`.custom-scrollbar::-webkit-scrollbar{width:5px}.custom-scrollbar::-webkit-scrollbar-thumb{background:#E5E7EB;border-radius:10px}@keyframes slide-in{from{transform:translateX(100%)}to{transform:translateX(0)}}.animate-slide-in{animation:slide-in .4s cubic-bezier(0.16,1,0.3,1)}@keyframes orb-rotate{from{transform:rotate(0deg) scale(1.4)}to{transform:rotate(360deg) scale(1.4)}}.animate-orb-rotate{animation:orb-rotate 12s linear infinite}`}</style>
    </div>
  );
};

export default App;