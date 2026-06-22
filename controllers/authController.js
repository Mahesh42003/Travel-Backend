const jwt = require('jsonwebtoken');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Name, email, and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters.' });
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ message: 'An account with that email already exists.' });
  }

  const user = await User.create({ name, email, password });
  const token = signToken(user._id);

  res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email } });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  // .select('+password') because the schema hides it by default.
  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  if (!user) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const match = await user.comparePassword(password);
  if (!match) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }

  const token = signToken(user._id);
  res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
});

// GET /api/auth/me (protected)
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }
  res.json({ user: { id: user._id, name: user.name, email: user.email } });
});

module.exports = { register, login, getMe };
