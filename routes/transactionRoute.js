// routes/transactionRoute.js

import express from "express";
const router = express.Router();

import db from "../config/db.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// ========================
// Middleware to verify JWT
// ========================
const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer "))
    return res.status(401).json({ message: "Unauthorized" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.clientId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ========================
// 1️⃣ DEPOSIT MONEY
// ========================
router.post("/deposit", verifyToken, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0)
      return res.status(400).json({ message: "Invalid amount." });

    const referenceNumber = `DEP-${Date.now()}`;
    const year = new Date().getFullYear();

    await db.query(
      `INSERT INTO transactions (client_id, transaction_type, amount, reference_number, created_at, year)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      [req.clientId, "Deposit", amount, referenceNumber, year]
    );

    res.json({ message: `Deposit of ${amount} successful.`, referenceNumber });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 2️⃣ TRANSFER MONEY
// ========================
router.post("/transfer", verifyToken, async (req, res) => {
  try {
    const { recipientClientId, amount } = req.body;

    if (!recipientClientId || !amount || amount <= 0)
      return res.status(400).json({ message: "Invalid transfer data." });

    // Check recipient exists
    const [recipientRows] = await db.query(
      "SELECT id FROM clients WHERE id = ?",
      [recipientClientId]
    );
    if (recipientRows.length === 0)
      return res.status(404).json({ message: "Recipient not found." });

    const referenceNumber = `TRF-${Date.now()}`;
    const year = new Date().getFullYear();

    // Insert transfer for sender
    await db.query(
      `INSERT INTO transactions (client_id, transaction_type, amount, reference_number, created_at, year)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      [req.clientId, "Transfer", amount, referenceNumber, year]
    );

    // Insert transfer for recipient (as incoming transfer)
    await db.query(
      `INSERT INTO transactions (client_id, transaction_type, amount, reference_number, created_at, year)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      [recipientClientId, "Received Transfer", amount, referenceNumber, year]
    );

    res.json({ message: `Transferred ${amount} to client ${recipientClientId}.`, referenceNumber });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 3️⃣ REQUEST LOAN
// ========================
router.post("/loan", verifyToken, async (req, res) => {
  try {
    const { amount, reason } = req.body;

    if (!amount || amount <= 0 || !reason)
      return res.status(400).json({ message: "Invalid loan request." });

    const referenceNumber = `LOAN-${Date.now()}`;
    const year = new Date().getFullYear();

    await db.query(
      `INSERT INTO transactions 
        (client_id, transaction_type, amount, reason, reference_number, created_at, year)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
      [req.clientId, "Loan", amount, reason, referenceNumber, year]
    );

    res.json({ 
      message: `Loan request of ${amount} submitted.`, 
      referenceNumber 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 4️⃣ GET TRANSACTION HISTORY
// ========================
router.get("/history", verifyToken, async (req, res) => {
  try {
    const clientId = req.clientId;

    const [rows] = await db.query(
      `SELECT transaction_id, transaction_type, amount, reference_number, created_at, year
       FROM transactions
       WHERE client_id = ?
       ORDER BY created_at DESC`,
      [clientId]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

export default router;