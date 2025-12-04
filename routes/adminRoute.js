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

    // Fetch account
    const [rows] = await db.query(
      "SELECT type_id, account_status, user_id FROM account_type WHERE type_id = ?",
      [typeId]
    );
    if (!rows.length) return res.status(404).json({ message: "Account not found." });

    const account = rows[0];

    // Check if already frozen
    if (account.account_status === "Frozen") {
      return res.status(400).json({ message: "Account is already frozen." });
    }

    // Update account status
    await db.query(
      "UPDATE account_type SET account_status = 'Frozen' WHERE type_id = ?",
      [typeId]
    );

    // Insert notification
    await db.query(
      "INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)",
      [account.user_id, "ACCOUNT_FROZEN", `Your account (${typeId}) has been frozen by admin.`]
    );

    // Log admin action
    await db.query(
      "INSERT INTO admin_actions (user_id, target_id, target_table, action_type, remarks) VALUES (?, ?, 'account_type', 'Update', ?)",
      [req.adminId, typeId, "Account hard frozen by admin"]
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

    // Fetch account
    const [rows] = await db.query(
      "SELECT type_id, account_status, user_id FROM account_type WHERE type_id = ?",
      [typeId]
    );
    if (!rows.length) return res.status(404).json({ message: "Account not found." });

    const account = rows[0];

    // Check if already open
    if (account.account_status === "Open") {
      return res.status(400).json({ message: "Account is already open." });
    }

    // Update account status
    await db.query(
      "UPDATE account_type SET account_status = 'Open' WHERE type_id = ?",
      [typeId]
    );

    // Insert notification
    await db.query(
      "INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)",
      [account.user_id, "ACCOUNT_UNFROZEN", `Your account (${typeId}) has been unfrozen by admin.`]
    );

    // Log admin action
    await db.query(
      "INSERT INTO admin_actions (user_id, target_id, target_table, action_type, remarks) VALUES (?, ?, 'account_type', 'Update', ?)",
      [req.adminId, typeId, "Account unfrozen by admin"]
    );

    res.json({ message: "Account unfrozen successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 4️⃣ HARD DELETE USER
// ========================
router.delete("/delete-user/:user_id", verifyAdminToken, async (req, res) => {
  try {
    const userId = req.params.user_id;

    // Check user exists and has requested deletion
    const [rows] = await db.query(
      "SELECT user_id, role, status FROM users WHERE user_id = ?",
      [userId]
    );

    if (!rows.length) return res.status(404).json({ message: "User not found." });
    if (rows[0].role !== "client")
      return res.status(403).json({ message: "Only clients can be deleted." });

    if (rows[0].status !== "pending_deletion")
      return res.status(400).json({ message: "User has not requested deletion." });

    // Hard delete user
    await db.query("DELETE FROM users WHERE user_id = ?", [userId]);

    // Log admin action
    await db.query(
      "INSERT INTO admin_actions (user_id, target_id, target_table, action_type, remarks) VALUES (?, ?, 'users', 'Delete', 'User hard deleted by admin')",
      [req.adminId, userId]
    );

    res.json({ message: "User and all related accounts/transactions deleted successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

export default router;
