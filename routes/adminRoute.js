// routes/adminRoutes.js
console.log("Admin route file loaded");

import express from "express";
const router = express.Router();

import db from "../config/db.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// ========================
// ADMIN LOGIN
// ========================
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ message: "Username and password required." });

  // Check against .env
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    // Generate JWT with isAdmin flag
    const token = jwt.sign({ username, isAdmin: true }, JWT_SECRET, { expiresIn: "8h" });

    return res.json({ message: "Login successful.", token });
  } else {
    return res.status(401).json({ message: "Invalid credentials." });
  }
});

// ========================
// Middleware to verify admin JWT
// ========================
const verifyAdminToken = (req, res, next) => {
  const token = req.headers["authorization"];
  if (!token) return res.status(401).json({ message: "No token provided." });

  try {
    const decoded = jwt.verify(token.split(" ")[1], JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ message: "Access denied." });
    req.adminId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token." });
  }
};

// ========================
// 1️⃣ GET ALL CLIENTS
// ========================
router.get("/clients", verifyAdminToken, async (req, res) => {
  try {
    const [clients] = await db.query(
      "SELECT id, full_name, email, created_at FROM bank_core.clients ORDER BY created_at DESC"
    );
    res.json({ clients });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 3️⃣ GET ALL TRANSACTIONS
// ========================
router.get("/transactions", verifyAdminToken, async (req, res) => {
  try {
    const [transactions] = await db.query(
      `SELECT t.transaction_id, t.amount, t.transaction_type, t.reason, t.created_at, t.reference_number, 
              c.full_name AS from_client
       FROM bank_core.transactions t
       JOIN bank_core.clients c ON t.client_id = c.id
       ORDER BY t.created_at DESC`
    );

    res.json({ transactions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 4️⃣ DELETE CLIENT
// ========================
router.delete("/client/:id", verifyAdminToken, async (req, res) => {
  try {
    const clientId = req.params.id;

    // Delete client accounts and transactions first to maintain integrity
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // Delete transactions related to this client's accounts
      await connection.query(
        `DELETE t FROM transactions t
         JOIN accounts a ON (t.from_account_id = a.id OR t.to_account_id = a.id)
         WHERE a.client_id = ?`,
        [clientId]
      );

      // Delete accounts
      await connection.query("DELETE FROM accounts WHERE client_id = ?", [clientId]);

      // Delete client
      await connection.query("DELETE FROM clients WHERE id = ?", [clientId]);

      await connection.commit();
      connection.release();

      res.json({ message: "Client and related accounts deleted successfully." });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

export default router;