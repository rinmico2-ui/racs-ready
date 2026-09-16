"use strict";

function normalizeChatText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeChatText(text) {
  return normalizeChatText(text).split(" ").filter((word) => word.length > 1);
}

function levenshtein(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const rows = a.length + 1;
  const columns = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));
  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = a[row - 1] === b[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitution,
      );
    }
  }
  return matrix[a.length][b.length];
}

function fuzzyMatch(word, target) {
  if (word === target) return 1;
  // Short Filipino words such as "si" and "po" must never match fragments
  // inside unrelated catalog words such as "expensive" or "portable".
  if (word.length < 4 || target.length < 4) return 0;
  if (target.includes(word) || word.includes(target)) return 0.85;
  const distance = levenshtein(word, target);
  if (distance === 1) return 0.8;
  if (distance === 2 && Math.max(word.length, target.length) >= 6) return 0.65;
  return 0;
}

function stem(word) {
  return String(word || "")
    .replace(/ings?$/, "")
    .replace(/ed$/, "")
    .replace(/ment$/, "")
    .replace(/tion$/, "")
    .replace(/ness$/, "")
    .replace(/ly$/, "")
    .replace(/er$/, "")
    .replace(/es$/, "")
    .replace(/s$/, "")
    .toLowerCase();
}

function includesPhrase(normalizedText, phrase) {
  const normalizedPhrase = normalizeChatText(phrase);
  if (!normalizedPhrase) return false;
  return (` ${normalizedText} `).includes(` ${normalizedPhrase} `);
}

const INTENTS = {
  introduction: {
    patterns: [
      /^(?:ako(?:\s+po)?\s+si|pangalan\s+ko(?:\s+po)?(?:\s+ay|\s+si)?|my\s+name\s+is|i\s+am|i'm|im)\s+[\p{L}][\p{L}' -]{0,39}[.!?]*$/iu,
    ],
    keywords: [],
  },
  greeting: {
    patterns: [/^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy|yo|sup|kumusta|musta)\b/i],
    keywords: ["hi", "hello", "hey", "greetings", "good morning", "good afternoon", "good evening", "kumusta", "musta"],
  },
  farewell: {
    patterns: [/^(bye|goodbye|see you|talk later|farewell|good night|ingat|paalam)\b/i],
    keywords: ["bye", "goodbye", "see you", "farewell", "good night", "ingat", "paalam"],
  },
  thanks: {
    patterns: [/^(thank|thanks|salamat|appreciate|helpful|great|awesome|nice)\b/i],
    keywords: ["thank", "thanks", "salamat", "appreciate", "helpful", "great"],
  },
  yes: {
    patterns: [/^(yes|yeah|yep|sure|okay|ok|oo|opo|sige)(?:\b|$)/i],
    keywords: [],
  },
  no: {
    patterns: [/^(no|nope|not now|hindi|ayaw|wala|wala\s+na|wala\s+naman|none|nothing|cancel)\b/i],
    keywords: [],
  },
  products: {
    patterns: [
      /\b(aircon|air con|air conditioner|ac unit|split type|window type|portable)\b/i,
      /\b(product|catalog|models?|brands?)\b/i,
      /\b(buy|purchase|order|shop|available)\b.*\b(unit|aircon|ac)\b/i,
    ],
    keywords: ["aircon", "air conditioner", "ac", "unit", "split", "window", "portable", "product", "catalog", "model", "brand", "buy", "purchase", "order", "shop", "inverter", "non-inverter"],
  },
  pricing: {
    patterns: [
      /\b(how much|price|cost|magkano|rate|presyo|budget|affordable|cheap|expensive)\b/i,
      /\b(fee|charge|payment|gcash|cash|installment|bayad)\b/i,
      /\b(sa presyo|presyo ng|magkano ang|magkano ang|halaga|gastos)\b/i,
    ],
    keywords: [
      "price", "cost", "how much", "magkano", "presyo", "rate", "budget", "affordable",
      "cheap", "expensive", "payment", "gcash", "cash", "installment", "bayad",
      "halaga", "gastos", "presyo ng", "magkano ang",
    ],
  },
  services: {
    patterns: [
      /\b(install|repair|maintenance|cleaning|fix|technician|service)\b/i,
      /\b(pagkukumpuni|paglilinis|pagkakabit|technician|serbisyo)\b/i,
      /\b(appliances?|refrigerators?|fridges?|freezers?|washing machines?|washers?|dryers?|microwaves?|rice cookers?|electric fans?|water dispensers?|electric kettles?)\b/i,
      /\b(ref|fridge|refrigerator|washing|microwave|turbobroiler|electric fan|aircon|ac)\b/i,
    ],
    keywords: [
      "install", "repair", "maintenance", "cleaning", "fix", "technician", "service",
      "appliance", "refrigerator", "fridge", "ref", "freezer", "washing machine", "washer",
      "dryer", "microwave", "rice cooker", "electric fan", "water dispenser", "electric kettle",
      "turbobroiler", "aircon", "ac",
      "pagkukumpuni", "paglilinis", "pagkakabit", "serbisyo",
    ],
  },
  booking: {
    patterns: [/\b(book|schedule|appointment|reservation|calendar|reschedule)\b/i, /\b(pag-book|pag-schedule|reserve|booking)\b/i],
    keywords: ["book", "schedule", "appointment", "reservation", "calendar", "reschedule"],
  },
  warranty: {
    patterns: [/\b(warranty|guarantee|coverage|claim)\b/i],
    keywords: ["warranty", "guarantee", "coverage", "claim"],
  },
  delivery: {
    patterns: [/\b(delivery|deliver|shipping|pickup|padeliver)\b/i],
    keywords: ["delivery", "deliver", "shipping", "pickup", "padeliver"],
  },
  troubleshooting: {
    patterns: [
      /\b(not working|broken|problem|issue|error|noise|leak|water|smoke|burn|smell)\b/i,
      /\b(hindi gumagana|di gumagana|sira|problema|ingay|tubig|usok|amoy|nasisira|nabutas|nagloloko|nagana|masira|nadale|nasira|wasak)\b/i,
      /\b(gumagana|gumagamit|nagana|sira|ayaw|nawala|naputol|nabutas|nadumi|nabulok|naglalabas|nagtatapilok)\b/i,
    ],
    keywords: [
      "not working", "broken", "problem", "issue", "noise", "leak", "water", "smoke", "burn", "smell",
      "hindi gumagana", "di gumagana", "sira", "problema", "ingay",
      "ayaw gumana", "ayaw gumamit", "nasisira", "nagloloko", "nadale", "nasira", "wasak",
      "nabutas", "nadumi", "nabulok", "naputol", "nawala", "naglalabas", "nagtatapilok",
    ],
  },
  emergency: {
    patterns: [/\b(emergency|urgent|asap|immediately|right now|sagip|agad)\b/i],
    keywords: ["emergency", "urgent", "asap", "immediately", "right now", "sagip", "agad"],
  },
  contact: {
    patterns: [/\b(contact|phone|telephone|mobile|hotline|email|address|location|where are you)\b/i],
    keywords: ["contact", "phone", "telephone", "mobile", "hotline", "email", "address", "location"],
  },
  comparison: {
    patterns: [/\b(compare|difference|versus|vs\.?|better|which|recommend|suggest|best)\b/i],
    keywords: ["compare", "difference", "vs", "versus", "better", "which", "recommend", "best"],
  },
  specs: {
    patterns: [/\b(spec|specification|btu|hp|horsepower|tonnage|capacity|size|room)\b/i, /\b(sq\.?m|square meter|room size|what size|right size)\b/i],
    keywords: ["spec", "specification", "btu", "hp", "horsepower", "tonnage", "capacity", "size", "room", "sqm", "square meter"],
  },
  maintenance_tips: {
    patterns: [/\b(maintenance tips?|clean filter|care tips?|preventive maintenance)\b/i],
    keywords: ["maintenance tip", "clean filter", "care tip", "preventive maintenance"],
  },
  amc: {
    patterns: [/\b(amc|annual maintenance contract|maintenance plan)\b/i],
    keywords: ["amc", "annual maintenance contract", "maintenance plan"],
  },
};

