const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  estimatedCostUSD: { type: Number, default: 0, min: 0 },
  timeOfDay: { type: String, enum: ['Morning', 'Afternoon', 'Evening'], default: 'Afternoon' },
});

const DaySchema = new mongoose.Schema({
  dayNumber: { type: Number, required: true },
  title: { type: String, default: '' }, // e.g. "Asakusa & Old Tokyo"
  activities: { type: [ActivitySchema], default: [] },
});

const HotelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  tier: { type: String, enum: ['Budget', 'Mid-range', 'Luxury'], default: 'Mid-range' },
  estimatedCostNightUSD: { type: Number, default: 0 },
  rating: { type: String, default: '4.0/5' },
});

// Creative feature: AI Weather-Aware Packing Assistant
const PackingItemSchema = new mongoose.Schema({
  item: { type: String, required: true },
  category: {
    type: String,
    enum: ['Documents', 'Clothing', 'Gear', 'Other'],
    default: 'Other',
  },
  isPacked: { type: Boolean, default: false },
});

const BudgetSchema = new mongoose.Schema(
  {
    transport: { type: Number, default: 0 },
    accommodation: { type: Number, default: 0 },
    food: { type: Number, default: 0 },
    activities: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const TripSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true, // every list/lookup query filters by this
    },
    destination: { type: String, required: true, trim: true },
    durationDays: { type: Number, required: true, min: 1, max: 30 },
    budgetTier: { type: String, enum: ['Low', 'Medium', 'High'], required: true },
    interests: { type: [String], default: [] },
    itinerary: { type: [DaySchema], default: [] },
    hotels: { type: [HotelSchema], default: [] },
    estimatedBudget: { type: BudgetSchema, default: () => ({}) },
    packingList: { type: [PackingItemSchema], default: [] },
    generatedBy: { type: String, enum: ['gemini', 'fallback'], default: 'fallback' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Trip', TripSchema);
