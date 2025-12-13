console.log("Transaction route file loaded");

import express from "express";
const router = express.Router();
import db from "../config/db.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// ========================
// JWT Authentication
// ========================
const verifyToken = (req, res, next) => {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.clientId = decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// ========================
// Insert Notification
// ========================
async function insertNotification(userId, type, message) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, message, is_read, created_at)
       VALUES (?, ?, ?, 0, NOW())`,
      [userId, type, message]
    );
  } catch (err) {
    console.error("NOTIFICATION ERROR:", err);
  }
}

// ================================
// ✔ Loan Unlock (One-Time Only)
// ================================
const checkLoanEligibility = async (userId) => {
  try {
    // 1. Compute total balance (exclude loan account)
    const [rows] = await db.query(
      `SELECT SUM(balance) AS total_balance
       FROM account_type
       WHERE user_id = ?
         AND type_name != 'Loan'`,
      [userId]
    );

    const combined = rows[0].total_balance || 0;

    const REQUIRED_AMOUNT = 50000;

    // 2. Check if already unlocked
    const [exists] = await db.query(
      `SELECT id FROM user_loan_unlock WHERE user_id = ?`,
      [userId]
    );

    if (exists.length > 0) {
      return false; // already unlocked permanently
    }

    // 3. Unlock when reaching requirement
    if (combined >= REQUIRED_AMOUNT) {
      await db.query(
        `INSERT INTO user_loan_unlock (user_id, unlocked_at)
         VALUES (?, NOW())`,
        [userId]
      );

      await insertNotification(
        userId,
        null,
        "Congratulations! You are now eligible to loan services."
      );

      return true;
    }

    return false;
  } catch (err) {
    console.error("Loan eligibility check error:", err);
    return false;
  }
};



// ========================
// Account Freeze Checker
// ========================
async function checkAccountStatus(typeId) {
  try {
    const [rows] = await db.query(
      "SELECT account_status FROM account_type WHERE type_id = ? LIMIT 1",
      [typeId]
    );

    if (!rows.length) return { blocked: true, status: "Unknown" };

    const status = rows[0].account_status;
    return {
      blocked: status === "Frozen" || status === "Closed",
      status
    };
  } catch (err) {
    console.error("STATUS CHECK ERROR:", err);
    return { blocked: true, status: "Error" };
  }
}

// ========================
// 1️⃣ Deposit
// ========================
router.post("/deposit", verifyToken, async (req, res) => {
  try {
    const { typeId, amount } = req.body;

    if (!typeId || !amount || amount <= 0)
      return res.status(400).json({ message: "Invalid deposit data." });

    const { blocked, status } = await checkAccountStatus(typeId);
    if (blocked) return res.status(403).json({ message: `Cannot deposit: account is ${status}.` });

    const [acc] = await db.query(
      "SELECT * FROM account_type WHERE type_id=? AND user_id=?",
      [typeId, req.clientId]
    );
    if (!acc.length) return res.status(404).json({ message: "Account not found." });

    await db.query(
      `INSERT INTO transactions
       (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Deposit', ?, 'Deposit', NOW(), 'Completed')`,
      [typeId, amount]
    );

    await db.query("UPDATE account_type SET balance = balance + ? WHERE type_id=?", [amount, typeId]);

    await checkLoanEligibility(req.clientId);

    res.json({ message: `Deposit of ₱${amount} successful.` });
  } catch (err) {
    console.error("DEPOSIT ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 2️⃣ Withdraw
// ========================
router.post("/withdraw", verifyToken, async (req, res) => {
  try {
    const { typeId, amount } = req.body;

    if (!typeId || !amount || amount <= 0)
      return res.status(400).json({ message: "Invalid withdrawal data." });

    const { blocked, status } = await checkAccountStatus(typeId);
    if (blocked) return res.status(403).json({ message: `Cannot withdraw: account is ${status}.` });

    const [rows] = await db.query(
      "SELECT balance FROM account_type WHERE type_id=? AND user_id=?",
      [typeId, req.clientId]
    );
    if (!rows.length) return res.status(404).json({ message: "Account not found." });

    if (rows[0].balance < amount)
      return res.status(400).json({ message: "Insufficient funds." });

    await db.query(
      `INSERT INTO transactions
       (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Withdraw', ?, 'Withdrawal', NOW(), 'Completed')`,
      [typeId, amount]
    );

    await db.query("UPDATE account_type SET balance = balance - ? WHERE type_id=?", [amount, typeId]);

    await checkLoanEligibility(req.clientId);

    res.json({ message: `Withdrawal of ₱${amount} successful.` });
  } catch (err) {
    console.error("WITHDRAW ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 3️⃣ Transfer
// ========================
router.post("/transfer", verifyToken, async (req, res) => {
  try {
    const fromId = Number(req.body.fromTypeId);
    const toId = Number(req.body.toTypeId);
    const amt = Number(req.body.amount);

    if (!fromId || !toId || !amt || amt <= 0)
      return res.status(400).json({ message: "Invalid transfer data." });

    if (fromId === toId)
      return res.status(400).json({ message: "Cannot transfer to the same account." });

    const { blocked, status } = await checkAccountStatus(fromId);
    if (blocked) return res.status(403).json({ message: `Sender account is ${status}.` });

    const [senderRows] = await db.query(
      "SELECT balance, user_id FROM account_type WHERE type_id=? AND user_id=?",
      [fromId, req.clientId]
    );
    if (!senderRows.length)
      return res.status(404).json({ message: "Sender account not found." });

    const [recipientRows] = await db.query(
      "SELECT user_id FROM account_type WHERE type_id=?",
      [toId]
    );
    if (!recipientRows.length)
      return res.status(404).json({ message: "Recipient account not found." });

    if (senderRows[0].balance < amt)
      return res.status(400).json({ message: "Insufficient balance." });

    // Sender transaction
    await db.query(
      `INSERT INTO transactions
       (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Transfer', ?, ?, NOW(), 'Completed')`,
      [fromId, amt, `Transfer to account ${toId}`]
    );

    // Recipient transaction
    await db.query(
      `INSERT INTO transactions
       (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Transfer', ?, ?, NOW(), 'Completed')`,
      [toId, amt, `Received from account ${fromId}`]
    );

    // Update balances
    await db.query("UPDATE account_type SET balance = balance - ? WHERE type_id=?", [amt, fromId]);
    await db.query("UPDATE account_type SET balance = balance + ? WHERE type_id=?", [amt, toId]);

    // Notifications
    await insertNotification(req.clientId, "TRANSFER_OUTGOING", `You sent ₱${amt} to account ${toId}.`);
    await insertNotification(recipientRows[0].user_id, "TRANSFER_INCOMING", `You received ₱${amt} from account ${fromId}.`);

    await checkLoanEligibility(req.clientId);

    res.json({ message: `Transfer of ₱${amt} successful.` });
  } catch (err) {
    console.error("TRANSFER ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 4️⃣ General Transaction History
// ========================
router.get("/history", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*, a.account_number, a.type_name
       FROM transactions t
       JOIN account_type a ON t.type_id = a.type_id
       WHERE a.user_id = ?
       ORDER BY t.transaction_date DESC`,
      [req.clientId]
    );
    res.json(rows);
  } catch (err) {
    console.error("HISTORY ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 5️⃣ History by account type
// ========================
router.get("/history/account/:type", verifyToken, async (req, res) => {
  try {
    const type = req.params.type;

    const [rows] = await db.query(
      `SELECT t.*, a.account_number, a.type_name
       FROM transactions t
       JOIN account_type a ON t.type_id = a.type_id
       WHERE a.user_id = ? AND a.type_name = ?
       ORDER BY t.transaction_date DESC`,
      [req.clientId, type]
    );

    res.json(rows);
  } catch (err) {
    console.error("ACCT HISTORY ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

export default router;
