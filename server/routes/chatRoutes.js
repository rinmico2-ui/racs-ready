const express = require("express");
const router = express.Router();
const HVACProduct = require("../models/HVACProduct");
const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");
const SiteSetting = require("../models/SiteSetting");

// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENT AI ENGINE — Gemini-powered with local fallback
// ═══════════════════════════════════════════════════════════════════════════

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// OpenRouter (free-tier LLMs, no credit card required) — primary provider
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── Dynamic Knowledge Cache ───────────────────────────────────────────────
let kb = null;
let kbTimestamp = 0;
const KB_TTL = 60 * 1000;

async function loadKnowledge() {
  const now = Date.now();
  if (kb && now - kbTimestamp < KB_TTL) return kb;

    try {
      const [products, coreServices, repairServices, settings] = await Promise.all([
        HVACProduct.find({ status: { $ne: "discontinued" } })
          .select("modelLine brand type category inverter variants")
          .lean(),
        CoreService.find({ active: { $ne: false } })
          .select("name slug category description basePrice priceRange hpPricing airconTypes durationMinutes features")
          .lean(),
        RepairService.find({ active: { $ne: false } })
          .select("name slug category description price priceRange hpPricing airconTypes estimatedDurationMinutes features")
          .lean(),
        SiteSetting.find({ key: { $in: ["farePerKm", "airconInstallFee"] } })
          .select("key value").lean(),
      ]);

      const s = {};
      settings.forEach((x) => (s[x.key] = x.value));

      const mapCore = (svc) => ({
        name: svc.name,
        slug: svc.slug,
        category: svc.category,
        desc: svc.description,
        price: svc.basePrice,
        priceRange: svc.priceRange,
        hpPricing: (svc.hpPricing || []).map((h) => ({ hp: h.hp, price: h.price, duration: h.durationMinutes })),
        types: (svc.airconTypes || []).map((t) => ({
          type: t.type, name: t.name,
          hpPricing: (t.hpPricing || []).map((h) => ({ hp: h.hp, price: h.price })),
        })),
        duration: svc.durationMinutes,
        features: svc.features || [],
      });

      const mapRepair = (svc) => ({
        name: svc.name,
        slug: svc.slug,
        category: svc.category,
        desc: svc.description,
        price: svc.price,
        priceRange: svc.priceRange,
        hpPricing: (svc.hpPricing || []).map((h) => ({ hp: h.hp, price: h.price })),
        types: (svc.airconTypes || []).map((t) => t.type),
        duration: svc.estimatedDurationMinutes,
        features: svc.features || [],
      });

      kb = {
        products: products.map((p) => ({
          model: p.modelLine, brand: p.brand, type: p.type,
          category: p.category, inverter: p.inverter,
          hpOptions: (p.variants || []).map((v) => ({
            hp: v.capacity, btu: v.btu, price: v.sellingPrice, stock: v.quantity,
          })),
          minPrice: Math.min(...(p.variants || []).map((v) => v.sellingPrice || Infinity).filter(Boolean)),
          maxPrice: Math.max(...(p.variants || []).map((v) => v.sellingPrice || 0).filter(Boolean)),
        })),
        services: [...coreServices.map(mapCore), ...repairServices.map(mapRepair)],
        installFee: s.airconInstallFee || 1500,
        farePerKm: s.farePerKm || 15,
      };
      kbTimestamp = now;
      console.log("[Chat] Knowledge loaded:", kb.products.length, "products,", kb.services.length, "services");
    } catch (err) {
      console.error("[Chat] KB load error:", err.message);
      kb = kb || { products: [], services: [], installFee: 1500, farePerKm: 15 };
    }
    return kb;
}

// ─── Knowledge Base to Context String ──────────────────────────────────────
function knowledgeToContext(k) {
  let ctx = "=== RACS COMPANY INFORMATION ===\n\n";

  // Company basics
  ctx += "Company: RACS (Reliable Air Conditioning Services)\n";
  ctx += "Hotline: +63 917 888 9999\n";
  ctx += "Email: info@racs.com\n";
  ctx += "Website: www.racs.com\n";
  ctx += "Hours: Mon-Sat 8:00 AM - 6:00 PM\n";
  ctx += "Emergency: 24/7 available\n\n";

  // Products
  if (k.products.length > 0) {
    ctx += "=== AVAILABLE AIRCON PRODUCTS ===\n";
    for (const p of k.products) {
      const inverter = p.inverter ? "Inverter" : "Non-Inverter";
      const hpList = p.hpOptions.map((h) => `${h.hp}HP`).join(", ");
      const price = p.minPrice && p.maxPrice
        ? (p.minPrice === p.maxPrice ? `₱${p.minPrice.toLocaleString()}` : `₱${p.minPrice.toLocaleString()} - ₱${p.maxPrice.toLocaleString()}`)
        : "Contact for price";
      ctx += `- ${p.brand} ${p.model} (${p.type}, ${inverter}) — HP: ${hpList || "N/A"} — Price: ${price}\n`;
    }
    ctx += "\n";
  }

  // Services
  if (k.services.length > 0) {
    ctx += "=== AVAILABLE SERVICES (live from database) ===\n";
    for (const s of k.services) {
      let price = "Varies";
      if (s.price) price = `₱${s.price.toLocaleString()}`;
      else if (s.priceRange && s.priceRange.min != null) price = `₱${s.priceRange.min.toLocaleString()}${s.priceRange.max != null && s.priceRange.max !== s.priceRange.min ? " - ₱" + s.priceRange.max.toLocaleString() : ""}`;
      else if (s.hpPricing && s.hpPricing.length) {
        const ps = s.hpPricing.map((h) => h.price).filter(Boolean);
        if (ps.length) price = `₱${Math.min(...ps).toLocaleString()}${Math.max(...ps) !== Math.min(...ps) ? " - ₱" + Math.max(...ps).toLocaleString() : ""} (HP-based)`;
      }
      const dur = s.duration ? `, Duration: ~${s.duration} min` : "";
      ctx += `- ${s.name} | Category: ${s.category} | Price: ${price}${dur}\n`;
      if (s.desc) ctx += `  Description: ${s.desc}\n`;
      if (s.features && s.features.length) ctx += `  What's included: ${s.features.join("; ")}\n`;
      if (s.hpPricing && s.hpPricing.length) {
        ctx += `  HP Pricing: ` + s.hpPricing.map((h) => `${h.hp}HP=₱${h.price.toLocaleString()}`).join(", ") + "\n";
      }
      // NOTE: internal identifiers (slug, _id, product/service codes) are intentionally excluded
    }
    ctx += "\n";
    ctx += "To book any service, customers go to the Core Service page (/core-service) or call the hotline. Always guide them to book or call when they ask about a service.\n\n";
  }

  // Pricing info
  ctx += "=== PRICING INFORMATION ===\n";
  ctx += `- Installation Fee: ₱${k.installFee.toLocaleString()}\n`;
  ctx += `- Delivery: ₱${k.farePerKm}/km from warehouse (Store Pickup is FREE)\n`;
  ctx += "- Payment Methods: GCash, COD, Bank Transfer, Credit/Debit Cards, Installment (3-12 months)\n\n";

  // Warranty
  ctx += "=== WARRANTY ===\n";
  ctx += "- Window Type: 1 year manufacturer warranty\n";
  ctx += "- Split Type Standard: 2-3 years\n";
  ctx += "- Split Type Inverter: 5 years\n";
  ctx += "- Premium Models: Up to 7 years\n";
  ctx += "- Installation Workmanship: 1 year\n";
  ctx += "- Repair Parts: 6 months\n";
  ctx += "- Service Warranty: 30 days\n\n";

  // Troubleshooting
  ctx += "=== COMMON TROUBLESHOOTING ===\n";
  ctx += "- Not cooling: Check filters, thermostat, outdoor unit. May need refrigerant recharge.\n";
  ctx += "- Water leaking: Check drain pipe, clean with vinegar, check unit angle.\n";
  ctx += "- Strange noises: Rattling (loose screws), Grinding (motor bearings), Hissing (refrigerant leak - URGENT).\n";
  ctx += "- Won't turn on: Check outlet, breaker, remote batteries, reset power.\n";
  ctx += "- Burning smell: TURN OFF IMMEDIATELY, unplug, call emergency hotline.\n\n";

  // Emergency
  ctx += "=== EMERGENCY SERVICE ===\n";
  ctx += "24/7 Emergency Hotline: +63 917 888 9999\n";
  ctx += "Response: Metro Manila 30-60 min, Provincial 2-4 hours\n";
  ctx += "Call-out fee after 6PM: ₱1,000\n\n";

  // AMC
  ctx += "=== ANNUAL MAINTENANCE CONTRACTS ===\n";
  ctx += "- Basic: ₱1,200/year (2 visits, filter cleaning, 10% repair discount)\n";
  ctx += "- Standard: ₱2,400/year (4 visits, full cleaning, 15% discount, priority scheduling)\n";
  ctx += "- Premium: ₱4,500/year (6 visits, chemical cleaning, 24/7 support, 20% discount)\n\n";

  // Room size guide
  ctx += "=== ROOM SIZE → HP GUIDE ===\n";
  ctx += "- 1.0 HP: 12-15 sqm (bedroom, small office)\n";
  ctx += "- 1.5 HP: 18-22 sqm (living room, medium bedroom)\n";
  ctx += "- 2.0 HP: 24-30 sqm (large living room, small shop)\n";
  ctx += "- 2.5 HP: 30-35 sqm (commercial space)\n";
  ctx += "- 3.0+ HP: 35+ sqm (warehouse, commercial)\n";
  ctx += "Note: Add 0.5 HP for direct sunlight, 0.5 HP for 4+ people, 1 HP extra for kitchens.\n\n";

  // Booking
  ctx += "=== HOW TO BOOK ===\n";
  ctx += "1. Visit /core-service page or click Book Now\n";
  ctx += "2. Select services, location, date/time\n";
  ctx += "3. Confirm and pay\n";
  ctx += "4. Track technician in real-time\n";
  ctx += "Or call +63 917 888 9999 for phone booking.\n";

  return ctx;
}

