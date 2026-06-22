const { computeBudgetEstimate } = require('./budget');

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/* ------------------------------------------------------------------ */
/* Low-level Gemini transport with exponential backoff                */
/* ------------------------------------------------------------------ */

/**
 * Calls fetch with exponential backoff (1s, 2s, 4s, 8s, 16s) so transient
 * 429/5xx errors from the Gemini API don't take the whole request down.
 */
async function fetchWithRetry(url, options, retries = 5, delay = 1000) {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return fetchWithRetry(url, options, retries - 1, delay * 2);
      }
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini API error ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json();
  } catch (err) {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }
    throw err;
  }
}

/**
 * Sends a single-turn prompt to Gemini, forcing JSON output, and returns
 * the parsed JS object. Throws if the key is missing or the response
 * can't be parsed - callers are expected to fall back gracefully.
 */
async function callGeminiJSON(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };

  const data = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('Gemini response did not contain generated text');
  }

  // Models occasionally wrap JSON in ```json fences despite the mime type
  // request - strip those defensively before parsing.
  const cleaned = rawText.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
  return JSON.parse(cleaned);
}

/* ------------------------------------------------------------------ */
/* Prompt builders                                                    */
/* ------------------------------------------------------------------ */

function buildItineraryPrompt({ destination, durationDays, budgetTier, interests }) {
  return `You are a meticulous travel planning agent.
Create a detailed ${durationDays}-day travel itinerary for ${destination}.
The traveler's budget preference is "${budgetTier}" (Low, Medium, or High).
Their interests are: ${interests.join(', ') || 'general sightseeing'}.

Respond with ONLY a valid JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "itinerary": [
    {
      "dayNumber": 1,
      "title": "Short evocative title for the day",
      "activities": [
        { "title": "Activity name", "description": "One sentence of detail", "estimatedCostUSD": 20, "timeOfDay": "Morning" }
      ]
    }
  ],
  "hotels": [
    { "name": "Hotel name", "tier": "Budget", "estimatedCostNightUSD": 60, "rating": "4.2/5" }
  ],
  "estimatedBudget": { "transport": 400, "accommodation": 300, "food": 150, "activities": 100, "total": 950 },
  "packingList": [
    { "item": "Passport", "category": "Documents", "isPacked": false }
  ]
}

Rules:
- "itinerary" must contain exactly ${durationDays} entries, dayNumber 1..${durationDays}.
- Each day should have 2-4 activities relevant to the stated interests.
- "hotels" must contain exactly 3 entries: one "Budget", one "Mid-range", one "Luxury" tier.
- Costs must be realistic for ${destination} and scale with the "${budgetTier}" preference.
- "packingList" must include travel documents, climate-appropriate clothing for ${destination}, and gear tied to the planned activities, categorized as one of Documents, Clothing, Gear, Other.`;
}

function buildRegenerateDayPrompt({ destination, budgetTier, interests, dayNumber, durationDays, hint }) {
  return `You are a travel planning agent revising a single day of an existing itinerary.
Trip context: ${durationDays}-day trip to ${destination}, "${budgetTier}" budget, interests: ${interests.join(', ') || 'general sightseeing'}.
Regenerate ONLY day ${dayNumber}, following this traveler instruction: "${hint || 'surprise me with something different'}".

Respond with ONLY a valid JSON object, no prose, no markdown fences:
{
  "dayNumber": ${dayNumber},
  "title": "Short evocative title for the day",
  "activities": [
    { "title": "Activity name", "description": "One sentence of detail", "estimatedCostUSD": 20, "timeOfDay": "Morning" }
  ]
}
Include 2-4 activities that respect the traveler's instruction above.`;
}

