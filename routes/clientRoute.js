console.log("Client route file loaded");

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

// ========================
// 1️⃣ SIGNUP 
// ========================
router.post('/signup', async (req, res) => {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
        return res.status(400).json({ message: "All fields are required." });
    }

    try {
        // Hash password
        const hashed = await bcrypt.hash(password, 10);

        // 1. Create User
        const [userResult] = await db.query(
            `INSERT INTO users (full_name, email, password) VALUES (?, ?, ?)`,
            [full_name, email, hashed]
        );

        const user_id = userResult.insertId;

        // -------------------------------
        // 2. AUTO-CREATE ACCOUNT TYPES
        // -------------------------------
        const accountsToCreate = [
            { type_name: 'Deposit', description: 'Deposit account', balance: 0.00, status: 'Open' },
            { type_name: 'Savings', description: 'Savings account', balance: 0.00, status: 'Open' },
            { type_name: 'Loan', description: 'Loan account', balance: 0.00, status: 'Frozen' } // LOAN LOCKED
        ];

        let createdAccounts = {};

        for (const acc of accountsToCreate) {
            const accountNumber = "ACCT-" + Math.floor(Math.random() * 900000000 + 100000000);

            const [accRes] = await db.query(
                `INSERT INTO account_type (user_id, account_number, type_name, description, balance, account_status)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [user_id, accountNumber, acc.type_name, acc.description, acc.balance, acc.status]
            );

            const type_id = accRes.insertId;

            createdAccounts[acc.type_name] = { type_id, balance: acc.balance };

            // -----------------------------
            // 3. INSERT SUBTYPES PER ACCOUNT
            // -----------------------------
            let subtypes = [];

            if (acc.type_name === "Deposit") {
                subtypes = ["Deposit", "Withdraw", "Transfer", "Transaction History"];
            }
            if (acc.type_name === "Savings") {
                subtypes = ["Savings", "Withdraw", "Transfer", "Savings Summary", "Transaction History"];
            }
            if (acc.type_name === "Loan") {
                subtypes = ["Tier 1", "Tier 2", "Tier 3", "Transaction History"];
            }

            for (const st of subtypes) {
                await db.query(
                    `INSERT INTO account_subtype (type_id, subtype_name, description)
                     VALUES (?, ?, ?)`,
                    [type_id, st, `${st} subtype for ${acc.type_name}`]
                );
            }
        }

        // -------------------------------
        // 4. SEND BACK LOGIN FRIENDLY DATA
        // -------------------------------
        return res.status(201).json({
            message: "Signup successful",
            user: {
                user_id,
                full_name,
                email,
                role: "client",
                deposit_type_id: createdAccounts.Deposit.type_id,
                savings_type_id: createdAccounts.Savings.type_id,
                loan_type_id: createdAccounts.Loan.type_id,
                deposit_balance: 0,
                savings_balance: 0,
                loan_balance: 0
            }
        });

    } catch (err) {
        console.error("Signup error:", err);
        return res.status(500).json({ message: "Internal server error." });
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

    // 1️⃣ Check if account exists
    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Account does not exist." });
    }

    const client = rows[0];

    // 2️⃣ Verify password
    const isMatch = await bcrypt.compare(password, client.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Incorrect password." });
    }

    // 3️⃣ Create JWT
    const token = jwt.sign(
      { id: client.user_id, email: client.email },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    // 4️⃣ Response
    res.json({
      message: "Login successful.",
      token,
      client: {
        id: client.user_id,
        full_name: client.full_name,
        email: client.email,
      },
    });

  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 8️⃣ GET BANK ACCOUNTS
// ========================
router.get("/accounts", authenticateClient, async (req, res) => {
  try {
    const clientId = req.clientId;
    const [accounts] = await db.query(
      "SELECT type_id, type_name, balance FROM account_type WHERE user_id = ?",
      [clientId]
    );

    if (accounts.length === 0)
      return res.status(404).json({ message: "No accounts found for this client." });

    res.json(accounts);
  } catch (err) {
    console.error(err);
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
      "SELECT user_id, full_name, email FROM users WHERE user_id = ?",
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
    const { fullName, email, password, contactNumber } = req.body;

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

    if (updates.length === 0) return res.status(400).json({ message: "No fields to update." });

    values.push(clientId);

    await db.query(`UPDATE users SET ${updates.join(", ")} WHERE user_id = ?`, values);
    res.json({ message: "Profile updated successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 5️⃣ FREEZE / UNFREEZE ACCOUNT
// ========================
router.put("/account/:accountId/freeze", authenticateClient, async (req, res) => {
  try {
    const clientId = req.clientId;
    const accountId = req.params.accountId;

    // Fetch current status
    const [rows] = await db.query(
      "SELECT account_status FROM account_type WHERE type_id = ? AND user_id = ?",
      [accountId, clientId]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Account not found" });

    let newStatus;
    switch (rows[0].account_status) {
      case "Frozen":
        newStatus = "Open";
        break;
      case "Open":
      case "Closed":
      default:
        newStatus = "Frozen";
        break;
    }

    await db.query("UPDATE account_type SET account_status = ? WHERE type_id = ?", [
      newStatus,
      accountId,
    ]);

    // Optional: create notification for this action
    await db.query(
      "INSERT INTO notifications (user_id, message) VALUES (?, ?)",
      [clientId, `Your account #${accountId} has been ${newStatus.toLowerCase()}.`]
    );

    res.json({ message: `Account status updated to ${newStatus}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 6️⃣ DELETE ACCOUNT REQUEST
// ========================
// Sets a pending deletion request for the user account
router.post("/delete-request", authenticateClient, async (req, res) => {
  try {
    const clientId = req.clientId;

    // Check if user already requested deletion
    const [existing] = await db.query(
      "SELECT * FROM users WHERE user_id = ? AND status = 'pending_deletion'",
      [clientId]
    );
    if (existing.length > 0) return res.status(400).json({ message: "Deletion already requested." });

    // Set account_status to PendingDeletion
    await db.query("UPDATE users SET account_status = 'pending_deletion' WHERE user_id = ?", [
      clientId,
    ]);

    // Optional: create notification
    await db.query(
      "INSERT INTO notifications (user_id, message) VALUES (?, ?)",
      [clientId, "Your account deletion request has been submitted and is pending admin approval."]
    );

    res.json({ message: "Account deletion request submitted. Awaiting admin approval." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 7️⃣ GET NOTIFICATIONS
// ========================
router.get("/notifications", authenticateClient, async (req, res) => {
  try {
    const userId = req.clientId;

    const [rows] = await db.query(
      `SELECT notification_id,type,message,is_read,created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    // Process SCHEDULED_FOR_DELETION to compute days remaining
    const notifications = rows.map(n => {
      if (n.type === "SCHEDULED_FOR_DELETION") {
        const created = new Date(n.created_at);
        const now = new Date();

        // 30 days window
        const totalMs = 30 * 24 * 60 * 60 * 1000;
        const passedMs = now - created;

        const remaining = Math.max(
          0,
          Math.ceil((totalMs - passedMs) / (1000 * 60 * 60 * 24))
        );

        return {
          ...n,
          days_remaining: remaining
        };
      }
      return n;
    });

    res.json(notifications);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

// ========================
// 8️⃣ MARK NOTIFICATIONS AS READ
// ========================
router.patch("/notifications/mark-read", authenticateClient, async (req, res) => {
  try {
    await db.query(
      "UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
      [req.clientId]
    );

    res.json({ message: "Notifications marked as read." });
  } catch (err) {
    console.error("MARK READ ERROR:", err);
    res.status(500).json({ message: "Server error." });
  }
});


router.get("/notifications/unread", authenticateClient, async (req, res) => {
  const [[{ unread }]] = await db.query(
    "SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0",
    [req.clientId]
  );
  res.json({ unread });
});


export default router;