// ─── Gemini API Call (Non-Streaming) ───────────────────────────────────────
async function callGemini(systemPrompt, conversationHistory, userMessage) {
  if (!GEMINI_API_KEY) return null;

  const contents = buildGeminiContents(conversationHistory, userMessage);

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 1024,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error("[Chat] Gemini API error:", response.status);
      return null;
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return text || null;
  } catch (err) {
    console.error("[Chat] Gemini call failed:", err.message);
    return null;
  }
}

// ─── Gemini API Call (Streaming) ───────────────────────────────────────────
async function callGeminiStream(systemPrompt, conversationHistory, userMessage, onChunk) {
  if (!GEMINI_API_KEY) return null;

  const contents = buildGeminiContents(conversationHistory, userMessage);
  const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

  try {
    const response = await fetch(streamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 1024,
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error("[Chat] Gemini stream error:", response.status);
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              fullText += text;
              onChunk(text);
            }
          } catch (e) {}
        }
      }
    }

    return fullText;
  } catch (err) {
    console.error("[Chat] Gemini stream failed:", err.message);
    return null;
  }
}

// ─── OpenRouter API Call (Non-Streaming, OpenAI-compatible) ────────────────
async function callOpenRouter(systemPrompt, conversationHistory, userMessage) {
  if (!OPENROUTER_API_KEY) return null;

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-10).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://racs.com",
        "X-Title": "RACS AI Chatbot",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
        stream: false,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      console.error("[Chat] OpenRouter API error:", response.status);
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return text || null;
  } catch (err) {
    console.error("[Chat] OpenRouter call failed:", err.message);
    return null;
  }
}

// ─── OpenRouter API Call (Streaming) ───────────────────────────────────────
async function callOpenRouterStream(systemPrompt, conversationHistory, userMessage, onChunk) {
  if (!OPENROUTER_API_KEY) return null;

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-10).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://racs.com",
        "X-Title": "RACS AI Chatbot",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 1024,
        stream: true,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error("[Chat] OpenRouter stream error:", response.status);
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.choices?.[0]?.delta?.content;
          if (text) {
            fullText += text;
            onChunk(text);
          }
        } catch (e) {}
      }
    }
    return fullText || null;
  } catch (err) {
    console.error("[Chat] OpenRouter stream failed:", err.message);
    return null;
  }
}

// ─── Build Gemini Contents Array ───────────────────────────────────────────
function buildGeminiContents(conversationHistory, userMessage) {
  const contents = [];
  const recentHistory = conversationHistory.slice(-10);

  for (const msg of recentHistory) {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    });
  }

  contents.push({ role: "user", parts: [{ text: userMessage }] });
  return contents;
}

// ─── System Prompt Builder ─────────────────────────────────────────────────
function buildSystemPrompt(knowledgeContext, session) {
  const hour = new Date().getHours();
  let timeOfDay = "day";
  if (hour < 12) timeOfDay = "morning";
  else if (hour < 17) timeOfDay = "afternoon";
  else timeOfDay = "evening";

  const conversationSummary = session.topicsDiscussed.length > 0
    ? `Topics discussed so far: ${session.topicsDiscussed.join(", ")}.`
    : "This is the start of the conversation.";

  const prompt = `You are RACS AI, an intelligent, conversational AI assistant created by RACS (Reliable Air Conditioning Services), an HVAC company in the Philippines. You are NOT just a customer service bot — you are a knowledgeable, helpful AI that can discuss a wide range of topics while being an expert on HVAC, air conditioning, and RACS services.

## CORE IDENTITY
- You are RACS AI — think of yourself as a friendly, smart Filipino professional
- You speak naturally, like a real person having a conversation
- You can answer ANY question the user asks — general knowledge, math, science, history, cooking, travel, health tips, technology, etc.
- You are NOT limited to HVAC topics. You are a general-purpose AI assistant with specialized HVAC expertise
- Use "Po" occasionally (every few messages) for Filipino cultural respect, but don't overdo it
- Mix English and Tagalog naturally (Taglish) when appropriate
- You have personality — be warm, witty when appropriate, and genuinely helpful

## INTELLIGENCE & REASONING
- Think step by step before answering complex questions
- Provide nuanced, thoughtful answers — not just surface-level responses
- If a question is ambiguous, ask clarifying questions before answering
- You can do math, explain science concepts, give life advice, discuss current events, help with homework, explain programming, etc.
- When you don't know something specific (like exact RACS pricing not in your knowledge base), be honest and offer alternatives
- You can make logical inferences and connect ideas across different topics
- Recognize when someone is joking or being casual — respond in kind

## HVAC EXPERTISE (Your Specialty)
When discussing air conditioning, you are THE expert:
- Explain technical concepts in simple terms anyone can understand
- Help customers choose the right unit for their needs and budget
- Provide accurate troubleshooting steps
- Compare brands, models, and technologies (inverter vs non-inverter, split vs window, etc.)
- Explain energy efficiency, BTU calculations, and room size matching
- Give honest recommendations — not just the most expensive option
- You know Philippine climate conditions and how they affect AC choices

## GUIDING CUSTOMERS (Important)
When a customer asks about a service, product, price, or how to get help, your job is to GUIDE them to the next step — not just inform. Specifically:
- If they ask about a service or want to book: tell them what the service includes and PRICE, then guide them to book via the **Core Service page (/core-service)** or call **+63 917 888 9999**.
- If they ask about a product: show matching models + prices, then offer to help them choose the right HP for their room size or direct them to book/contact.
- If they ask to track a booking or check status: tell them to open **My Schedule (/tracking)** to see live technician tracking, and that they'll get real-time updates there.
- If they have an issue/problem: give a quick self-check, and if it needs a pro, guide them to book a repair or call the hotline.
- Always end service/product/booking answers with a clear next step (book, call, or visit a page).
- Keep guidance concise — one clear call-to-action per answer.

## CONVERSATION STYLE
- Be conversational and natural — avoid robotic, template-like responses
- Use varied sentence structures — not every message needs to be a list
- Ask follow-up questions to keep the conversation flowing
- Remember what the user told you earlier in the conversation and reference it
- Be concise for simple questions, thorough for complex ones
- Use humor when appropriate (but keep it professional)
- Format responses with markdown for readability: **bold**, bullet points, headers for long answers

## EMOTIONAL INTELLIGENCE
- Detect the user's mood and adjust your tone accordingly
- If someone is frustrated, be empathetic and solution-focused
- If someone is happy, match their energy
- If someone seems confused, simplify your explanation
- Never be condescending — always be patient and helpful

## KNOWLEDGE BASE
${knowledgeContext}

## CONVERSATION CONTEXT
${conversationSummary}
Turn number: ${session.turnCount}
Current time: Good ${timeOfDay}!

## RULES
1. Always be helpful and try your best to answer any question
2. For RACS-specific info (prices, services, products, availability), ONLY use what's in the KNOWLEDGE BASE above — this data is pulled live from the company database, so it is the source of truth. Do NOT invent prices, services, or policies.
3. For general knowledge questions, use your training knowledge freely
4. If the knowledge base doesn't contain a specific detail the customer asks for, say you're not certain and offer to connect them to the hotline (+63 917 888 9999)
5. Never make up RACS-specific information — but you CAN provide general HVAC knowledge
6. For off-topic questions (unrelated to HVAC), answer them naturally and then optionally mention you can also help with air conditioning
7. Keep responses natural in length — don't over-explain simple things
8. When answering about services or bookings, include a clear next-step (book via /core-service, track via /tracking, or call the hotline)`;

  return prompt;
}

// ─── Text Utilities ────────────────────────────────────────────────────────
function normalize(text) {
  return text.toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalize(text).split(" ").filter((w) => w.length > 1);
}

// Levenshtein distance for typo tolerance
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function fuzzyMatch(word, target) {
  if (word === target) return 1;
  if (target.includes(word) || word.includes(target)) return 0.85;
  const dist = levenshtein(word, target);
  const maxLen = Math.max(word.length, target.length);
  if (maxLen <= 3) return dist <= 1 ? 0.7 : 0;
  if (dist <= 1) return 0.8;
  if (dist <= 2 && maxLen >= 5) return 0.6;
  return 0;
}

