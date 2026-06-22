const Trip = require('../models/Trip');
const asyncHandler = require('../utils/asyncHandler');
const aiAgent = require('../utils/aiAgent');

const VALID_BUDGET_TIERS = ['Low', 'Medium', 'High'];

/**
 * Loads a trip but ONLY if it belongs to the authenticated user. This is
 * the single choke point that enforces per-user data isolation for every
 * itinerary mutation in this file - never query Trip by _id alone.
 */
async function findOwnedTripOrThrow(tripId, userId) {
  const trip = await Trip.findOne({ _id: tripId, userId });
  if (!trip) {
    const err = new Error('Trip not found.');
    err.statusCode = 404;
    throw err;
  }
  return trip;
}

/** Keeps the "activities" line item (and the total) in sync after edits. */
function recalcActivitiesBudget(trip) {
  const activitiesTotal = trip.itinerary.reduce(
    (sum, day) => sum + day.activities.reduce((daySum, a) => daySum + (a.estimatedCostUSD || 0), 0),
    0
  );
  trip.estimatedBudget.activities = activitiesTotal;
  trip.estimatedBudget.total =
    (trip.estimatedBudget.transport || 0) +
    (trip.estimatedBudget.accommodation || 0) +
    (trip.estimatedBudget.food || 0) +
    activitiesTotal;
}

/* ------------------------------------------------------------------ */
/* Create / Read / Delete trips                                       */
/* ------------------------------------------------------------------ */

// POST /api/trips  - generate a brand new AI itinerary and persist it
const createTrip = asyncHandler(async (req, res) => {
  const { destination, durationDays, budgetTier, interests = [] } = req.body;

  if (!destination || !durationDays || !budgetTier) {
    return res.status(400).json({ message: 'destination, durationDays, and budgetTier are required.' });
  }
  if (!VALID_BUDGET_TIERS.includes(budgetTier)) {
    return res.status(400).json({ message: `budgetTier must be one of ${VALID_BUDGET_TIERS.join(', ')}.` });
  }
  const days = Number(durationDays);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return res.status(400).json({ message: 'durationDays must be an integer between 1 and 30.' });
  }

  const generated = await aiAgent.generateTripPlan({
    destination,
    durationDays: days,
    budgetTier,
    interests,
  });

  const trip = await Trip.create({
    userId: req.user.id,
    destination,
    durationDays: days,
    budgetTier,
    interests,
    itinerary: generated.itinerary,
    hotels: generated.hotels,
    estimatedBudget: generated.estimatedBudget,
    packingList: generated.packingList,
    generatedBy: generated.generatedBy,
  });

  res.status(201).json(trip);
});

// GET /api/trips - list current user's trips (lightweight, for dashboard cards)
const getTrips = asyncHandler(async (req, res) => {
  const trips = await Trip.find({ userId: req.user.id })
    .select('destination durationDays budgetTier interests estimatedBudget.total createdAt')
    .sort({ createdAt: -1 });
  res.json(trips);
});

// GET /api/trips/:id - full trip detail
const getTripById = asyncHandler(async (req, res) => {
  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);
  res.json(trip);
});

// DELETE /api/trips/:id
const deleteTrip = asyncHandler(async (req, res) => {
  const trip = await Trip.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!trip) {
    return res.status(404).json({ message: 'Trip not found.' });
  }
  res.json({ message: 'Trip deleted.', id: trip._id });
});

/* ------------------------------------------------------------------ */
/* Itinerary editing: add / remove activity, delete day, regenerate   */
/* ------------------------------------------------------------------ */

// POST /api/trips/:id/days/:dayNumber/activities
const addActivity = asyncHandler(async (req, res) => {
  const { title, description = '', estimatedCostUSD = 0, timeOfDay = 'Afternoon' } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ message: 'Activity title is required.' });
  }

  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);
  const day = trip.itinerary.find((d) => d.dayNumber === Number(req.params.dayNumber));
  if (!day) {
    return res.status(404).json({ message: `Day ${req.params.dayNumber} not found on this trip.` });
  }

  day.activities.push({ title: title.trim(), description, estimatedCostUSD, timeOfDay });
  recalcActivitiesBudget(trip);
  await trip.save();

  res.status(201).json(trip);
});

