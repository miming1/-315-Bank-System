import express from "express";
const router = express.Router();

import db from "../config/db.js"; 
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

// ===== JWT AUTH MIDDLEWARE =====
const authenticateClient = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.clientId = decoded.id; // attach client ID to request
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// 

// ========================
// 1️⃣ SIGNUP
// ========================
// inside clientRoute.js (replace your signup route with this)
router.post("/signup", async (req, res) => {
  try {
    const { fullName, email, password } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "All fields are required." });
    }

    // Check if email already exists
    const [existing] = await db.query("SELECT * FROM clients WHERE email = ?", [email]);
    if (existing.length > 0) {
      return res.status(400).json({ message: "Email already registered." });
    }

    // Hash password and insert new client
    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      "INSERT INTO clients (full_name, email, password) VALUES (?, ?, ?)",
      [fullName, email, hashedPassword]
    );

    const newClientId = result.insertId;

    // Create a JWT token so the user stays logged in
    const token = jwt.sign({ id: newClientId, email }, JWT_SECRET, { expiresIn: "8h" });

    res.status(201).json({
      message: "Signup successful.",
      token,
      client: { id: newClientId, fullName, email },
    });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 2️⃣ LOGIN
// ========================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required." });
    }

    const [rows] = await db.query("SELECT * FROM clients WHERE email = ?", [email]);

    if (rows.length === 0) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const client = rows[0];

    const isMatch = await bcrypt.compare(password, client.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const token = jwt.sign({ id: client.id, email: client.email }, JWT_SECRET, {
      expiresIn: "8h",
    });

    res.json({
      message: "Login successful.",
      token,
      client: {
        id: client.id,
        fullName: client.full_name,
        email: client.email,
      },
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 3️⃣ GET PROFILE
// ========================
router.get("/profile/me", authenticateClient, async (req, res) => {
  try {
    const clientId = req.clientId;
    const [rows] = await db.query(
      "SELECT id, full_name, email FROM clients WHERE id = ?",
      [clientId]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Client not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ========================
// 4️⃣ UPDATE PROFILE
// ========================
router.put("/profile/me", authenticateClient, async (req, res) => {
  try {
    const clientId = req.clientId;
    const { fullName, email, password } = req.body;

    const updates = [];
    const values = [];

    if (fullName) {
      updates.push("full_name = ?");
      values.push(fullName);
    }
    if (email) {
      updates.push("email = ?");
      values.push(email);
    }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push("password = ?");
      values.push(hashedPassword);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: "No fields to update." });
    }

    values.push(clientId);

    await db.query(`UPDATE clients SET ${updates.join(", ")} WHERE id = ?`, values);

    res.json({ message: "Profile updated successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

export default router;