// Stemming
function stem(word) {
  return word
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

// ─── Intent Detection (for fallback and suggestion chips) ──────────────────
const INTENTS = {
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
      /\b(price|cost|fee|charge|payment|gcash|cash|installment)\b/i,
    ],
    keywords: ["price", "cost", "how much", "magkano", "presyo", "rate", "budget", "affordable", "cheap", "expensive", "payment", "gcash", "cash", "installment", "bayad"],
  },
  services: {
    patterns: [
      /\b(install|repair|maintenance|cleaning|fix|technician|service)\b/i,
      /\b(pagkukumpuni|paglilinis|pagkakabit|technician|serbisyo)\b/i,
    ],
    keywords: ["install", "repair", "maintenance", "cleaning", "fix", "technician", "service", "pagkukumpuni", "paglilinis", "pagkakabit", "serbisyo"],
  },
  booking: {
    patterns: [
      /\b(book|schedule|appointment|reservation|when|available|calendar)\b/i,
      /\b(pag-book|pag-schedule|appointment|reserve|booking)\b/i,
    ],
    keywords: ["book", "schedule", "appointment", "reservation", "when", "available", "calendar", "reschedule"],
  },
  troubleshooting: {
    patterns: [
      /\b(not working|broken|problem|issue|error|noise|leak|water|smoke|burn|smell)\b/i,
      /\b(hindi gumagana|sira|problema|ingay|tubos|usok|amoy)\b/i,
    ],
    keywords: ["not working", "broken", "problem", "issue", "noise", "leak", "water", "smoke", "burn", "smell", "hindi gumagana", "sira", "problema"],
  },
  emergency: {
    patterns: [
      /\b(emergency|urgent|asap|immediately|right now|help|sagip|agad)\b/i,
    ],
    keywords: ["emergency", "urgent", "asap", "immediately", "right now", "help", "sagip", "agad"],
  },
  comparison: {
    patterns: [
      /\b(compare|difference|versus|vs\.?|better|which|recommend|suggest|best)\b/i,
    ],
    keywords: ["compare", "difference", "vs", "versus", "better", "which", "recommend", "best"],
  },
  specs: {
    patterns: [
      /\b(spec|specification|btu|hp|horsepower|tonnage|capacity|size|room)\b/i,
      /\b(sq\.?m|square meter|room size|what size|right size)\b/i,
    ],
    keywords: ["spec", "specification", "btu", "hp", "horsepower", "tonnage", "capacity", "size", "room", "sqm", "square meter"],
  },
};

function detectIntent(text) {
  const normalized = normalize(text);
  const words = tokenize(text);
  const scores = {};

  for (const [intent, config] of Object.entries(INTENTS)) {
    let score = 0;
    for (const pat of config.patterns) {
      if (pat.test(text)) score += 3;
    }
    for (const kw of config.keywords) {
      const kwLower = kw.toLowerCase();
      if (normalized.includes(kwLower)) {
        score += 2;
        continue;
      }
      for (const w of words) {
        const fm = fuzzyMatch(w, kwLower);
        if (fm > 0.6) score += fm * 1.5;
      }
    }
    const stems = words.map(stem);
    for (const kw of config.keywords) {
      const kwStem = stem(kw);
      if (stems.some((s) => s === kwStem || kwStem.includes(s) || s.includes(kwStem))) {
        score += 1;
      }
    }
    if (score > 0) scores[intent] = score;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0] : ["unknown", 0];
}

// ─── Sentiment Detection ───────────────────────────────────────────────────
function detectSentiment(text) {
  const lower = text.toLowerCase();
  if (/angry|frustrat|terrible|awful|useless|stupid|incompetent|hate|putang|gago|tang|bob|ulol/i.test(lower)) return "angry";
  if (/sad|disappoint|unhappy|worried|concerned|nabigo|lungkot/i.test(lower)) return "sad";
  if (/happy|great|awesome|love|amazing|excellent|ganda|galing|sulit/i.test(lower)) return "happy";
  return "neutral";
}

// ─── Context Tracker ───────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function getSession(id) {
  if (!id) return null;
  let s = sessions.get(id);
  if (!s || Date.now() - s.lastActive > SESSION_TTL) {
    s = {
      history: [],
      lastIntent: null,
      intentCount: {},
      topicsDiscussed: [],
      turnCount: 0,
      sentiment: "neutral",
      lastProduct: null,
      lastService: null,
      lastActive: Date.now(),
    };
    sessions.set(id, s);
  }
  s.lastActive = Date.now();
  return s;
}

