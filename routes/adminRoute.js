// routes/adminRoutes.js
console.log("Admin route file loaded");

import express from "express";
const router = express.Router();
import bcrypt from "bcryptjs";
import db from "../config/db.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

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
// ADMIN LOGIN (from DB)
// ========================
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ message: "Email and password required." });

  try {
    // Fetch admin from DB
    const [rows] = await db.query(
      "SELECT * FROM users WHERE email = ? AND role = 'admin' AND status = 'Active'",
      [email]
    );

    if (rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials." });

    const admin = rows[0];

    // Compare password
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch)
      return res.status(401).json({ message: "Invalid credentials." });

    // Generate JWT
    const token = jwt.sign(
      { id: admin.user_id, email: admin.email, isAdmin: true },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({ message: "Login successful.", token });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 1️⃣ GET ALL CLIENTS
// ========================
router.get("/clients", verifyAdminToken, async (req, res) => {
  try {
    const [clients] = await db.query(
      "SELECT user_id, full_name, email, status, created_at FROM users WHERE role='client' ORDER BY created_at DESC"
    );
    res.json({ clients });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 2️⃣ GET ALL TRANSACTIONS
// ========================
router.get("/transactions", verifyAdminToken, async (req, res) => {
  try {
    const [transactions] = await db.query(
      `SELECT t.transaction_id, t.amount, t.transaction_type, t.description, t.transaction_date, t.status,
              a.account_number, u.full_name AS from_client
       FROM transactions t
       JOIN account_type a ON t.type_id = a.type_id
       JOIN users u ON a.user_id = u.user_id
       ORDER BY t.transaction_date DESC`
    );
    res.json({ transactions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// GET SINGLE CLIENT AND ACCOUNTS
// ========================
router.get("/client/:user_id/accounts", verifyAdminToken, async (req, res) => {
  try {
    const userId = req.params.user_id;

    // Get client info
    const [users] = await db.query(
      "SELECT user_id, full_name, email, status, created_at FROM users WHERE user_id = ? AND role='client'",
      [userId]
    );
    if (!users.length) return res.status(404).json({ message: "User not found." });
    const user = users[0];

    // Get accounts for the client
    const [accounts] = await db.query(
      `SELECT type_id, account_number, type_name, balance, account_status
       FROM account_type
       WHERE user_id = ?`,
      [userId]
    );

    res.json({ user, accounts });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// HARD FREEZE ACCOUNT
// ========================
router.post("/freeze-account/:type_id", verifyAdminToken, async (req, res) => {
    try {
        const typeId = req.params.type_id;

        const [rows] = await db.query(
            "SELECT type_id, account_status, user_id FROM account_type WHERE type_id = ?",
            [typeId]
        );

        if (!rows.length)
            return res.status(404).json({ message: "Account not found." });

        const account = rows[0];

        // Must match ENUM
        if (account.account_status !== "Pending Freeze")
            return res.status(400).json({ message: "No pending freeze request." });

        // Approve freeze
        await db.query(
            "UPDATE account_type SET account_status = 'Frozen' WHERE type_id = ?",
            [typeId]
        );

        await db.query(
            "INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)",
            [
                account.user_id,
                "ACCOUNT_FROZEN",
                `Your account (${typeId}) has been frozen by admin.`
            ]
        );

        res.json({ message: "Account hard frozen successfully." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error." });
    }
});

// ========================
// HARD UNFREEZE ACCOUNT
// ========================
router.post("/unfreeze-account/:type_id", verifyAdminToken, async (req, res) => {
    try {
        const typeId = req.params.type_id;

        const [rows] = await db.query(
            "SELECT type_id, account_status, user_id FROM account_type WHERE type_id = ?",
            [typeId]
        );

        if (!rows.length)
            return res.status(404).json({ message: "Account not found." });

        const account = rows[0];

        if (account.account_status !== "Pending Unfreeze")
            return res.status(400).json({ message: "No pending unfreeze request." });

        // Approve unfreeze
        await db.query(
            "UPDATE account_type SET account_status = 'Open' WHERE type_id = ?",
            [typeId]
        );

        await db.query(
            "INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)",
            [
                account.user_id,
                "ACCOUNT_UNFROZEN",
                `Your account (${typeId}) has been unfrozen by admin.`
            ]
        );

        res.json({ message: "Account unfrozen successfully." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error." });
    }
});

// ================================
// 4️⃣ ADMIN CONFIRMS USER DELETION (Sets 30-day final_deletion_at)
// ================================
router.delete("/delete-user/:user_id", verifyAdminToken, async (req, res) => {
  try {
    const userId = req.params.user_id;

    // 1. Check user exists
    const [rows] = await db.query(
      "SELECT * FROM users WHERE user_id = ?",
      [userId]
    );

    if (!rows.length)
      return res.status(404).json({ message: "User not found." });

    const user = rows[0];

    // Only clients can be deleted
    if (user.role !== "client")
      return res.status(403).json({ message: "Only client accounts can be deleted." });

    // User must have requested deletion
    if (user.status !== "pending_deletion")
      return res.status(400).json({ message: "User has not requested deletion." });

    // 2. Admin marks deletion as approved
    await db.query(
      `UPDATE users
       SET status = 'on_deletion',
           final_deletion_at = NOW() + INTERVAL 30 DAY
       WHERE user_id = ?`,
      [userId]
    );

    // 3. Log admin action
    await db.query(
      `INSERT INTO admin_actions 
       (user_id, target_id, target_table, action_type, remarks) 
       VALUES (?, ?, 'users', 'Delete', 'Admin approved user deletion; countdown started')`,
      [req.adminId, userId]
    );

    res.json({
      message:
        "User marked for deletion. Their account will be permanently deleted and archived after 30 days unless they log in to cancel.",
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error." });
  }
});

export default router;

// ================================
// ADMIN: Loan Requests (List / Approve / Deny)
// ================================
router.get("/loan-requests", verifyAdminToken, async (req, res) => {
  try {
    const statusQuery = (req.query && req.query.status) ? String(req.query.status).toLowerCase() : 'pending';
    let sql = `SELECT lr.id AS id, lr.user_id, lr.money_requested, lr.tier, lr.notes, lr.status, lr.created_at, lr.actioned_by, lr.actioned_at,
                      u.full_name, u.email
               FROM loan_requests lr
               JOIN users u ON lr.user_id = u.user_id`;
    const params = [];
    if (statusQuery !== 'all') {
      sql += ` WHERE LOWER(lr.status) = ?`;
      params.push(statusQuery);
    }
    sql += ` ORDER BY lr.created_at DESC`;

    const [rows] = await db.query(sql, params);
    res.json({ requests: rows });
  } catch (err) {
    console.error('Error fetching loan requests:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

router.post("/loan-requests/:id/approve", verifyAdminToken, async (req, res) => {
  try {
    const requestId = req.params.id;

    const [rows] = await db.query("SELECT * FROM loan_requests WHERE id = ?", [requestId]);
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Loan request not found.' });

    const reqRow = rows[0];
    const currentStatus = (reqRow.status || '').toLowerCase();
    if (currentStatus !== 'pending') {
      console.warn(`Loan request ${requestId} has status '${reqRow.status}' — cannot approve.`);
      return res.status(400).json({ message: `Loan request is not pending (current: ${reqRow.status}).` });
    }

    // Mark request approved
    await db.query("UPDATE loan_requests SET status = 'approved', actioned_by = ?, actioned_at = NOW() WHERE id = ?", [req.adminId, requestId]);

    // Credit loan account balance if loan account exists (non-fatal)
    try {
      const [acctRows] = await db.query("SELECT type_id FROM account_type WHERE user_id = ? AND type_name = 'Loan' LIMIT 1", [reqRow.user_id]);
      if (acctRows && acctRows.length > 0) {
        const typeId = acctRows[0].type_id;
        await db.query("UPDATE account_type SET balance = balance + ? WHERE type_id = ?", [reqRow.money_requested, typeId]);

        // insert transaction record for disbursement
        await db.query(
          `INSERT INTO transactions (type_id, transaction_type, amount, description, transaction_date, status)
           VALUES (?, 'Loan', ?, ?, NOW(), 'Completed')`,
          [typeId, reqRow.money_requested, `Loan approved (request ${requestId})`]
        );
      }
    } catch (innerErr) {
      console.error('Non-fatal disbursement error:', innerErr.stack || innerErr);
      // continue — the request is still marked approved
    }

    // notify user (non-fatal)
    try {
      await db.query("INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)", [reqRow.user_id, 'LOAN_APPROVED', `Your loan request (id: ${requestId}) has been approved.`]);
    } catch (notifyErr) {
      console.error('Non-fatal notification error:', notifyErr.stack || notifyErr);
    }

    res.json({ message: 'Loan request approved.' });
  } catch (err) {
    console.error('Error approving loan request:', err.stack || err);
    res.status(500).json({ message: 'Server error.', error: err.message });
  }
});

router.post("/loan-requests/:id/deny", verifyAdminToken, async (req, res) => {
  try {
    const requestId = req.params.id;

    const [rows] = await db.query("SELECT * FROM loan_requests WHERE id = ?", [requestId]);
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Loan request not found.' });

    const reqRow = rows[0];
    if (reqRow.status !== 'pending') return res.status(400).json({ message: 'Loan request is not pending.' });

    await db.query("UPDATE loan_requests SET status = 'denied', actioned_by = ?, actioned_at = NOW() WHERE id = ?", [req.adminId, requestId]);

    // notify user (non-fatal)
    try {
      await db.query("INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)", [reqRow.user_id, 'LOAN_DENIED', `Your loan request (id: ${requestId}) has been denied.`]);
    } catch (notifyErr) {
      console.error('Non-fatal notification error (deny):', notifyErr.stack || notifyErr);
    }
    res.json({ message: 'Loan request denied.' });
  } catch (err) {
    console.error('Error denying loan request:', err.stack || err);
    res.status(500).json({ message: 'Server error.', error: err.message });
  }
});