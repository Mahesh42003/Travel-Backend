const express = require('express');
const requireAuth = require('../middleware/auth');
const {
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
} = require('../controllers/tripController');

const router = express.Router();

// Every route below requires a valid JWT; req.user.id is then available.
router.use(requireAuth);

router.post('/', createTrip);
router.get('/', getTrips);
router.get('/:id', getTripById);
router.delete('/:id', deleteTrip);

router.post('/:id/days/:dayNumber/activities', addActivity);
router.delete('/:id/days/:dayNumber/activities/:activityId', removeActivity);
router.delete('/:id/days/:dayNumber', deleteDay);
router.post('/:id/days/:dayNumber/regenerate', regenerateDayController);

router.patch('/:id/packing/:itemId', togglePackingItem);
router.post('/:id/packing/regenerate', regeneratePackingList);

module.exports = router;