// Cleanup old sessions every 10 min
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) {
    if (s.lastActive < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

// ─── Suggestion Chips ──────────────────────────────────────────────────────
function getSuggests(intent) {
  const suggestMap = {
    greeting: ["Products", "Services", "Book a Service", "Track Booking"],
    farewell: ["Products", "Services", "Emergency"],
    thanks: ["Products", "Services", "Book a Service", "Contact"],
    products: ["Pricing", "Specs", "Comparison", "Book a Service"],
    pricing: ["Products", "Services", "Book a Service", "Warranty"],
    services: ["Book a Service", "Pricing", "Emergency", "Maintenance Tips"],
    booking: ["Services", "Products", "Pricing", "Track Booking"],
    warranty: ["Contact", "Products", "Services", "Emergency"],
    delivery: ["Pricing", "Products", "Contact"],
    troubleshooting: ["Book a Service", "Emergency", "Maintenance Tips", "Services"],
    emergency: ["Contact", "Services", "Troubleshooting"],
    contact: ["Products", "Services", "Book a Service", "Emergency"],
    specs: ["Products", "Comparison", "Book a Service", "Pricing"],
    comparison: ["Products", "Pricing", "Book a Service", "Specs"],
    maintenance_tips: ["Services", "AMC", "Book a Service", "Products"],
    amc: ["Services", "Pricing", "Book a Service", "Contact"],
  };
  return suggestMap[intent] || ["Products", "Services", "Booking", "Contact"];
}

// ─── Fallback Response (when Gemini fails) ─────────────────────────────────
function buildFallbackResponse(text, session) {
  const suggestions = [
    "I'm not quite sure what you mean, but I'm here to help! Try asking about:\n\n• **Products** — Available aircon models\n• **Pricing** — How much things cost\n• **Services** — Installation, repair, maintenance\n• **Booking** — Schedule a service\n• **Troubleshooting** — Fix AC problems\n\nOr call us at **+63 917 888 9999** for direct assistance.",

    "I want to make sure I help you correctly! Here are some things I can assist with:\n\n• What aircon products do you have?\n• How much is installation?\n• I need my AC repaired\n• Book a service appointment\n• AC troubleshooting help\n\nWhat would you like to know?",

    "I didn't quite catch that. Let me know if you need help with:\n\n• **Products & Pricing**\n• **Service Booking**\n• **Repair & Maintenance**\n• **Warranty Info**\n• **Emergency Service**\n\nOr call **+63 917 888 9999** to speak with a person.",
  ];

  return suggestions[Math.floor(Math.random() * suggestions.length)];
}

// ─── Main Response Generator ───────────────────────────────────────────────
async function generateResponse(text, session, knowledge) {
  const [intent, score] = detectIntent(text);
  const sentiment = detectSentiment(text);

  // Update session
  session.turnCount++;
  session.sentiment = sentiment;
  session.lastIntent = intent;
  session.intentCount[intent] = (session.intentCount[intent] || 0) + 1;
  session.lastMessage = text;

  if (!session.topicsDiscussed.includes(intent)) {
    session.topicsDiscussed.push(intent);
  }

  // Handle frustration — always escalate to human
  if (sentiment === "angry") {
    return {
      text: "I completely understand your frustration, and I'm truly sorry about this experience. Your concern is important to us.\n\nLet me connect you with someone who can help right away:\n\n📞 **Hotline:** +63 917 888 9999\n📧 **Email:** info@racs.com\n\nWe'll make this right as quickly as possible.",
      suggests: ["Call Hotline", "Email Support"],
      intent: "escalation",
    };
  }

  // Handle yes/no with context
  if (intent === "yes" && session.lastIntent) {
    const prev = session.lastIntent;
    const contextResponses = {
      products: () => buildProductResponse(knowledge, text, session),
      services: () => buildServiceResponse(knowledge, text, session),
      booking: () => buildBookingResponse(knowledge, session),
      pricing: () => buildPricingResponse(knowledge, text, session),
      warranty: () => buildWarrantyResponse(session),
      troubleshooting: () => buildTroubleshootingResponse(text, session),
      specs: () => buildSpecsResponse(knowledge, text, session),
    };
    const builder = contextResponses[prev];
    if (builder) {
      return { text: builder(), suggests: getSuggests(prev), intent };
    }
    return { text: "Sure! I'd be happy to continue. What would you like to know more about?", suggests: getSuggests(prev), intent };
  }

  if (intent === "no") {
    const noResponses = [
      "No problem at all! Is there anything else I can help you with?",
      "Sure thing! Just let me know if you need anything else.",
      "Alright! I'm here whenever you need me.",
    ];
    return {
      text: noResponses[Math.floor(Math.random() * noResponses.length)],
      suggests: ["Products", "Services", "Booking", "Contact"],
      intent,
    };
  }

  // Try OpenRouter AI first (free, intelligent), then Gemini, then local
  try {
    const knowledgeContext = knowledgeToContext(knowledge);
    const systemPrompt = buildSystemPrompt(knowledgeContext, session);
    const orReply = await callOpenRouter(systemPrompt, session.history, text);
    if (orReply) {
      return { text: orReply, suggests: getSuggests(intent), intent };
    }
  } catch (e) {
    console.log("[Chat] OpenRouter unavailable:", e.message);
  }

  try {
    const knowledgeContext = knowledgeToContext(knowledge);
    const systemPrompt = buildSystemPrompt(knowledgeContext, session);
    const geminiReply = await callGemini(systemPrompt, session.history, text);
    if (geminiReply) {
      return { text: geminiReply, suggests: getSuggests(intent), intent };
    }
  } catch (e) {
    console.log("[Chat] Gemini unavailable:", e.message);
  }

  // Local intelligent response
  console.log("[Chat] Using local AI — intent:", intent, "score:", score);
  let response;

  switch (intent) {
    case "greeting":
      response = buildGreetingResponse(session);
      break;
    case "farewell":
      response = buildFarewellResponse(session);
      break;
    case "thanks":
      response = buildThanksResponse(session);
      break;
    case "products":
      response = buildProductResponse(knowledge, text, session);
      break;
    case "pricing":
      response = buildPricingResponse(knowledge, text, session);
      break;
    case "services":
      response = buildServiceResponse(knowledge, text, session);
      break;
    case "booking":
      response = buildBookingResponse(knowledge, session);
      break;
    case "warranty":
      response = buildWarrantyResponse(session);
      break;
    case "delivery":
      response = buildDeliveryResponse(session);
      break;
    case "troubleshooting":
      response = buildTroubleshootingResponse(text, session);
      break;
    case "emergency":
      response = buildEmergencyResponse(session);
      break;
    case "contact":
      response = buildContactResponse(session);
      break;
    case "specs":
      response = buildSpecsResponse(knowledge, text, session);
      break;
    case "comparison":
      response = buildComparisonResponse(knowledge, text, session);
      break;
    case "maintenance_tips":
      response = buildMaintenanceTipsResponse(session);
      break;
    case "amc":
      response = buildAMCResponse(session);
      break;
    default:
      response = buildIntelligentFallback(text, session, knowledge);
  }

  return { text: response, suggests: getSuggests(intent), intent };
}

// ─── Greeting ──────────────────────────────────────────────────────────────
function buildGreetingResponse(session) {
  const hour = new Date().getHours();
  let timeGreeting = "Hello";
  if (hour < 12) timeGreeting = "Good morning";
  else if (hour < 17) timeGreeting = "Good afternoon";
  else timeGreeting = "Good evening";

  const greetings = [
    `${timeGreeting}! Welcome to RACS. I'm your AI assistant — I can help with aircon products, services, troubleshooting, booking, or even general questions. What can I do for you?`,
    `${timeGreeting}! Great to have you here. Whether you need help choosing an AC, scheduling a repair, or just have a question — I'm ready to assist. What's on your mind?`,
    `Hey there! ${timeGreeting}! I'm RACS AI — think of me as your personal HVAC expert, but I can also chat about almost anything. What brings you here today?`,
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
}

// ─── Farewell ──────────────────────────────────────────────────────────────
function buildFarewellResponse(session) {
  const farewells = [
    "It was great chatting with you! Stay cool, and don't hesitate to come back anytime you need help. Take care!",
    "Goodbye! Thanks for talking with me. Remember, we're here 24/7 if you ever need HVAC help or just want to chat. Ingat!",
    "See you later! Hope I was helpful today. Feel free to reach out anytime — whether it's about AC or anything else. Stay well!",
  ];
  return farewells[Math.floor(Math.random() * farewells.length)];
}

// ─── Thanks ────────────────────────────────────────────────────────────────
function buildThanksResponse(session) {
  const thanks = [
    "You're welcome! Happy I could help. Is there anything else you'd like to know?",
    "Glad I could assist! Don't hesitate to ask if anything else comes up.",
    "My pleasure! I'm always here if you need anything — whether it's HVAC or just a question.",
  ];
  return thanks[Math.floor(Math.random() * thanks.length)];
}

// ─── Products ──────────────────────────────────────────────────────────────
function buildProductResponse(knowledge, text, session) {
  if (knowledge.products.length === 0) {
    return "Our product catalog is currently being updated. For the latest models and prices, please call **+63 917 888 9999** or visit our showroom. I can still help with general AC advice in the meantime!";
  }

  const lower = text.toLowerCase();

  // Check for specific brand queries
  const brands = ["carrier", "daikin", "panasonic", "lg", "samsung", "fujitsu", "kolin", "condura", "whirlpool", "haier", "electrolux", "sharp", "tcl", "midea"];
  const mentionedBrand = brands.find(b => lower.includes(b));

  // Check for specific type queries
  const typeQuery = lower.includes("split") ? "split" : lower.includes("window") ? "window" : lower.includes("portable") ? "portable" : null;

  // Check for inverter query
  const inverterQuery = lower.includes("inverter");

  let filtered = knowledge.products;
  if (mentionedBrand) filtered = filtered.filter(p => p.brand && p.brand.toLowerCase().includes(mentionedBrand));
  if (typeQuery) filtered = filtered.filter(p => p.type && p.type.includes(typeQuery));
  if (inverterQuery) filtered = filtered.filter(p => p.inverter);

  if (filtered.length === 0) {
    return `I don't see any ${mentionedBrand || typeQuery || "matching"} units in our current inventory. Let me show you what we do have available.`;
  }

  let response = `Here's what we have${mentionedBrand ? ` from **${mentionedBrand.charAt(0).toUpperCase() + mentionedBrand.slice(1)}**` : ""}${typeQuery ? ` (${typeQuery} type)` : ""}${inverterQuery ? " (inverter)" : ""}:\n\n`;

  // Group by type
  const byType = {};
  for (const p of filtered) {
    const t = p.type || "other";
    if (!byType[t]) byType[t] = [];
    byType[t].push(p);
  }

  const typeNames = {
    split: "Split Type", window_inverter: "Window Inverter",
    window_non_inverter: "Window Non-Inverter", floor_mounted: "Floor Mounted",
    split_ceiling: "Split Ceiling", portable: "Portable",
  };

  for (const [type, products] of Object.entries(byType).slice(0, 3)) {
    const typeName = typeNames[type] || type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    response += `**${typeName}:**\n`;
    for (const p of products.slice(0, 4)) {
      const inv = p.inverter ? " ⚡" : "";
      const hpList = p.hpOptions.map(h => `${h.hp}HP`).join(", ");
      const price = p.minPrice && p.maxPrice
        ? (p.minPrice === p.maxPrice ? `₱${p.minPrice.toLocaleString()}` : `₱${p.minPrice.toLocaleString()} – ₱${p.maxPrice.toLocaleString()}`)
        : "Contact for price";
      response += `• **${p.brand || ""} ${p.model}**${inv} — ${hpList || "N/A"} — ${price}\n`;
    }
    response += "\n";
  }

  response += `That's ${filtered.length} unit${filtered.length > 1 ? "s" : ""} matching your criteria. Would you like details on a specific model, or help choosing the right HP for your room size?`;

  session.lastProduct = filtered[0];
  return response;
}

// ─── Pricing ───────────────────────────────────────────────────────────────
function buildPricingResponse(knowledge, text, session) {
  const lower = text.toLowerCase();
  let response = "";
  let hasSpecific = false;

  // Product pricing
  if (lower.includes("product") || lower.includes("aircon") || lower.includes("unit") || lower.includes("how much")) {
    hasSpecific = true;
    response += "**Aircon Product Prices:**\n";
    if (knowledge.products.length > 0) {
      const byType = {};
      for (const p of knowledge.products) {
        const t = p.type || "other";
        if (!byType[t]) byType[t] = { min: Infinity, max: 0 };
        if (p.minPrice < byType[t].min) byType[t].min = p.minPrice;
        if (p.maxPrice > byType[t].max) byType[t].max = p.maxPrice;
      }
      const typeNames = { split: "Split Type", window_inverter: "Window Inverter", window_non_inverter: "Window", floor_mounted: "Floor Mounted" };
      for (const [type, range] of Object.entries(byType)) {
        const name = typeNames[type] || type.replace(/_/g, " ");
        response += `• **${name}:** ₱${range.min.toLocaleString()} – ₱${range.max.toLocaleString()}\n`;
      }
    } else {
      response += "• Contact hotline for latest prices\n";
    }
    response += "\n";
  }

  // Service pricing
  if (lower.includes("service") || lower.includes("install") || lower.includes("repair") || lower.includes("cleaning") || lower.includes("maintenance")) {
    hasSpecific = true;
    response += "**Service Pricing:**\n";
    response += `• Installation: **₱${knowledge.installFee.toLocaleString()}**\n`;
    for (const s of knowledge.services.slice(0, 8)) {
      response += `• ${s.name}: **${formatServicePrice(s)}**\n`;
    }
    response += "\n";
  }

  // Delivery
  if (lower.includes("delivery") || lower.includes("shipping") || lower.includes("padeliver")) {
    hasSpecific = true;
    response += `**Delivery:** ₱${knowledge.farePerKm}/km from our warehouse\n• Store Pickup: **FREE**\n\n`;
  }

  // Payment
  if (lower.includes("payment") || lower.includes("gcash") || lower.includes("cash") || lower.includes("installment") || lower.includes("bayad")) {
    hasSpecific = true;
    response += "**Payment Methods:**\n• GCash\n• Cash on Delivery\n• Bank Transfer\n• Credit/Debit Cards\n• Installment plans (3–12 months)\n\n";
  }

  if (!hasSpecific) {
    response = "**Here's a quick pricing overview:**\n\n";
    response += `• Installation: **₱${knowledge.installFee.toLocaleString()}**\n`;
    response += `• Delivery: **₱${knowledge.farePerKm}/km** (Store Pickup: FREE)\n`;
    response += "• Payment: GCash, COD, Bank Transfer, Cards, Installment\n\n";

    if (knowledge.products.length > 0) {
      const minProd = Math.min(...knowledge.products.map(p => p.minPrice).filter(Boolean));
      const maxProd = Math.max(...knowledge.products.map(p => p.maxPrice).filter(Boolean));
      if (minProd && maxProd) {
        response += `• Aircon units: **₱${minProd.toLocaleString()}${maxProd !== minProd ? " – ₱" + maxProd.toLocaleString() : ""}**\n\n`;
      }
    }

    response += "Want to know the price of a specific product or service? Just ask!";
  } else {
    response += "Would you like to know about anything else?";
  }

  return response;
}

// ─── Services ──────────────────────────────────────────────────────────────
function formatServicePrice(s) {
  if (s.price) return `₱${s.price.toLocaleString()}`;
  if (s.priceRange && s.priceRange.min != null) {
    const min = s.priceRange.min, max = s.priceRange.max;
    return `₱${min.toLocaleString()}${max != null && max !== min ? " – ₱" + max.toLocaleString() : ""}`;
  }
  if (s.hpPricing && s.hpPricing.length) {
    const ps = s.hpPricing.map((h) => h.price).filter(Boolean);
    if (ps.length) return `₱${Math.min(...ps).toLocaleString()}${Math.max(...ps) !== Math.min(...ps) ? " – ₱" + Math.max(...ps).toLocaleString() : ""}`;
  }
  return "Varies";
}

function buildServiceResponse(knowledge, text, session) {
  const lower = text.toLowerCase();
  let response = "";

  const serviceTypes = {
    install: ["install", "pagkakabit", "installation"],
    repair: ["repair", "fix", "pagkukumpuni", "sira", "broken"],
    maintenance: ["maintenance", "cleaning", "paglilinis", "clean", "chem wash"],
  };

  let specificType = null;
  for (const [type, keywords] of Object.entries(serviceTypes)) {
    if (keywords.some((k) => lower.includes(k))) {
      specificType = type;
      break;
    }
  }

  if (knowledge.services.length > 0) {
    // Try to find a specifically mentioned service by name
    const mentioned = knowledge.services.find(
      (s) => s.name && lower.includes(s.name.toLowerCase())
    );

    if (mentioned) {
      response += `**${mentioned.name}**\n\n`;
      if (mentioned.desc) response += `${mentioned.desc}\n\n`;
      response += `**Price:** ${formatServicePrice(mentioned)}\n`;
      if (mentioned.duration) response += `**Estimated Duration:** ~${mentioned.duration} minutes\n`;
      if (mentioned.features && mentioned.features.length) {
        response += `\n**What's included:**\n`;
        for (const f of mentioned.features) response += `• ${f}\n`;
      }
      if (mentioned.hpPricing && mentioned.hpPricing.length) {
        response += `\n**HP-based Pricing:**\n`;
        for (const h of mentioned.hpPricing) response += `• ${h.hp}HP: ₱${h.price.toLocaleString()}\n`;
      }
      response += `\nWould you like to **book this service**? I can guide you to our booking page or you can call **+63 917 888 9999**.`;
      return response;
    }

    const byCategory = {};
    for (const s of knowledge.services) {
      const cat = s.category || "other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(s);
    }

    const targetCat = specificType || (Object.keys(byCategory)[0]);
    const catServices = byCategory[specificType] || byCategory[targetCat] || [];
    const catName = (specificType || targetCat || "our").replace(/_/g, " ");

    if (catServices.length > 0) {
      response += `**${catName.charAt(0).toUpperCase() + catName.slice(1)} Services:**\n\n`;
      for (const s of catServices.slice(0, 6)) {
        const price = formatServicePrice(s);
        const dur = s.duration ? ` (~${s.duration} min)` : "";
        response += `• **${s.name}**${dur} — ${price}\n`;
        if (s.desc) response += `  ${s.desc.substring(0, 110)}${s.desc.length > 110 ? "..." : ""}\n`;
        if (s.features && s.features.length) response += `  Includes: ${s.features.slice(0, 3).join(", ")}${s.features.length > 3 ? "…" : ""}\n`;
      }
      response += "\n";
    } else {
      // Fallback: list everything
      for (const [cat, services] of Object.entries(byCategory).slice(0, 3)) {
        const name = cat.charAt(0).toUpperCase() + cat.slice(1);
        response += `**${name} Services:**\n`;
        for (const s of services.slice(0, 4)) {
          response += `• **${s.name}** — ${formatServicePrice(s)}\n`;
        }
        response += "\n";
      }
    }
  } else {
    response += "**Our HVAC Services:**\n\n";
    response += "• **Installation** — Professional AC setup\n";
    response += "• **Repair** — Expert diagnostics and fixes\n";
    response += "• **Maintenance** — Preventive care and cleaning\n";
    response += "• **Chemical Wash** — Deep coil cleaning\n";
    response += "• **Emergency** — 24/7 urgent service\n\n";
  }

  response += "We also offer **24/7 Emergency Service**. Would you like to **book a service**? You can visit our Core Service page or call **+63 917 888 9999** — I can guide you through it!";
  return response;
}

// ─── Booking ───────────────────────────────────────────────────────────────
function buildBookingResponse(knowledge, session) {
  return `**Booking a service is easy!** Here's how it works:\n\n**Step 1 — Choose your service**\nPick from Installation, Repair, Maintenance, or Cleaning\n\n**Step 2 — Select a schedule**\nPick your preferred date and time — our system finds the best available technician\n\n**Step 3 — Provide your location**\nEnter your address for accurate pricing and routing\n\n**Step 4 — Confirm & track**\nGet instant confirmation and **track your technician live** on service day via **My Schedule (/tracking)**\n\n**Ready to book?**\n• Visit our **Core Service page (/core-service)** and click "Book Now"\n• Or call **+63 917 888 9999** for phone booking\n\nWould you like me to walk you through the booking process, or do you have questions about a specific service?`;
}

// ─── Warranty ──────────────────────────────────────────────────────────────
function buildWarrantyResponse(session) {
  return `**Warranty Coverage:**\n\n**Product Warranties:**\n• Window Type: 1 year manufacturer warranty\n• Split Type Standard: 2–3 years\n• Split Type Inverter: 5 years\n• Premium Models: Up to 7 years\n\n**Service Warranties:**\n• Installation: 1 year workmanship\n• Repair Parts: 6 months\n• Maintenance: 30 days\n\n**Extended Warranty Options:**\n• 2-Year Extended: ₱1,500–₱3,000\n• 5-Year Comprehensive: ₱4,000–₱7,000\n\n**Claims Process:**\n1. Call our hotline or visit a branch\n2. Present proof of purchase + warranty card\n3. Technician inspection within 48 hours\n\nNeed help with a warranty claim? Call **+63 917 888 9999**.`;
}

// ─── Delivery ──────────────────────────────────────────────────────────────
function buildDeliveryResponse(session) {
  return `**Delivery Options:**\n\n• **Standard**: 2–3 business days\n• **Express**: Next business day\n• **Same-Day**: Order before 12PM\n• **Weekend**: Saturday available\n• **Store Pickup**: FREE\n\n**Service Areas:**\n• Metro Manila: Same-day & next-day\n• Provincial Luzon: 2–4 days\n• Visayas & Mindanao: 3–5 days\n\n**Tracking:**\nReal-time GPS tracking available for all deliveries. You'll receive SMS and email updates.\n\n**Return Policy:**\n• 7-day return for defective units\n• 30-day exchange for manufacturing defects\n\nWant to track your order or schedule a delivery?`;
}

// ─── Troubleshooting ──────────────────────────────────────────────────────
function buildTroubleshootingResponse(text, session) {
  const lower = text.toLowerCase();

  if (/not cool|hilaw|malamig|hindi lumalamig|mainit|hot|warm|warm air/i.test(lower)) {
    return `**AC Not Cooling — Let's diagnose this:**\n\n**Quick checks you can do right now:**\n1. **Check the thermostat** — Make sure it's set to cooling mode and the temperature is lower than room temp\n2. **Clean the air filters** — Remove them, wash with mild soap, dry completely before putting back\n3. **Inspect the outdoor unit** — Remove any leaves, dirt, or obstructions blocking airflow\n4. **Check the vents** — Make sure all vents are open and unblocked\n5. **Listen for the compressor** — If you hear it running but no cold air, it might need refrigerant\n\n**Common causes:**\n• Dirty filters (most common — causes 80% of cooling issues)\n• Low refrigerant level\n• Faulty compressor\n• Blocked condenser coils\n\nIf these steps don't help, it's time for a professional check. We offer **free diagnosis** with any service booking.\n\n📞 Call **+63 917 888 9999** or visit our booking page to schedule a technician.`;
  }

  if (/leak|tubig|water|drip|tulo|dripping/i.test(lower)) {
    return `**Water Leaking — Here's what to check:**\n\n**Immediate steps:**\n1. **Check the drain pipe** — Look for kinks, blockages, or disconnections\n2. **Clean the drain line** — Pour a vinegar solution (1:1 vinegar and water) through it\n3. **Check unit angle** — The indoor unit should tilt slightly backward (indoor side higher)\n4. **Clean the drain pan** — Remove dirt and algae buildup\n5. **Check the evaporator coils** — Ice buildup that melts can cause dripping\n\n**⚠️ If leaking is heavy or electrical components are wet:** Turn off the unit immediately and unplug it. Water and electricity don't mix.\n\n**When to call us:** If the drain line is cracked, the pan is damaged, or you see water near electrical parts — that needs professional attention.\n\n📞 **+63 917 888 9999** — We can fix this quickly!`;
  }

  if (/noise|ingay|loud|grinding|rattling|hissing|banging|bukas|kalampag/i.test(lower)) {
    return `**Strange Noises — Here's what they usually mean:**\n\n• **Rattling** → Loose screws or parts inside the unit. Tighten what you can see.\n• **Grinding** → Motor bearings are wearing out. Needs lubrication or replacement.\n• **Hissing** → Possible refrigerant leak. This needs immediate professional attention.\n• **Banging** → Compressor or fan blade issue. Turn off and call us.\n• **Clicking** → Electrical component problem — could be a relay or capacitor.\n• **Squealing** → Fan belt or motor issue.\n\n**⚠️ Important:** Hissing and banging sounds need immediate attention — they can indicate serious issues.\n\n📞 **Emergency: +63 917 888 9999**\nWe have 24/7 emergency response for urgent noise issues.`;
  }

  if (/not turn|ayaw|start|power|sindi|won't start|dead|wala/i.test(lower)) {
    return `**AC Won't Turn On — Let's troubleshoot:**\n\n**Step-by-step check:**\n1. **Test the outlet** — Plug something else in to see if it's working\n2. **Check the breaker** — Look for a tripped circuit breaker in your panel\n3. **Check the remote** — Replace batteries and point it directly at the unit\n4. **Reset the unit** — Unplug for 5 minutes, then plug back in\n5. **Check the mode** — Make sure it's in cooling mode, not fan-only\n6. **Inspect the power cord** — Look for damage or loose connections\n\n**If the display is completely dead:**\n• Check if the outlet has power\n• Check the circuit breaker\n• The power supply board may need replacement\n\n📞 If none of these work: **+63 917 888 9999**\nWe offer free diagnosis for all service bookings.`;
  }

  if (/smell|amoy|burn|usok|smoke|funny smell|odor/i.test(lower)) {
    return `**⚠️ Burning Smell or Smoke — ACT NOW:**\n\n1. **TURN OFF the unit immediately**\n2. **Unplug from the power source**\n3. **Do NOT use water** on electrical components\n4. **Open windows** for ventilation\n5. **Evacuate** if the smell is strong or you see smoke\n6. **Call for emergency service**\n\nThis could be an electrical short circuit, motor burnout, or wiring issue — all of which are fire hazards.\n\n🚨 **EMERGENCY HOTLINE: +63 917 888 9999**\nWe have 24/7 emergency response for safety-related issues.`;
  }

  return `**Common AC Issues & Quick Fixes:**\n\n**Not Cooling?** → Clean filters, check thermostat, clear outdoor unit\n**Leaking?** → Check drain pipe, clean with vinegar\n**Noisy?** → Tighten loose parts, check fan motor\n**Won't Turn On?** → Check power, breaker, remote batteries\n**Bad Smell?** → Clean filters, check drain pan\n\nTell me more about what's happening and I can give you more specific advice!\n\n📞 **Need professional help?** Call **+63 917 888 9999** or book a service visit — free diagnosis included!`;
}

// ─── Emergency ─────────────────────────────────────────────────────────────
function buildEmergencyResponse(session) {
  return `**🚨 EMERGENCY SERVICE — Available 24/7**\n\n**Hotline: +63 917 888 9999**\n\n**What counts as an emergency:**\n• Complete system failure during extreme heat\n• Burning smell or smoke\n• Major water leakage near electrical outlets\n• Electrical issues (tripping breakers, sparks)\n• Refrigerant leak (hissing sound from outdoor unit)\n• Strange smells (gas, burning plastic)\n\n**Response Time:**\n• Metro Manila: 30–60 minutes\n• Provincial: 2–4 hours\n\n**Emergency Pricing:**\n• Call-out fee after 6PM: ₱1,000\n• Weekend/Holiday: ₱800 additional\n• Diagnostic: ₱500 (waived if you proceed with repair)\n\n**⚠️ Safety First:**\n1. Turn off the unit\n2. Unplug if safe to do so\n3. Evacuate if you smell gas or see smoke\n4. Call us immediately\n\n📞 **Call now: +63 917 888 9999**`;
}

// ─── Contact ───────────────────────────────────────────────────────────────
function buildContactResponse(session) {
  return `**Contact Information:**\n\n**📞 Phone:**\n• Customer Hotline: +63 2 1234 5678\n• Emergency Hotline: +63 917 888 9999\n\n**📧 Email:** info@racs.com\n\n**📍 Showrooms:**\n• **Makati**: 123 HVAC Street, Makati City\n• **Quezon City**: 456 Cooling Avenue, QC\n• **Alabang**: 789 Aircon Road, Muntinlupa\n• **Cebu**: 321 Breeze Street, Cebu City\n\n**🕐 Hours:** Mon–Sat 8:00 AM – 6:00 PM\n**🌐 Website:** www.racs.com\n\nNeed directions to a specific branch?`;
}

// ─── Specs ─────────────────────────────────────────────────────────────────
function buildSpecsResponse(knowledge, text, session) {
  const lower = text.toLowerCase();

  if (/room|size|sqm|square|how big|what size|right size|ano.*size/i.test(lower)) {
    // Try to extract a number from the message
    const numMatch = lower.match(/(\d+)\s*(sqm|sq\.?m|square|sqm|sqm)/);
    const roomSize = numMatch ? parseInt(numMatch[1]) : null;

    let response = `**Room Size → HP Recommendation:**\n\n`;
    response += `• **1.0 HP** → 12–15 sqm (bedroom, small office)\n`;
    response += `• **1.5 HP** → 18–22 sqm (living room, medium bedroom)\n`;
    response += `• **2.0 HP** → 24–30 sqm (large living room, small shop)\n`;
    response += `• **2.5 HP** → 30–35 sqm (commercial space, large room)\n`;
    response += `• **3.0+ HP** → 35+ sqm (warehouse, commercial)\n\n`;

    if (roomSize) {
      let recommended;
      if (roomSize <= 15) recommended = "1.0 HP";
      else if (roomSize <= 22) recommended = "1.5 HP";
      else if (roomSize <= 30) recommended = "2.0 HP";
      else if (roomSize <= 35) recommended = "2.5 HP";
      else recommended = "3.0+ HP";

      response += `For a **${roomSize} sqm** room, I'd recommend a **${recommended}** unit.\n\n`;
    }

    response += `**Tips:**\n• Add 0.5 HP for rooms with direct sunlight\n• Add 0.5 HP for rooms with 4+ people regularly\n• For kitchens, add 1 HP extra\n\nTell me your room size and I can recommend the perfect unit from our catalog!`;
    return response;
  }

  let response = "**Technical Specifications Guide:**\n\n";
  response += "**Capacity (HP → BTU):**\n• 1.0 HP ≈ 12,000 BTU\n• 1.5 HP ≈ 18,000 BTU\n• 2.0 HP ≈ 24,000 BTU\n• 2.5 HP ≈ 30,000 BTU\n\n";
  response += "**Inverter vs Non-Inverter:**\n• **Inverter**: 40–60% energy savings, quieter, longer lifespan (10–15 years)\n• **Non-Inverter**: Lower upfront cost, good for occasional use (5–10 years)\n\n";
  response += "**Energy Rating:**\n• Higher SEER/EER = more efficient\n• Inverter units typically have SEER 15–18\n\n";
  response += "Need help choosing? Tell me your **room size** and **budget**, and I'll recommend the best option!";
  return response;
}

// ─── Comparison ────────────────────────────────────────────────────────────
function buildComparisonResponse(knowledge, text, session) {
  const lower = text.toLowerCase();

  if (/inverter.*non|non.*inverter|inverter vs|vs inverter/i.test(lower)) {
    return `**Inverter vs Non-Inverter — Full Comparison:**\n\n| Feature | Inverter | Non-Inverter |\n|---------|----------|---------------|\n| Energy Use | 40–60% less | Standard |\n| Upfront Cost | Higher | Lower |\n| Monthly Bill | Lower | Higher |\n| Noise Level | Quieter | Louder |\n| Lifespan | 10–15 years | 5–10 years |\n| Best For | Daily use 8+ hrs | Occasional use |\n| Maintenance | Lower | Higher |\n\n**Verdict:** If you use AC daily (especially overnight), **inverter saves more money** long-term. For guest rooms or occasional use, non-inverter is more practical.\n\nWant to see specific inverter models and prices?`;
  }

  let response = "**Let me help you compare!**\n\n";

  if (knowledge.products.length > 0) {
    const byType = {};
    for (const p of knowledge.products) {
      const t = p.type || "other";
      if (!byType[t]) byType[t] = [];
      byType[t].push(p);
    }

    for (const [type, products] of Object.entries(byType).slice(0, 3)) {
      const typeName = type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      response += `**${typeName}:**\n`;
      for (const p of products.slice(0, 3)) {
        const hpList = p.hpOptions.map(h => `${h.hp}HP`).join(", ");
        const price = p.minPrice ? `₱${p.minPrice.toLocaleString()}+` : "Contact";
        response += `• ${p.brand || ""} ${p.model} — ${hpList} — ${price}${p.inverter ? " ⚡" : ""}\n`;
      }
      response += "\n";
    }
  }

  response += "What specific products or features do you want to compare?";
  return response;
}

// ─── Maintenance Tips ──────────────────────────────────────────────────────
function buildMaintenanceTipsResponse(session) {
  return `**AC Maintenance Tips:**\n\n**Monthly:**\n• Clean or replace air filters\n• Wipe down indoor unit exterior\n• Check remote batteries\n• Listen for unusual noises\n\n**Every 3 Months:**\n• Clean evaporator coils\n• Check drain line for clogs\n• Inspect outdoor unit clearance\n\n**Every 6 Months:**\n• Professional cleaning recommended\n• Check refrigerant levels\n• Inspect electrical connections\n\n**Yearly:**\n• Full professional maintenance\n• Chemical coil cleaning\n• Performance optimization\n\n**Pro Tips:**\n• Set temperature to 24–26°C for best efficiency\n• Use timer function instead of leaving on all day\n• Close windows and doors when AC is running\n• Don't block the outdoor unit\n• Clean filters regularly — dirty filters reduce efficiency by 15%\n\nWant a professional maintenance visit? We offer **Basic AMC at ₱1,200/year**!`;
}

// ─── AMC ───────────────────────────────────────────────────────────────────
function buildAMCResponse(session) {
  return `**Annual Maintenance Contracts (AMC):**\n\n**Basic — ₱1,200/year**\n• 2 maintenance visits\n• Filter cleaning & replacement\n• 10% discount on repairs\n\n**Standard — ₱2,400/year**\n• 4 maintenance visits\n• Complete system cleaning\n• Refrigerant check\n• 15% discount on repairs\n• Priority scheduling\n\n**Premium — ₱4,500/year**\n• 6 maintenance visits\n• Chemical coil cleaning\n• 24/7 emergency support\n• 20% discount on all services\n• Free refrigerant top-up\n\n**Commercial Plans:**\n• Small Business (up to 5 units): ₱8,000/year\n• Medium (6–15 units): ₱15,000/year\n• Large Enterprise: Custom pricing\n\nAMC saves you money and keeps your AC running efficiently! Want to subscribe?`;
}

// ─── Intelligent Fallback ──────────────────────────────────────────────────
function buildIntelligentFallback(text, session, knowledge) {
  const lower = text.toLowerCase();
  const words = tokenize(text);

  // Check for question patterns
  const isQuestion = /\?$|^(what|how|why|when|where|who|which|can|could|would|should|is|are|do|does|tell|explain|help|give|show|list|name)/i.test(text);

  // Check for general knowledge topics
  const generalTopics = {
    weather: /\b(weather|temperature|climate|rain|hot|cold|humid|init|lamig|ulan)\b/i,
    food: /\b(food|eat|cook|recipe|restaurant|meal|breakfast|lunch|dinner|kain|pagkain)\b/i,
    health: /\b(health|sick|illness|doctor|hospital|medicine|pain|headache|lagnat|sakit)\b/i,
    travel: /\b(travel|trip|vacation|hotel|flight|airport|tourism|byahe|biyahe)\b/i,
    money: /\b(money|salary|income|budget|savings|invest|loan|pera|sweldo)\b/i,
    tech: /\b(phone|laptop|computer|internet|wifi|software|app|gadget|tech|ai|chatgpt)\b/i,
    education: /\b(school|study|learn|university|college|student|homework|aral)\b/i,
    work: /\b(job|work|career|office|boss|employee|salary|trabaho)\b/i,
    entertainment: /\b(movie|music|game|sports|show|concert|fun|enjoy|laro)\b/i,
    relationship: /\b(love|relationship|date|girlfriend|boyfriend|friend|family|mahal|jowa)\b/i,
  };

  for (const [topic, pattern] of Object.entries(generalTopics)) {
    if (pattern.test(lower)) {
      const responses = buildGeneralKnowledgeResponse(topic, text, session);
      return responses;
    }
  }

  // Check for HVAC-adjacent questions
  if (words.some(w => ["electric", "electricity", "bill", "kuryente", "consume", "watt", "power"].includes(w))) {
    return `**Electricity & AC:**\n\nAir conditioners are the biggest electricity consumers in most homes (50–70% of the bill). Here's how to reduce costs:\n\n• **Use inverter units** — They save 40–60% on electricity\n• **Set to 24–26°C** — Every degree lower adds ~10% to your bill\n• **Use timer** — Don't leave it running all day\n• **Clean filters regularly** — Dirty filters make the compressor work harder\n• **Seal the room** — Close windows and doors when AC is running\n• **Use ceiling fans** — They let you set the AC temperature higher\n\nWant me to calculate estimated electricity costs for a specific unit?`;
  }

  if (words.some(w => ["recommend", "suggest", "best", "top", "advice", "tip", "what should"].includes(w)) && words.some(w => ["ac", "aircon", "unit", "cool"].includes(w))) {
    return `**My Top Recommendations:**\n\nIf I had to pick one AC for most Filipino homes, here's what I'd suggest:\n\n**For bedrooms (12–18 sqm):**\n• **1.0 HP Inverter Split Type** — Quietest, most efficient for sleeping\n• Budget: ₱15,000–₱25,000\n\n**For living rooms (20–30 sqm):**\n• **1.5–2.0 HP Inverter Split Type** — Best balance of power and efficiency\n• Budget: ₱22,000–₱40,000\n\n**For tight budgets:**\n• **Window Type Non-Inverter** — Lower upfront cost, still effective\n• Budget: ₱10,000–₱18,000\n\n**My #1 tip:** Go inverter if you use AC daily. The electricity savings pay for the price difference within 2–3 years.\n\nWant me to show you specific models in your budget?`;
  }

  // If it's a question we can't answer specifically, give a helpful response
  if (isQuestion) {
    const fallbacks = [
      `That's an interesting question! While I'm primarily an HVAC expert, I'll do my best to help.\n\nRegarding "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}" — I don't have specific information about that, but I can help with:\n\n• **Air conditioning** — products, pricing, troubleshooting\n• **HVAC services** — installation, repair, maintenance\n• **Booking** — scheduling a service\n• **General advice** — energy efficiency, room sizing\n\nWhat would you like to explore?`,
      `Great question! I'm not 100% certain about that specific topic, but I'd love to help where I can.\n\nMy specialties are:\n• **HVAC & Air Conditioning** — products, services, troubleshooting\n• **Energy Efficiency** — tips to save on electricity\n• **Room Comfort** — sizing, placement, maintenance\n\nWant to ask me something in my wheelhouse, or should I connect you with our team at **+63 917 888 9999** for more specific help?`,
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  // Conversational catch-all
  const catchAlls = [
    `I appreciate you reaching out! While my expertise is primarily in HVAC and air conditioning, I'm here to help however I can.\n\nIs there something specific about air conditioning, services, or our company I can help with? Or if you have a general question, feel free to ask — I'll do my best!`,
    `Thanks for the message! I'm RACS AI — your HVAC expert, but I can also chat about other topics.\n\nWhat brings you here today? Need help with:\n• Air conditioning products or services?\n• Troubleshooting an AC issue?\n• Booking a service?\n• Or just have a question?`,
  ];
  return catchAlls[Math.floor(Math.random() * catchAlls.length)];
}

// ─── General Knowledge Responses ───────────────────────────────────────────
function buildGeneralKnowledgeResponse(topic, text, session) {
  const responses = {
    weather: `**Weather & Air Conditioning:**\n\nIn the Philippines, the hot season (March–May) sees temperatures of 34–40°C. This is peak AC season!\n\n**Tips for hot weather:**\n• Set AC to 24–26°C (comfortable and efficient)\n• Close curtains/blinds during peak sun hours\n• Use ceiling fans alongside AC\n• Keep doors and windows sealed\n• Clean filters monthly during summer\n\n**Rainy season tip:** High humidity makes it feel warmer. Use "dry mode" on your AC to dehumidify without overcooling.\n\nNeed help with your AC for the current weather? Just ask!`,

    food: `I'm more of an AC expert than a chef 😄, but I can tell you this — a properly cooled room makes any meal more enjoyable!\n\nIs there something HVAC-related I can help with? Or if you'd like restaurant recommendations near our showrooms, I can point you in the right direction!`,

    health: `While I'm not a medical professional, I can share how AC affects health:\n\n**Good AC use benefits:**\n• Better sleep quality\n• Reduced heat stress\n• Less humidity means fewer allergens\n\n**Health tips with AC:**\n• Keep temperature at 24–26°C (not too cold)\n• Clean filters regularly to prevent mold/dust\n• Don't point vents directly at sleeping people\n• Ensure proper ventilation — don't seal the room completely\n• Use a humidifier if air gets too dry\n\nFor medical concerns, please consult a healthcare professional.`,

    travel: `Traveling in the Philippines? Here are some HVAC tips for your trip:\n\n• **Hotels** — Request rooms with good AC. Split type is usually quieter than window type.\n• **Airbnbs** — Check if AC is included, especially in provincial areas.\n• **Driving** — Car AC should be serviced before long trips.\n\nNeed help with your home AC before you leave? We offer maintenance packages to keep it running while you're away!`,

    money: `Here's how HVAC relates to your finances:\n\n**Savings with the right AC:**\n• Inverter units save ₱3,000–₱8,000/year on electricity\n• Regular maintenance prevents costly repairs\n• Proper sizing prevents energy waste\n\n**Investment tips:**\n• A ₱25,000 inverter AC saves ~₱5,000/year vs non-inverter\n• ROI in 3–5 years, then pure savings\n• AMC at ₱1,200/year prevents ₱5,000+ emergency repairs\n\nWant me to calculate savings for a specific unit?`,

    tech: `I'm actually an AI myself! While I'm specialized in HVAC, I can chat about tech:\n\n**Smart AC features:**\n• WiFi control — control your AC from your phone\n• Voice assistant integration (Google Home, Alexa)\n• Energy monitoring — track consumption in real-time\n• Auto-scheduling — learns your routine\n\n**My tech stack:**\nI'm built with Node.js and powered by AI to help you with HVAC questions.\n\nWant to know about smart AC options? We have several WiFi-enabled models!`,

    education: `**Learning about HVAC?** Here are some key concepts:\n\n**Basic AC principles:**\n• AC doesn't add cold air — it removes heat and humidity\n• Refrigerant circulates between indoor and outdoor units\n• Compressor is the "heart" of the system\n• SEER rating = efficiency (higher = better)\n\n**Career in HVAC:**\n• High demand in the Philippines\n• Good salary range (₱15,000–₱50,000+/month)\n• Requires technical training and certification\n\nInterested in learning more about HVAC? I can explain any concept!`,

    work: `**Workplace HVAC tips:**\n\n• **Office** — Ideal temp is 23–25°C for productivity\n• **Home office** — Split type is quietest for calls/meetings\n• **Commercial** — Consider VRF systems for multiple rooms\n\n**Energy at work:**\n• Turn off AC in unused rooms\n• Use programmable thermostats\n• Regular maintenance keeps efficiency high\n\nNeed help with commercial HVAC solutions? We have business packages!`,

    entertainment: `**Fun HVAC facts:**\n\n• The first AC was invented in 1902 by Willis Carrier\n• "AC" can stand for "Awesome Comfort" 😄\n• The Philippines has one of the highest AC ownership rates in SE Asia\n• A typical Filipino household uses AC for 8–12 hours/day\n\n**Entertainment + AC:**\n• Movie marathons are better in a properly cooled room\n• Gaming setups need good ventilation\n• Home theaters benefit from quiet split-type units\n\nWant to optimize your entertainment space? I can recommend the right AC setup!`,

    relationship: `**Relationships & Comfort:**\n\nA comfortable home makes relationships better! Here's how:\n\n• **Date night at home** — Set the perfect temperature (24°C is ideal)\n• **Quality sleep** — Quiet AC means better rest for both of you\n• **Family time** — A cool living room brings everyone together\n\n**Pro tip:** Inverter units are whisper-quiet — perfect for intimate conversations or movie nights.\n\nNeed help creating a more comfortable home environment? I'm here to help!`,
  };

  return responses[topic] || `That's an interesting topic! While my expertise is primarily in HVAC and air conditioning, I'd be happy to help if I can.\n\nIs there something specific about air conditioning, services, or our company I can assist with? Or feel free to ask me anything else — I'll do my best!`;
}

// ─── API Endpoint ──────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { message, history = [], sessionId } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required" });
    }

    const knowledge = await loadKnowledge();
    const session = getSession(sessionId || req.ip);

    // Merge client history into session for Gemini context
    if (history.length > 0) {
      const recentClient = history.slice(-10).map((h) => ({
        role: h.role,
        content: h.content,
      }));
      session.history = [...session.history, ...recentClient];
      if (session.history.length > 30) session.history = session.history.slice(-30);
    }

    const result = await generateResponse(message, session, knowledge);

    // Save to session history
    session.history.push({ role: "user", content: message, ts: Date.now() });
    session.history.push({ role: "bot", content: result.text, ts: Date.now() });
    if (session.history.length > 50) session.history = session.history.slice(-50);

    console.log(`[Chat] intent=${result.intent} sentiment=${session.sentiment} turn=${session.turnCount}`);

    res.json({
      reply: result.text,
      suggests: result.suggests,
      timestamp: new Date().toISOString(),
      meta: { intent: result.intent, turn: session.turnCount },
    });
  } catch (err) {
    console.error("[Chat] Error:", err.message);
    res.json({
      reply: "I'm having a small issue right now. Please try again or call our hotline at **+63 917 888 9999** for immediate help.",
      suggests: ["Products", "Services", "Contact"],
      timestamp: new Date().toISOString(),
      fallback: true,
    });
  }
});

// ─── Streaming Endpoint ────────────────────────────────────────────────────
router.post("/stream", async (req, res) => {
  try {
    const { message, history = [], sessionId } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required" });
    }

    const knowledge = await loadKnowledge();
    const session = getSession(sessionId || req.ip);

    // Merge client history
    if (history.length > 0) {
      const recentClient = history.slice(-10).map((h) => ({
        role: h.role,
        content: h.content,
      }));
      session.history = [...session.history, ...recentClient];
      if (session.history.length > 30) session.history = session.history.slice(-30);
    }

    // Update session state
    const [intent] = detectIntent(message);
    const sentiment = detectSentiment(message);
    session.turnCount++;
    session.sentiment = sentiment;
    session.lastIntent = intent;
    session.intentCount[intent] = (session.intentCount[intent] || 0) + 1;
    if (!session.topicsDiscussed.includes(intent)) session.topicsDiscussed.push(intent);

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Handle angry sentiment — no streaming, immediate escalation
    if (sentiment === "angry") {
      const escalationText = "I'm really sorry to hear about your frustration, and I completely understand. Let me help you right away.\n\nFor immediate assistance, please call our hotline at **+63 917 888 9999** — a real person will assist you immediately.\n\nYou can also email us at **info@racs.com**. We take your concerns very seriously and will resolve this as quickly as possible. 🙏";
      res.write(`data: ${JSON.stringify({ text: escalationText, done: true, fullText: escalationText })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();

      session.history.push({ role: "user", content: message, ts: Date.now() });
      session.history.push({ role: "bot", content: escalationText, ts: Date.now() });
      return;
    }

    // Try OpenRouter streaming first (free, intelligent)
    if (OPENROUTER_API_KEY) {
      const knowledgeContext = knowledgeToContext(knowledge);
      const systemPrompt = buildSystemPrompt(knowledgeContext, session);

      let orFull = "";
      const orSent = await callOpenRouterStream(systemPrompt, session.history, message, (chunk) => {
        orFull += chunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      });

      if (orSent) {
        res.write(`data: ${JSON.stringify({ done: true, fullText: orSent, suggests: getSuggests(intent) })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();

        session.history.push({ role: "user", content: message, ts: Date.now() });
        session.history.push({ role: "bot", content: orSent, ts: Date.now() });
        if (session.history.length > 50) session.history = session.history.slice(-50);
        console.log(`[Chat Stream] intent=${intent} via=openrouter turn=${session.turnCount} len=${orSent.length}`);
        return;
      }
      console.log("[Chat Stream] OpenRouter failed, falling back to Gemini/local");
    }

    // Try Gemini streaming
    if (GEMINI_API_KEY) {
      const knowledgeContext = knowledgeToContext(knowledge);
      const systemPrompt = buildSystemPrompt(knowledgeContext, session);

      let fullText = "";
      const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

      const contents = buildGeminiContents(session.history, message);

      try {
        const response = await fetch(streamUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
              temperature: 0.7,
              topP: 0.95,
              topK: 40,
              maxOutputTokens: 1024,
            },
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]") break;

                try {
                  const parsed = JSON.parse(data);
                  const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (text) {
                    fullText += text;
                    res.write(`data: ${JSON.stringify({ text })}\n\n`);
                  }
                } catch (e) {}
              }
            }
          }

          // Send done event
          res.write(`data: ${JSON.stringify({ done: true, fullText, suggests: getSuggests(intent) })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();

          // Save to session
          session.history.push({ role: "user", content: message, ts: Date.now() });
          session.history.push({ role: "bot", content: fullText, ts: Date.now() });
          if (session.history.length > 50) session.history = session.history.slice(-50);

          console.log(`[Chat Stream] intent=${intent} sentiment=${sentiment} turn=${session.turnCount} len=${fullText.length}`);
          return;
        }
      } catch (streamErr) {
        console.error("[Chat Stream] Gemini stream error:", streamErr.message);
      }
    }

    // Fallback: non-streaming response (OpenRouter → Gemini → local)
    const knowledgeContext = knowledgeToContext(knowledge);
    const systemPrompt = buildSystemPrompt(knowledgeContext, session);

    let fbReply = null;
    if (OPENROUTER_API_KEY) fbReply = await callOpenRouter(systemPrompt, session.history, message);
    if (!fbReply && GEMINI_API_KEY) fbReply = await callGemini(systemPrompt, session.history, message);

    if (fbReply) {
      res.write(`data: ${JSON.stringify({ text: fbReply, done: true, fullText: fbReply, suggests: getSuggests(intent) })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();

      session.history.push({ role: "user", content: message, ts: Date.now() });
      session.history.push({ role: "bot", content: fbReply, ts: Date.now() });
      if (session.history.length > 50) session.history = session.history.slice(-50);
      return;
    }

    // Final fallback — local intent response
    console.log("[Chat Stream] All AI unavailable, using local fallback");
    const result = await generateResponse(message, session, knowledge);
    res.write(`data: ${JSON.stringify({ text: result.text, done: true, fullText: result.text, suggests: result.suggests })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

    session.history.push({ role: "user", content: message, ts: Date.now() });
    session.history.push({ role: "bot", content: result.text, ts: Date.now() });
    if (session.history.length > 50) session.history = session.history.slice(-50);

  } catch (err) {
    console.error("[Chat Stream] Error:", err.message);
    res.write(`data: ${JSON.stringify({ text: "I'm having a small issue right now. Please try again or call **+63 917 888 9999** for immediate help.", done: true })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ─── Health Check ──────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  const knowledge = await loadKnowledge();
  res.json({
    status: "ok",
    mode: OPENROUTER_API_KEY ? "openrouter-ai" : GEMINI_API_KEY ? "gemini-ai" : "local-ai",
    openrouterConfigured: !!OPENROUTER_API_KEY,
    openrouterModel: OPENROUTER_API_KEY ? OPENROUTER_MODEL : null,
    geminiConfigured: !!GEMINI_API_KEY,
    products: knowledge.products.length,
    services: knowledge.services.length,
    activeSessions: sessions.size,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