function buildPackingListPrompt({ destination, durationDays, budgetTier, interests }) {
  return `You are an AI packing specialist. A traveler is going on a ${durationDays}-day, "${budgetTier}"-budget trip to ${destination}, interested in: ${interests.join(', ') || 'general sightseeing'}.

Respond with ONLY a valid JSON array, no prose, no markdown fences, of 6-12 packing items:
[
  { "item": "Passport", "category": "Documents", "isPacked": false }
]
Categories must be one of Documents, Clothing, Gear, Other. Tailor "Clothing" to the likely climate of ${destination} and "Gear" to the stated interests/activities.`;
}

/* ------------------------------------------------------------------ */
/* Deterministic offline fallback (no API key / API failure)          */
/* ------------------------------------------------------------------ */

const ACTIVITY_POOL = {
  Food: ['Street food crawl', 'Local market breakfast', 'Cooking class', 'Rooftop dinner with a view'],
  Culture: ['Historic temple/landmark visit', 'Local museum', 'Guided old-town walking tour', 'Traditional craft workshop'],
  Adventure: ['Day hike with scenic views', 'Bike tour along the coast/river', 'Watersports session', 'Sunrise viewpoint trek'],
  Shopping: ['Flagship shopping district stroll', 'Artisan market browsing', 'Souvenir hunting in the old quarter', 'Boutique-lined neighborhood walk'],
  Nightlife: ['Live music venue', 'Rooftop bar at sunset', 'Night market stroll', 'Evening river/harbor cruise'],
  Nature: ['Botanical garden visit', 'Scenic park picnic', 'Wildlife or nature reserve visit', 'Waterfront sunset walk'],
};
const DEFAULT_ACTIVITIES = ['City orientation walk', 'Landmark photo stop', 'Local neighborhood exploration'];

const TIME_SLOTS = ['Morning', 'Afternoon', 'Evening'];

function pickActivitiesForInterests(interests, count) {
  const pools = (interests.length ? interests : Object.keys(ACTIVITY_POOL))
    .map((i) => ACTIVITY_POOL[i])
    .filter(Boolean);
  const flat = pools.length ? pools.flat() : DEFAULT_ACTIVITIES;
  const shuffled = [...flat].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).length ? shuffled.slice(0, count) : DEFAULT_ACTIVITIES.slice(0, count);
}

function fallbackItinerary({ destination, durationDays, budgetTier, interests }) {
  const perActivityCost = { Low: 12, Medium: 22, High: 45 }[budgetTier] || 20;

  const itinerary = Array.from({ length: durationDays }, (_, i) => {
    const dayNumber = i + 1;
    const count = 2 + (i % 2); // alternate 2/3 activities
    const titles = pickActivitiesForInterests(interests, count);
    return {
      dayNumber,
      title: `${destination} — Day ${dayNumber}`,
      activities: titles.map((title, idx) => ({
        title,
        description: `Enjoy ${title.toLowerCase()} in ${destination}.`,
        estimatedCostUSD: perActivityCost + idx * 5,
        timeOfDay: TIME_SLOTS[idx % TIME_SLOTS.length],
      })),
    };
  });

  const nightlyRate = { Low: 45, Medium: 90, High: 220 }[budgetTier] || 90;
  const hotels = [
    { name: `${destination} Budget Inn`, tier: 'Budget', estimatedCostNightUSD: Math.round(nightlyRate * 0.5), rating: '4.0/5' },
    { name: `${destination} Grand Hotel`, tier: 'Mid-range', estimatedCostNightUSD: nightlyRate, rating: '4.4/5' },
    { name: `The ${destination} Imperial`, tier: 'Luxury', estimatedCostNightUSD: Math.round(nightlyRate * 2.4), rating: '4.8/5' },
  ];

  const packingList = fallbackPackingList({ destination, durationDays, budgetTier, interests });

  return {
    itinerary,
    hotels,
    estimatedBudget: computeBudgetEstimate(durationDays, budgetTier),
    packingList,
  };
}

