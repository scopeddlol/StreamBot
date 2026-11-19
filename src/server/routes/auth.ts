import { Router } from 'express';
import bcrypt from 'bcrypt';
import argon2 from 'argon2';
import config from '../../config.js';
import logger from '../../utils/logger.js';

const router = Router();
// Single-process dashboard: bounded login attempt window (not keyed by attacker input).
let attempts = 0;
let resetAt = 0;

// Login route - GET
router.get("/login", (req, res) => {
	res.render('pages/login', {
		error: req.query.error === '1',
		showLogout: false
	});
});

// Login route - POST
router.post("/login", async (req, res) => {
	if (Date.now() > resetAt) { attempts = 0; resetAt = Date.now() + 60000; }
  if (++attempts > 20) { res.status(429).send('Too many attempts; retry in one minute'); return; }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) { res.status(400).end(); return; }
	
	let isPasswordMatch = false;
	
	// Check if the stored password is a hash or plain text
	if (config.server_password.startsWith('$argon2')) {
		// Argon2 hash
		try {
			isPasswordMatch = await argon2.verify(config.server_password, password);
		} catch (err) {
			logger.error("Error verifying argon2 password:", err);
			isPasswordMatch = false;
		}
	} else if (config.server_password.startsWith('$2')) {
		// Bcrypt hash
		isPasswordMatch = await bcrypt.compare(password, config.server_password);
	} else {
		// Plain text (not recommended)
		isPasswordMatch = password === config.server_password;
	}
	
	if (username === config.server_username && isPasswordMatch) {
		await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    (req.session as { user?: unknown }).user = username;
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.redirect("/library");
	} else {
		res.redirect("/login?error=1");
	}
});

// Logout route
router.post("/logout", (req, res) => {
	req.session.destroy((err) => {
		if (err) {
			logger.error("Error destroying session:", err);
		}
		res.redirect("/login");
	});
});

export default router;