function detectIntent(text) {
  const normalized = normalizeChatText(text);
  const words = tokenizeChatText(text);
  const scores = {};

  for (const [intent, config] of Object.entries(INTENTS)) {
    let score = 0;
    for (const pattern of config.patterns) {
      if (pattern.test(String(text || ""))) score += 4;
    }
    for (const keyword of config.keywords) {
      const normalizedKeyword = normalizeChatText(keyword);
      if (includesPhrase(normalized, normalizedKeyword)) {
        score += 3;
        continue;
      }
      if (normalizedKeyword.includes(" ")) continue;
      for (const word of words) {
        const match = fuzzyMatch(word, normalizedKeyword);
        if (match >= 0.8) score += match * 1.5;
      }
    }
    const stems = words.filter((word) => word.length >= 4).map(stem);
    for (const keyword of config.keywords) {
      const keywordStem = stem(normalizeChatText(keyword));
      if (keywordStem.length >= 4 && stems.includes(keywordStem)) score += 0.75;
    }
    if (score >= 2) scores[intent] = score;
  }

  const sorted = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  return sorted.length ? sorted[0] : ["unknown", 0];
}

function extractIntroducedName(text) {
  const value = String(text || "").trim();
  const match = value.match(/^(?:ako(?:\s+po)?\s+si|pangalan\s+ko(?:\s+po)?(?:\s+ay|\s+si)?|my\s+name\s+is|i\s+am|i'm|im)\s+([\p{L}][\p{L}' -]{0,39}?)[.!?]*$/iu);
  if (!match) return "";
  return match[1]
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .slice(0, 4)
    .map((part) => part.charAt(0).toLocaleUpperCase("en-PH") + part.slice(1).toLocaleLowerCase("en-PH"))
    .join(" ");
}

module.exports = {
  detectIntent,
  extractIntroducedName,
  normalizeChatText,
  tokenizeChatText,
};
