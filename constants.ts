import { Question, QuestionType } from './types';

export const SOURCE_TAG = "Form-AMAI-GAIS-251017";

export const QUESTIONS: Question[] = [
  {
    id: 'q01',
    label: "Comment décririez-vous la stratégie IA actuelle de votre entreprise ? Votre stratégie actuelle est-elle en phase d'exploration, plutôt en cours de mise en oeuvre ou entièrement intégrée et déployée  ? ",
    type: QuestionType.SELECT,
    notionKey: "Maturité – Stratégie",
    options: [
      "Pas de stratégie définie nous explorons simplement.",
      "Nous avons une stratégie de base pour des projets spécifiques mais non étendue à toute l'entreprise",
      "Nous avons une stratégie IA claire à l'échelle de l'entreprise en cours d'implémentation.",
      "Notre stratégie IA est entièrement intégrée à notre stratégie commerciale et stimule l'innovation."
    ]
  },
  {
    id: 'q02',
    label: "Comment décririez-vous l'état de l'infrastructure des données de votre entreprise ? Vos données sont plutôt bien structurées ou encore dispersées et difficilement exploitables ?",
    type: QuestionType.SELECT,
    notionKey: "Maturité – Données-Infrastructure",
    options: [
      "Les données sont cloisonnées et inaccessibles",
      "Nous commençons à centraliser les données mais c'est un travail en cours",
      "Nous disposons d'une plateforme de données centralisée et bien gérée",
      "Nos données sont un atout stratégique - disponibles pour modèles IA - gouvernance solide"
    ]
  },
  {
    id: 'q03',
    label: "Comment évaluez-vous les compétences en IA, Numérique ou digital au sein de vos équipes ?",
    type: QuestionType.SELECT,
    notionKey: "Maturité – Compétences",
    options: [
      "Très faibles. Nous avons peu ou pas d'expertise en interne.",
      "Basiques. Quelques membres de l'équipe ont des connaissances mais ce n'est pas généralisé.",
      "Modérées. Nous avons des équipes ou individus dédiés avec de solides compétences IA-Numérique",
      "Élevées. Expertise en IA-Numérique répandue et encouragée activement - culture d'apprentissage"
    ]
  },
  {
    id: 'q04',
    label: "Quelle est l'approche de l'entreprise pour adopter de nouvelles technologies comme l'IA ? Vous avez une approche plutôt attentiste, de test à petite échelle ou très proctive ? ",
    type: QuestionType.SELECT,
    notionKey: "Maturité – Adoption techno",
    options: [
      "Nous sommes très averses au risque et lents à adopter les nouvelles technologies.",
      "Nous expérimentons les nouvelles technologies à petite échelle et de manière informelle.",
      "Nous avons un processus formel pour piloter et adopter les nouvelles technologies.",
      "Notre R&D est très active en technologies de pointe. Objectif: obtenir un avantage concurrentiel"
    ]
  },
  {
    id: 'q05',
    label: "Comment les projets d'IA sont-ils gouvernés et priorisés dans votre organisation ?",
    type: QuestionType.SELECT,
    notionKey: "Maturité – Gouvernance",
    options: [
      "Il n'y a pas de processus formel de gouvernance ou de priorisation.",
      "Les projets sont menés par des départements individuels avec peu de supervision centrale.",
      "Nous avons un comité interfonctionnel qui examine et priorise les initiatives d'IA.",
      "Nous avons une gouvernance IA solide intégrant ROI mesurable éthique et stratégie"
    ]
  },
  {
    id: 'q06',
    label: "Quelle est votre position dans l'entreprise ?",
    type: QuestionType.SELECT,
    notionKey: "Statut Répondant - Position",
    options: [
      "Dirigeant / cadre dirigeant / visionnaire décisionnaire",
      "Responsable opérationnel (cadre dirigeant opérationnel)",
      "Collaborateur / expert technique",
      "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Statut Répondant – Autre"
  },
  {
    id: 'q07',
    label: "Dans quel service ou département travaillez-vous ?",
    type: QuestionType.SELECT,
    notionKey: "Service-dépt Rep",
    options: [
      "Direction Générale",
      "Direction Financière / Comptable",
      "Direction Commerciale / Ventes",
      "Direction Marketing / Communication",
      "Direction Produit / Innovation",
      "Direction des Opérations / Logistique",
      "Direction des Ressources Humaines",
      "Direction Informatique / Systèmes d'Information",
      "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Service-dépt Rep Autre"
  },
  {
    id: 'q08',
    label: "Quel est l'intitulé exact de votre poste ?",
    type: QuestionType.SELECT,
    notionKey: "Intitulé poste Rep",
    options: [
      "Président / CEO / Directeur Général",
      "Directeur Financier (CFO)",
      "Directeur des Opérations (COO)",
      "Directeur Technique / CTO / DSI",
      "Directeur Marketing / CMO",
      "Directeur Commercial / Responsable des Ventes",
      "Responsable Produit / Chef de Produit",
      "Responsable Logistique / Supply Chain",
      "Responsable des Ressources Humaines",
      "Responsable ADV / Administration des Ventes",
      "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Intitulé poste Rep-Autre"
  },
  {
    id: 'q09',
    label: "Quel est le secteur d'activité principal de votre entreprise ?",
    type: QuestionType.SELECT,
    notionKey: "Secteur activité",
    options: [
      "Agriculture-sylviculture-pêche", "Industries extractives", "Industrie manufacturière",
      "Production-distribution énergie", "Production-distribution eau-gestion déchets",
      "Construction", "Commerce réparation automobiles-moto", "Transports-entreposage",
      "Hébergement-restauration", "Information-communication", "Finance-banque-assurance",
      "Immobilier", "Science-technique", "Service administratif-soutien",
      "Administration publique", "Enseignement", "Santé-action sociale",
      "Art-spectacle-activité_récréative", "Autres activités de services", "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Secteur activité-Autre"
  },
  {
    id: 'q10',
    label: "Quel est le sous-secteur niche principal ?",
    type: QuestionType.SELECT,
    notionKey: "Sous-secteur niche",
    options: [
      "Agro-alimentaire", "Santé/Biotech", "Industrie Automobile", "Conseil Stratégique",
      "Aéronautique", "IT/SaaS", "Finance/Assurance", "Énergie", "Éducation", "Retail / E-commerce", "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Sous-secteur-Autre"
  },
  {
    id: 'q11',
    label: "Quel est l'effectif total de votre entreprise ?",
    type: QuestionType.SELECT,
    notionKey: "Nbr employés",
    options: ["<50", "50-250", "250-500", "500-1000", ">1000"]
  },
  {
    id: 'q12',
    label: "Quelle est votre tranche de chiffre d'affaires ?",
    type: QuestionType.SELECT,
    notionKey: "CA",
    options: ["<1 M€", "1-5 M€", "5-20 M€", "20-50 M€", ">50 M€"]
  },
  {
    id: 'q13',
    label: "Quel type d'offres proposez-vous ? Plutôt des Produits physiques, des Services ou un mix des deux ?",
    type: QuestionType.SELECT,
    notionKey: "Type offres",
    options: ["Produits physiques", "Services", "Produits + services", "Solutions sur-mesure / projets", "Autre"],
    triggerAutre: "Autre",
    autreKey: "Type offres-Autre"
  },
  {
    id: 'q14',
    label: "Pour vos offres, ciblez-vous plutôt le BtoB, les entreprises ou le BtoC, les personnes privées, ou les deux ?",
    type: QuestionType.SELECT,
    notionKey: "BtoB-BtoC",
    options: ["BtoB", "BtoC", "BtoB + BtoC"]
  },
  {
    id: 'q15',
    label: "Combien d'entités sont concernées par cet audit ?",
    type: QuestionType.SELECT,
    notionKey: "Nbr Entités",
    options: ["1: entité principale", "2: entité principale + 1 filiale", "3: entité principale + 2 filiales", "4 ou plus", "Autre"],
    triggerAutre: "Autre",
    autreKey: "Nbr Entités-Autre"
  },
  {
    id: 'q16',
    label: "Sur quel marché géographique intervenez-vous ?",
    type: QuestionType.SELECT,
    notionKey: "Marché desservi",
    options: ["Local / Régional", "National", "International", "Autre"],
    triggerAutre: "Autre",
    autreKey: "Marché desservi – Autre"
  },
  {
    id: 'q17',
    label: "Quels sont vos objectifs principaux en matière d'IA et numérique ?",
    type: QuestionType.MULTI_SELECT,
    notionKey: "Objectifs IA-Digital",
    maxItems: 7,
    options: [
      "Concevoir une application interne d’optimisation du cycle de vente.",
      "Mettre en place un tableau de bord automatisé pour piloter la performance.",
      "Créer un assistant IA pour automatiser les tâches administratives.",
      "Développer une solution de recommandation personnalisée (produits ou contenus).",
      "Automatiser la détection d’anomalies dans les données ou la production.",
      "Optimiser la maintenance prédictive des équipements.",
      "Assistance à la stratégie de l'entreprise : commercial",
      "Assistance à la stratégie de l'entreprise : innovation",
      "Assistance à la stratégie de l'entreprise : finance-fiscalité",
      "Assistance à la stratégie de l'entreprise : management",
      "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Objectifs IA-Digital-Autre"
  },
  {
    id: 'q18',
    label: "Quels sont vos principaux défis ?",
    type: QuestionType.MULTI_SELECT,
    notionKey: "Défis prioritaires (max 3)",
    maxItems: 3,
    options: [
      "Définir ou actualiser la stratégie IA et Data",
      "Automatiser des processus internes / améliorer la productivité",
      "Améliorer la croissance commerciale / différenciation concurrentielle",
      "Mieux exploiter / valoriser les données (data management)",
      "Optimiser la marge et les coûts",
      "Renforcer la satisfaction client et l’expérience utilisateur",
      "Gouvernance et conformité (RGPD AI Act éthique)",
      "Recruter et développer les compétences IA/numériques",
      "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Défis – Autre"
  },
  {
    id: 'q19',
    label: "Quelles sont vos attentes vis-à-vis de l'IA et du Digital ?",
    type: QuestionType.MULTI_SELECT,
    notionKey: "Attentes IA-Digital",
    maxItems: 5,
    options: [
      "Obtenir une proposition de valeur actualisée grâce à l’IA",
      "Bénéficier d’une approche stratégique et d’une feuille de route",
      "Mettre en place une approche opérationnelle (automatisation process)",
      "Gagner en productivité / gagner du temps",
      "Restaurer ou augmenter les marges",
      "Autre"
    ],
    triggerAutre: "Autre",
    autreKey: "Attentes IA-Digital-Autre"
  },
  {
    id: 'q20',
    label: "Quel est votre e-mail professionnel ?",
    type: QuestionType.STRING,
    notionKey: "e-mail répondant"
  },
  {
    id: 'q21',
    label: "Acceptez-vous que Memo5D conserve ces données conformément aux CGU et à la politique RGPD ?",
    type: QuestionType.BOOL,
    notionKey: "Consentement RGPD (Oui/Non)"
  }
];
/**
 * Fallbacks métiers pour les questions SANS option "Autre".
 * - Clé = notionKey
 * - Valeur = libellé EXACT d'une option existante
 *
 * Optionnel: si non renseigné pour une question, le code prendra la 1ère option disponible.
 */
export const NORMALIZATION_FALLBACKS_BY_NOTION_KEY: Record<string, string> = {};
