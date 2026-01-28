import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { QUESTIONS, SOURCE_TAG } from './constants';
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

  const normalizeAuditData = async (transcript: { role: string; text: string }[], rawData: AuditData, signal?: AbortSignal) => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API Key missing");
    
    const ai = new GoogleGenAI({ apiKey });
    const questionsContext = QUESTIONS.map(q => ({
      property: q.notionKey,
      label: q.label,
      options: q.options || [],
      type: q.type,
      autreKey: q.autreKey
    }));

    const prompt = `Tu es un expert en normalisation de données de haute précision (déterminisme absolu). Ta mission est de convertir le transcript d'un audit vocal et ses données brutes en un JSON strictement valide pour Notion.

CONTEXTE :
Transcript : ${JSON.stringify(transcript)}
Données brutes de l'agent : ${JSON.stringify(rawData)}

RÈGLES DE MAPPING (CRITIQUE) :
1. MAPPING SÉMANTIQUE : Si l'utilisateur a utilisé une périphrase ou une réponse libre (ex: "on teste un peu"), tu DOIS choisir l'option la plus proche sémantiquement dans la liste autorisée (ex: "Nous expérimentons les nouvelles technologies à petite échelle et de manière informelle.").
2. FIDÉLITÉ ABSOLUE : Pour chaque champ de type 'select' ou 'array', tu DOIS retourner la valeur EXACTE (caractères, ponctuation, espaces) telle qu'elle apparaît dans la liste des options fournie.
3. INTERDICTION DE RÉSUMER : Ne reformule jamais une option de la liste. Fais un COPIER-COLLER exact.
4. LOGIQUE 'AUTRE' : Utilise l'option "Autre" UNIQUEMENT si aucune option sémantique ne correspond vraiment. Dans ce cas, remplis obligatoirement le champ associé (-Autre) avec la réponse libre reformulée.
5. NOM ET PRENOM : Identifie le nom de l'utilisateur dans le transcript pour "'Nom soumission'".
6. MULTI-SELECT : Pour les types 'array', retourne un tableau de chaînes (les libellés exacts).
7. CONSENTEMENT RGPD (BOOL) : Pour les propriétés de type 'bool', analyse le consentement dans le transcript. Si l'utilisateur exprime son accord (ex: 'Oui', 'D'accord', 'J'accepte'), la valeur DOIT être le booléen true. Sinon false.

PROPRIÉTÉS ET OPTIONS AUTORISÉES :
${JSON.stringify(questionsContext, null, 2)}

Retourne UNIQUEMENT le JSON final. SANS AUCUN FORMATAGE MARKDOWN.`;

    try {
      // Intégration du timeout de 45s pour l'IA
      const aiPromise = ai.models.generateContent({
        model: FLASH_MODEL,
        contents: [{ parts: [{ text: prompt }] }],
        config: { 
          responseMimeType: "application/json",
          temperature: 0 
        }
      });

      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout IA (45s) dépassé")), 45000);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error("Aborted")); });
      });

      const response: any = await Promise.race([aiPromise, timeoutPromise]);

      let text = response.text || "{}";
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const normalized = JSON.parse(text);

      if (!normalized || Object.keys(normalized).length === 0) {
        throw new Error("Empty normalization result");
      }
      
      return {
        ...normalized,
        session_id: currentSessionIdRef.current,
        source: SOURCE_TAG,
        "'Date soumission'": normalized["'Date soumission'"] || new Date().toISOString(),
        executionMode: "production_normalized"
      };
    } catch (e) {
      console.error("Critical normalization error:", e);
      throw e; 
    }
  };

  const submitToWebhook = async (rawData: AuditData, retryCount = 0) => {
    setSubmissionStatus('submitting');
    setErrorMsg(null);
    
    // Détection immédiate de l'environnement pour éviter le gel du proxy 404
    const isVercelEnvironment = window.location.hostname.endsWith('vercel.app');
    const endpoint = isVercelEnvironment ? API_SUBMIT_ENDPOINT : DIRECT_WEBHOOK_URL;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // Global timeout 45s

    try {
      const currentSess = sessionsRef.current.find(s => s.id === currentSessionIdRef.current);
      const transcript = currentSess?.transcript || [];
      
      // La normalisation respecte aussi le timeout
      const payload = await normalizeAuditData(transcript, rawData, controller.signal);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(payload)
      });

      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      setSubmissionStatus('success');
    } catch (error: any) {
      clearTimeout(timeoutId);
      console.error(`Attempt ${retryCount + 1} failed:`, error);
      
      if (retryCount < 1 && error.name !== 'AbortError') {
        return submitToWebhook(rawData, retryCount + 1);
      }

      setErrorMsg(error.name === 'AbortError' ? "Le délai de transmission a été dépassé (45s)." : "La normalisation des données a échoué. Veuillez contacter le support.");
      setSubmissionStatus('error');
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

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const currentQ = QUESTIONS[sessionToUse.currentStep] || QUESTIONS[0];

      const systemInstruction = `Tu es AMAI, consultant senior Memo5D. Ta mission est de réaliser un audit de maturité IA et Digital.

RÈGLES DE VOIX :
- Adopte une voix grave, calme, posée mais dynamique. 
- Maintiens une assurance sereine et une tessiture basse.

RÈGLES DE FLUX ET SÉQUENÇAGE (CRITIQUES) :
1. VERROU DE PONCTUATION : Une seule question par intervention.
2. VERROU D'ÉVÉNEMENT : Attends [EVENT: RECORD_SUCCESS] pour valider la réponse et passer à la suivante.
3. PAS DE RÉFÉRENCE TECHNIQUE : Ne prononce jamais de noms d'outils ou d'IDs de questions.

CONSIGNES DE DIALOGUE :
- Réponds oralement aux demandes de précision sans appeler record_answer.
- Sois naturel mais reste sur les options prévues pour Notion.

RÈGLES d'OR :
1. INTRODUCTION : "Bonjour, Bienvenue, heureux de vous accompagner pour votre audit de maturité IA et digital de votre entreprise, en tant qu'agent IA Amai, consultant senior pour Memo5D. Pour commencer..." puis pose la première question.
2. EMAIL (q20) : Indique que l'email peut être vérifié sous l'avatar.
3. FIN d'AUDIT : Remercie et invite sur memo5D.fr.

LISTE DES QUESTIONS :
${QUESTIONS.map(q => `- ${q.id}: "${q.label}"`).join('\n')}`;

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
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } } },
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