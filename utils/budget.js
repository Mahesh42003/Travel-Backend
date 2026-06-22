const TIER_MULTIPLIER = { Low: 0.6, Medium: 1, High: 1.8 };

const DAILY_RATES_USD = {
  accommodation: 70,
  food: 35,
  activities: 25,
  localTransport: 10,
};

const FLAT_FLIGHT_ESTIMATE_USD = 350;

/**
 * Produces a realistic-looking budget breakdown purely from
 * destination-agnostic heuristics. Used whenever the LLM is unavailable
 * and as a fallback if the LLM returns a malformed/missing budget object.
 */
function computeBudgetEstimate(durationDays, budgetTier) {
  const multiplier = TIER_MULTIPLIER[budgetTier] ?? 1;

  const accommodation = Math.round(DAILY_RATES_USD.accommodation * durationDays * multiplier);
  const food = Math.round(DAILY_RATES_USD.food * durationDays * multiplier);
  const activities = Math.round(DAILY_RATES_USD.activities * durationDays * multiplier);
  const transport = Math.round(
    FLAT_FLIGHT_ESTIMATE_USD * multiplier + DAILY_RATES_USD.localTransport * durationDays
  );

  return {
    transport,
    accommodation,
    food,
    activities,
    total: transport + accommodation + food + activities,
  };
}

module.exports = { computeBudgetEstimate };