// DELETE /api/trips/:id/days/:dayNumber/activities/:activityId
const removeActivity = asyncHandler(async (req, res) => {
  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);
  const day = trip.itinerary.find((d) => d.dayNumber === Number(req.params.dayNumber));
  if (!day) {
    return res.status(404).json({ message: `Day ${req.params.dayNumber} not found on this trip.` });
  }

  const before = day.activities.length;
  day.activities = day.activities.filter((a) => a._id.toString() !== req.params.activityId);
  if (day.activities.length === before) {
    return res.status(404).json({ message: 'Activity not found.' });
  }

  recalcActivitiesBudget(trip);
  await trip.save();

  res.json(trip);
});

// DELETE /api/trips/:id/days/:dayNumber - removes the day and renumbers the rest
const deleteDay = asyncHandler(async (req, res) => {
  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);
  const dayNumber = Number(req.params.dayNumber);

  const exists = trip.itinerary.some((d) => d.dayNumber === dayNumber);
  if (!exists) {
    return res.status(404).json({ message: `Day ${dayNumber} not found on this trip.` });
  }

  trip.itinerary = trip.itinerary
    .filter((d) => d.dayNumber !== dayNumber)
    .sort((a, b) => a.dayNumber - b.dayNumber)
    .map((d, idx) => {
      d.dayNumber = idx + 1; // keep "Day 1..N" contiguous after deletion
      return d;
    });
  trip.durationDays = trip.itinerary.length;

  recalcActivitiesBudget(trip);
  await trip.save();

  res.json(trip);
});

// POST /api/trips/:id/days/:dayNumber/regenerate  body: { hint }
const regenerateDayController = asyncHandler(async (req, res) => {
  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);
  const dayNumber = Number(req.params.dayNumber);
  const day = trip.itinerary.find((d) => d.dayNumber === dayNumber);
  if (!day) {
    return res.status(404).json({ message: `Day ${dayNumber} not found on this trip.` });
  }

  const result = await aiAgent.regenerateDay({
    destination: trip.destination,
    budgetTier: trip.budgetTier,
    interests: trip.interests,
    dayNumber,
    durationDays: trip.durationDays,
    hint: req.body.hint || '',
  });

  day.title = result.title || day.title;
  day.activities = result.activities;

  recalcActivitiesBudget(trip);
  await trip.save();

  res.json(trip);
});

/* ------------------------------------------------------------------ */
/* Creative feature: AI Weather-Aware Packing Assistant                */
/* ------------------------------------------------------------------ */

// PATCH /api/trips/:id/packing/:itemId  body: { isPacked }
const togglePackingItem = asyncHandler(async (req, res) => {
  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);
  const item = trip.packingList.find((p) => p._id.toString() === req.params.itemId);
  if (!item) {
    return res.status(404).json({ message: 'Packing item not found.' });
  }

  item.isPacked = typeof req.body.isPacked === 'boolean' ? req.body.isPacked : !item.isPacked;
  await trip.save();

  res.json(trip);
});

// POST /api/trips/:id/packing/regenerate - re-run the packing assistant
const regeneratePackingList = asyncHandler(async (req, res) => {
  const trip = await findOwnedTripOrThrow(req.params.id, req.user.id);

  const packingList = await aiAgent.generatePackingList({
    destination: trip.destination,
    durationDays: trip.durationDays,
    budgetTier: trip.budgetTier,
    interests: trip.interests,
  });

  trip.packingList = packingList;
  await trip.save();

  res.json(trip);
});

module.exports = {
  createTrip,
  getTrips,
  getTripById,
  deleteTrip,
  addActivity,
  removeActivity,
  deleteDay,
  regenerateDayController,
  togglePackingItem,
  regeneratePackingList,
};
