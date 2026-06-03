import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { OAuth2Client } from 'google-auth-library';
import dns from 'dns';

dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const app = express();
app.use(cors());
app.use(express.json());

// Test connection and initialize tables
const initDb = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL successfully');
    
    // Create Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create Temp Users table (to store OTP for signup verification)
    await client.query(`
      CREATE TABLE IF NOT EXISTS temp_users (
        email VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        password VARCHAR(255),
        otp VARCHAR(6),
        expires BIGINT
      );
    `);

    // Create Sign In OTPs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS signin_otps (
        email VARCHAR(255) PRIMARY KEY,
        otp VARCHAR(6),
        expires BIGINT
      );
    `);

    // Create History table
    await client.query(`
      CREATE TABLE IF NOT EXISTS history (
        id VARCHAR(255) PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        date VARCHAR(100) NOT NULL,
        confidence VARCHAR(100),
        download_url TEXT,
        preview_data JSONB,
        raw_text TEXT,
        rules JSONB,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    client.release();
    console.log('PostgreSQL database tables initialized');
  } catch (err) {
    console.error('Failed to connect or initialize PostgreSQL:', err);
  }
};
initDb();

const sendEmail = async (mailOptions) => {
  let smtpHost = 'smtp.gmail.com';
  try {
    const ips = await dns.promises.resolve4('smtp.gmail.com');
    if (ips && ips.length > 0) {
      smtpHost = ips[0];
      console.log(`Resolved smtp.gmail.com to IPv4: ${smtpHost}`);
    }
  } catch (err) {
    console.warn('DNS lookup failed for smtp.gmail.com, falling back to default:', err);
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      servername: 'smtp.gmail.com',
    },
  });

  return transporter.sendMail(mailOptions);
};

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper: Generate OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Middleware: Authenticate Token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// Route: Sign Up - Initial Request
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length > 0) return res.status(400).json({ error: 'User already exists' });

    const otp = generateOTP();
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO temp_users (email, name, password, otp, expires) 
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET name = $2, password = $3, otp = $4, expires = $5`,
      [email, name, hashedPassword, otp, expires]
    );

    const mailOptions = {
      from: `"IntelliBill Extract" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Verify Your Email - IntelliBill Extract',
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; background: #f0f4f8; border-radius: 12px; max-width: 450px; margin: auto; border: 1px solid #e1e8ed;">
          <h2 style="color: #1a73e8; text-align: center; margin-bottom: 20px;">Verification Code</h2>
          <p style="color: #4a5568; font-size: 16px;">Hello <b>${name}</b>,</p>
          <p style="color: #4a5568; font-size: 16px;">Use the code below to complete your registration for <b>IntelliBill Extract</b>:</p>
          <div style="background: #ffffff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; color: #1a73e8; letter-spacing: 5px; border-radius: 8px; margin: 25px 0; border: 2px dashed #cbd5e0;">
            ${otp}
          </div>
          <p style="color: #718096; font-size: 14px; text-align: center;">This code expires in 10 minutes.</p>
          <hr style="border: 0; border-top: 1px solid #e1e8ed; margin: 30px 0;">
          <p style="color: #a0aec0; font-size: 11px; text-align: center;">&copy; 2026 IntelliBill Extract. All rights reserved.</p>
        </div>
      `,
    };

    await sendEmail(mailOptions);
    res.status(200).json({ message: 'OTP sent to email. Please verify.' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: 'Failed to send OTP. Please check your email configuration.' });
  }
});

// Route: Sign Up - Verify OTP
app.post('/api/verify-signup', async (req, res) => {
  const { email, otp } = req.body;

  try {
    const tempResult = await pool.query('SELECT * FROM temp_users WHERE email = $1', [email]);
    if (tempResult.rows.length === 0) return res.status(400).json({ error: 'Registration expired. Please try again.' });
    
    const tempUser = tempResult.rows[0];
    if (tempUser.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
    if (Date.now() > Number(tempUser.expires)) return res.status(400).json({ error: 'OTP expired' });

    // Add to permanent users
    const userResult = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
      [tempUser.name, tempUser.email, tempUser.password]
    );
    const newUser = userResult.rows[0];

    // Clean up temp_users
    await pool.query('DELETE FROM temp_users WHERE email = $1', [email]);

    // Generate Token
    const token = jwt.sign({ id: newUser.id, email: newUser.email, name: newUser.name }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.status(200).json({ message: 'Account created successfully', token, user: { name: newUser.name, email: newUser.email } });
  } catch (error) {
    console.error('Verify signup error:', error);
    res.status(500).json({ error: 'Failed to verify signup' });
  }
});

// Route: Sign In - Initial Request
app.post('/api/signin', async (req, res) => {
  const { email, password } = req.body;

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) return res.status(400).json({ error: 'Invalid email or password' });

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

    const otp = generateOTP();
    const expires = Date.now() + 10 * 60 * 1000;

    await pool.query(
      `INSERT INTO signin_otps (email, otp, expires) 
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET otp = $2, expires = $3`,
      [email, otp, expires]
    );

    const mailOptions = {
      from: `"IntelliBill Extract" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Login Verification Code - IntelliBill Extract',
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; background: #eef2f7; border-radius: 12px; max-width: 450px; margin: auto; border: 1px solid #cfd9e1;">
          <h2 style="color: #2b6cb0; text-align: center; margin-bottom: 20px;">Login Verification</h2>
          <p style="color: #4a5568; font-size: 16px;">Hello,</p>
          <p style="color: #4a5568; font-size: 16px;">One-time password for your <b>IntelliBill Extract</b> login:</p>
          <div style="background: #ffffff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; color: #2b6cb0; letter-spacing: 5px; border-radius: 8px; margin: 25px 0; border: 2px solid #2b6cb0;">
            ${otp}
          </div>
          <p style="color: #718096; font-size: 14px; text-align: center;">This code is valid for 10 minutes.</p>
          <hr style="border: 0; border-top: 1px solid #cfd9e1; margin: 30px 0;">
          <p style="color: #a0aec0; font-size: 11px; text-align: center;">If you didn't request this, ignore this email.</p>
        </div>
      `,
    };

    await sendEmail(mailOptions);
    res.status(200).json({ message: 'OTP sent to email. Please verify login.' });
  } catch (error) {
    console.error('Signin error:', error);
    res.status(500).json({ error: 'Failed to send OTP.' });
  }
});

// Route: Sign In - Verify OTP
app.post('/api/verify-signin', async (req, res) => {
  const { email, otp } = req.body;

  try {
    const otpResult = await pool.query('SELECT * FROM signin_otps WHERE email = $1', [email]);
    if (otpResult.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired OTP' });

    const store = otpResult.rows[0];
    if (store.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
    if (Date.now() > Number(store.expires)) return res.status(400).json({ error: 'OTP expired' });

    await pool.query('DELETE FROM signin_otps WHERE email = $1', [email]);

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) return res.status(400).json({ error: 'User not found' });
    const user = userResult.rows[0];

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.status(200).json({ message: 'Logged in successfully', token, user: { name: user.name, email: user.email } });
  } catch (error) {
    console.error('Verify signin error:', error);
    res.status(500).json({ error: 'Failed to verify signin' });
  }
});

// Route: Protected Dashboard Info
app.get('/api/me', authenticateToken, (req, res) => {
  res.status(200).json({ user: req.user });
});

// Route: Google - Verify Identity
app.post('/api/google-verify', async (req, res) => {
  const { credential } = req.body;
  
  try {
    const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    
    if (!payload || !payload.email) throw new Error('Invalid Google account');

    // Find or create user in DB
    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [payload.email]);
    let user;
    if (userResult.rows.length === 0) {
      const dummyPassword = await bcrypt.hash(Math.random().toString(36), 10);
      const insertResult = await pool.query(
        'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email',
        [payload.name || payload.email, payload.email, dummyPassword]
      );
      user = insertResult.rows[0];
    } else {
      user = userResult.rows[0];
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name }, 
      process.env.JWT_SECRET, 
      { expiresIn: '24h' }
    );

    res.status(200).json({ 
      message: 'Google identity verified', 
      token, 
      user: { name: user.name, email: user.email } 
    });
  } catch (err) {
    console.error('Google Auth Error:', err);
    res.status(400).json({ error: 'Verification failed' });
  }
});

// Route: Fetch History for Logged-In User
app.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM history WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    // Format JSONB fields back to objects
    const formatted = result.rows.map(row => ({
      ...row,
      previewData: row.preview_data,
      rawText: row.raw_text,
      downloadUrl: row.download_url
    }));
    res.status(200).json(formatted);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Route: Save or Update History Record for Logged-In User
app.post('/api/history', authenticateToken, async (req, res) => {
  const { id, name, status, date, confidence, downloadUrl, previewData, rawText, rules, error } = req.body;
  if (!id || !name || !status) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const query = `
      INSERT INTO history (id, user_id, name, status, date, confidence, download_url, preview_data, raw_text, rules, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        confidence = EXCLUDED.confidence,
        download_url = EXCLUDED.download_url,
        preview_data = EXCLUDED.preview_data,
        raw_text = EXCLUDED.raw_text,
        rules = EXCLUDED.rules,
        error = EXCLUDED.error
      RETURNING *
    `;
    const result = await pool.query(query, [
      id,
      req.user.id,
      name,
      status,
      date,
      confidence,
      downloadUrl,
      previewData ? JSON.stringify(previewData) : null,
      rawText || null,
      rules ? JSON.stringify(rules) : null,
      error || null
    ]);
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error saving history:', err);
    res.status(500).json({ error: 'Failed to save history' });
  }
});

// Route: Clear History for Logged-In User
app.delete('/api/history', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM history WHERE user_id = $1', [req.user.id]);
    res.status(200).json({ message: 'History cleared successfully' });
  } catch (error) {
    console.error('Error clearing history:', error);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Auth server running on port ${PORT}`);
});
