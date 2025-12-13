console.log("Transaction route file loaded");

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
// Helper: Check if account is frozen/pending
// ========================
const checkAccountStatus = async (typeId) => {
  const [rows] = await db.query(
    "SELECT account_status FROM account_type WHERE type_id = ?",
    [typeId]
  );
  if (!rows.length) throw new Error("Account not found");

  const status = rows[0].account_status;
  if (['Frozen', 'Pending Freeze', 'Pending Unfreeze'].includes(status)) {
    return { blocked: true, status };
  }
  return { blocked: false, status };
};

// ========================
// Helper: Check if Loan Should Unlock
// ========================
const checkLoanEligibility = async (userId) => {
  try {
    const [rows] = await db.query(
      `SELECT 
         SUM(CASE WHEN type_name='Deposit' THEN balance ELSE 0 END) AS deposit_total,
         SUM(CASE WHEN type_name='Savings' THEN balance ELSE 0 END) AS savings_total
       FROM account_type
       WHERE user_id = ?`,
      [userId]
    );

    const deposit = rows[0].deposit_total || 0;
    const savings = rows[0].savings_total || 0;
    const combined = deposit + savings;

    const REQUIRED_AMOUNT = 10000; // Set your unlock requirement

    if (combined >= REQUIRED_AMOUNT) {
      const [loanRows] = await db.query(
        `SELECT * FROM account_type 
         WHERE user_id = ? AND type_name='Loan' AND account_status='Closed'`,
        [userId]
      );

      if (loanRows.length > 0) {
        await db.query(
          `UPDATE account_type 
           SET account_status='Open' 
           WHERE user_id=? AND type_name='Loan'`,
          [userId]
        );

        await insertNotification(
          userId,
          null,
          "Congratulations! Your loan account has been unlocked."
        );

        return true;
      }
    }

    return false;
  } catch (err) {
    console.error("Loan eligibility check error:", err);
    return false;
  }
};