function fallbackRegenerateDay({ destination, dayNumber, budgetTier, interests, hint }) {
  const perActivityCost = { Low: 12, Medium: 22, High: 45 }[budgetTier] || 20;
  const count = 2 + Math.floor(Math.random() * 2);

  // If the hint mentions a known interest keyword, bias selection toward it.
  const hintLower = (hint || '').toLowerCase();
  const matched = Object.keys(ACTIVITY_POOL).find((k) => hintLower.includes(k.toLowerCase()));
  const titles = pickActivitiesForInterests(matched ? [matched] : interests, count);

  return {
    dayNumber,
    title: `${destination} — Day ${dayNumber} (Revised)`,
    activities: titles.map((title, idx) => ({
      title,
      description: `Enjoy ${title.toLowerCase()} in ${destination}.`,
      estimatedCostUSD: perActivityCost + idx * 5,
      timeOfDay: TIME_SLOTS[idx % TIME_SLOTS.length],
    })),
  };
}

const PACKING_BASE = [
  { item: 'Passport / ID', category: 'Documents' },
  { item: 'Travel insurance documents', category: 'Documents' },
  { item: 'Printed/digital booking confirmations', category: 'Documents' },
  { item: 'Phone charger & adapter', category: 'Gear' },
  { item: 'Reusable water bottle', category: 'Gear' },
  { item: 'Comfortable walking shoes', category: 'Clothing' },
];

function fallbackPackingList({ destination, interests }) {
  const items = [...PACKING_BASE];

  if (interests.includes('Adventure') || interests.includes('Nature')) {
    items.push({ item: 'Hiking boots', category: 'Gear' }, { item: 'Lightweight rain jacket', category: 'Clothing' });
  }
  if (interests.includes('Culture')) {
    items.push({ item: 'Modest clothing for temples/religious sites', category: 'Clothing' });
  }
  if (interests.includes('Nightlife')) {
    items.push({ item: 'Evening outfit', category: 'Clothing' });
  }
  items.push({ item: `Weather-appropriate layers for ${destination}`, category: 'Clothing' });
  items.push({ item: 'Sunscreen / sun protection', category: 'Other' });

  return items.map((i) => ({ ...i, isPacked: false }));
}

/* ------------------------------------------------------------------ */
/* Public API - tries Gemini first, falls back to local generation    */
/* ------------------------------------------------------------------ */

async function generateTripPlan(params) {
  try {
    const result = await callGeminiJSON(buildItineraryPrompt(params));
    if (!Array.isArray(result.itinerary) || result.itinerary.length === 0) {
      throw new Error('Gemini returned an empty itinerary');
    }
    if (!result.estimatedBudget || typeof result.estimatedBudget.total !== 'number') {
      result.estimatedBudget = computeBudgetEstimate(params.durationDays, params.budgetTier);
    }
    return { ...result, generatedBy: 'gemini' };
  } catch (err) {
    console.warn('[aiAgent] Gemini itinerary generation failed, using fallback generator:', err.message);
    return { ...fallbackItinerary(params), generatedBy: 'fallback' };
  }
}

async function regenerateDay(params) {
  try {
    const result = await callGeminiJSON(buildRegenerateDayPrompt(params));
    if (!Array.isArray(result.activities) || result.activities.length === 0) {
      throw new Error('Gemini returned no activities for the regenerated day');
    }
    return { ...result, generatedBy: 'gemini' };
  } catch (err) {
    console.warn('[aiAgent] Gemini day regeneration failed, using fallback generator:', err.message);
    return { ...fallbackRegenerateDay(params), generatedBy: 'fallback' };
  }
}

async function generatePackingList(params) {
  try {
    const result = await callGeminiJSON(buildPackingListPrompt(params));
    if (!Array.isArray(result) || result.length === 0) {
      throw new Error('Gemini returned an empty packing list');
    }
    return result.map((i) => ({ ...i, isPacked: false }));
  } catch (err) {
    console.warn('[aiAgent] Gemini packing list generation failed, using fallback generator:', err.message);
    return fallbackPackingList(params);
  }
}

module.exports = { generateTripPlan, regenerateDay, generatePackingList };