// ========================
// Helper: Insert Notification
// ========================
async function insertNotification(userId, type, message) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, message, is_read, created_at)
       VALUES (?, ?, ?, 0, NOW())`,
      [userId, type, message]
    );
  } catch (err) {
    console.error("NOTIFICATION INSERT ERROR:", err);
  }
}

// ========================
// 1️⃣ DEPOSIT MONEY
// ========================
router.post("/deposit", verifyToken, async (req, res) => {
  try {
    const { typeId, amount } = req.body;

    if (!typeId || !amount || amount <= 0)
      return res.status(400).json({ message: "Invalid deposit data." });

    // Check freeze/unfreeze
    const { blocked, status } = await checkAccountStatus(typeId);
    if (blocked) return res.status(403).json({ message: `Cannot deposit: account is ${status}.` });

    const [accountRows] = await db.query(
      "SELECT * FROM account_type WHERE type_id = ? AND user_id = ?",
      [typeId, req.clientId]
    );
    if (!accountRows.length) return res.status(404).json({ message: "Account not found." });

    const referenceNumber = `DEP-${Date.now()}`;

    const [result] = await db.query(
      `INSERT INTO transactions (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Deposit', ?, 'Deposit into account', NOW(), 'Completed')`,
      [typeId, amount]
    );

    await db.query(
      "UPDATE account_type SET balance = balance + ? WHERE type_id = ?",
      [amount, typeId]
    );

    // 🔓 Auto-unlock loan
    await checkLoanEligibility(req.clientId);

    res.json({ message: `Deposit of ${amount} successful.`, transactionId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 2️⃣ WITHDRAW MONEY
// ========================
router.post("/withdraw", verifyToken, async (req, res) => {
  try {
    const { typeId, amount } = req.body;

    if (!typeId || !amount || amount <= 0)
      return res.status(400).json({ message: "Invalid withdrawal data." });

    // Check freeze/unfreeze
    const { blocked, status } = await checkAccountStatus(typeId);
    if (blocked) return res.status(403).json({ message: `Cannot withdraw: account is ${status}.` });

    const [accountRows] = await db.query(
      "SELECT * FROM account_type WHERE type_id = ? AND user_id = ?",
      [typeId, req.clientId]
    );
    if (!accountRows.length) return res.status(404).json({ message: "Account not found." });

    const account = accountRows[0];
    if (account.balance < amount) return res.status(400).json({ message: "Insufficient balance." });

    const referenceNumber = `WTH-${Date.now()}`;

    const [result] = await db.query(
      `INSERT INTO transactions (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Withdraw', ?, 'Withdrawal from account', NOW(), 'Completed')`,
      [typeId, amount]
    );

    await db.query(
      "UPDATE account_type SET balance = balance - ? WHERE type_id = ?",
      [amount, typeId]
    );

    await checkLoanEligibility(req.clientId);

    res.json({ message: `Withdrawal of ${amount} successful.`, transactionId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 3️⃣ TRANSFER MONEY
// ========================
router.post("/transfer", verifyToken, async (req, res) => {
  try {
    const { fromTypeId, toTypeId, amount } = req.body;

    const fromId = Number(fromTypeId);
    const toId = Number(toTypeId);
    const amt = Number(amount);

    if (!fromId || !toId || !amt || amt <= 0)
      return res.status(400).json({ message: "Invalid transfer data." });

    if (fromId === toId)
      return res.status(400).json({ message: "Cannot transfer to the same account." });

    // Check freeze/unfreeze for sender
    const { blocked: senderBlocked, status: senderStatus } = await checkAccountStatus(fromId);
    if (senderBlocked) return res.status(403).json({ message: `Cannot send: account is ${senderStatus}.` });

    const [fromRows] = await db.query(
      "SELECT * FROM account_type WHERE type_id = ? AND user_id = ?",
      [fromId, req.clientId]
    );
    if (!fromRows.length) return res.status(404).json({ message: "Sender account not found." });
    const sender = fromRows[0];

    const [toRows] = await db.query(
      "SELECT * FROM account_type WHERE type_id = ?",
      [toId]
    );
    if (!toRows.length) return res.status(404).json({ message: "Recipient account not found." });
    const recipient = toRows[0];

    if (sender.balance < amt) return res.status(400).json({ message: "Insufficient balance." });

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

    // Balance updates
    await db.query("UPDATE account_type SET balance = balance - ? WHERE type_id = ?", [amt, fromId]);
    await db.query("UPDATE account_type SET balance = balance + ? WHERE type_id = ?", [amt, toId]);

    // Notifications
    await insertNotification(req.clientId, "TRANSFER_OUTGOING", `You transferred ₱${amt.toFixed(2)} to account ${toId}.`);
    await insertNotification(recipient.user_id, "TRANSFER_INCOMING", `You received ₱${amt.toFixed(2)} from account ${fromId}.`);

    await checkLoanEligibility(req.clientId);

    res.json({ message: `Transfer of ₱${amt} completed.` });

  } catch (err) {
    console.error("TRANSFER ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 4️⃣ LOAN REQUEST
// ========================
router.post("/loan", verifyToken, async (req, res) => {
  try {
    const { typeId, amount, reason } = req.body;
    if (!typeId || !amount || amount <= 0 || !reason)
      return res.status(400).json({ message: "Invalid loan request." });

    // Check freeze/unfreeze
    const { blocked, status } = await checkAccountStatus(typeId);
    if (blocked) return res.status(403).json({ message: `Cannot request loan: account is ${status}.` });

    const [accountRows] = await db.query(
      "SELECT * FROM account_type WHERE type_id = ? AND user_id = ?",
      [typeId, req.clientId]
    );
    if (!accountRows.length) return res.status(404).json({ message: "Account not found." });

    const referenceNumber = `LOAN-${Date.now()}`;

    const [result] = await db.query(
      `INSERT INTO transactions (type_id, transaction_type, amount, description, transaction_date, status)
       VALUES (?, 'Loan Payment', ?, ?, NOW(), 'Pending')`,
      [typeId, amount, reason]
    );

    await insertNotification(req.clientId, result.insertId, `Loan request of ${amount} submitted.`);

    res.json({ message: `Loan request submitted.`, transactionId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 5️⃣ GET TRANSACTION HISTORY
// ========================
router.get("/history", verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.transaction_id, t.type_id, t.transaction_type, t.amount, t.transaction_date, t.status, t.description,
          a.account_number, a.type_name
       FROM transactions t
       JOIN account_type a ON t.type_id = a.type_id
       WHERE a.user_id = ?
       ORDER BY t.transaction_date DESC`,
      [req.clientId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 6️⃣ GET TRANSACTION HISTORY BY ACCOUNT TYPE
// ========================
router.get("/history/account/:accountType", verifyToken, async (req, res) => {
  try {
    const { accountType } = req.params;

    const [rows] = await db.query(
      `SELECT 
         t.transaction_id, t.type_id, t.transaction_type, t.amount, t.description, t.transaction_date,
         a.account_number, a.type_name
       FROM transactions t
       JOIN account_type a ON t.type_id = a.type_id
       WHERE a.user_id = ? AND a.type_name = ?
       ORDER BY t.transaction_date DESC`,
      [req.clientId, accountType]
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching account-type transactions:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 7️⃣ GET SAVINGS SUMMARY
// ========================
router.get("/savings/summary", verifyToken, async (req, res) => {
  try {
    const userId = req.clientId;
    const DAILY_RATE = 0.0001; // Daily interest rate (~3.65% annually)

    const [accRows] = await db.query(
      `SELECT type_id, balance, interest_earned, last_interest_date
       FROM account_type
       WHERE user_id = ? AND type_name = 'Savings'
       LIMIT 1`,
      [userId]
    );

    if (!accRows.length) return res.status(404).json({ message: "Savings account not found." });

    const acc = accRows[0];
    const typeId = acc.type_id;

    // Check freeze/unfreeze
    const { blocked, status } = await checkAccountStatus(typeId);
    if (blocked) return res.status(403).json({ message: `Cannot calculate savings: account is ${status}.` });

    let balance = parseFloat(acc.balance || 0);
    let interestEarnedTotal = parseFloat(acc.interest_earned || 0);

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    let lastStr = acc.last_interest_date;
    let days = 0;

    if (!lastStr) {
      await db.query(
        `UPDATE account_type SET last_interest_date = ? WHERE type_id = ?`,
        [todayStr, typeId]
      );
    } else {
      const t = new Date(todayStr);
      const l = new Date(lastStr);
      days = Math.floor((t - l) / (1000 * 60 * 60 * 24));
      days = days > 0 ? days : 0;
    }

    if (days >= 1) {
      const growth = Math.pow(1 + DAILY_RATE, days);
      const newBalance = balance * growth;

      const interest = newBalance - balance;
      const interestRounded = Math.round(interest * 100) / 100;
      const updatedBalance = Math.round((balance + interestRounded) * 100) / 100;

      await db.query(
        `UPDATE account_type
         SET balance = ?, interest_earned = interest_earned + ?, last_interest_date = ?
         WHERE type_id = ?`,
        [updatedBalance, interestRounded, todayStr, typeId]
      );

      if (interestRounded > 0) {
        await db.query(
          `INSERT INTO transactions
           (type_id, transaction_type, amount, description, transaction_date, status)
           VALUES (?, 'Interest', ?, ?, NOW(), 'Completed')`,
          [typeId, interestRounded, `Interest credited for ${days} day(s)`]
        );
      }

      balance = updatedBalance;
      interestEarnedTotal += interestRounded;
    }

    const [sumRows] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN transaction_type = 'Deposit' THEN amount END), 0) AS totalDeposits,
         COALESCE(SUM(CASE WHEN transaction_type = 'Withdraw' THEN amount END), 0) AS totalWithdrawals
       FROM transactions
       WHERE type_id = ?`,
      [typeId]
    );

    const totalDeposits = parseFloat(sumRows[0].totalDeposits || 0);
    const totalWithdrawals = parseFloat(sumRows[0].totalWithdrawals || 0);

    res.json({
      totalDeposits: Number(totalDeposits.toFixed(2)),
      totalWithdrawals: Number(totalWithdrawals.toFixed(2)),
      interestEarned: Number(interestEarnedTotal.toFixed(2)),
      currentSavings: Number(balance.toFixed(2))
    });

  } catch (err) {
    console.error("SAVINGS SUMMARY ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});

export default router;