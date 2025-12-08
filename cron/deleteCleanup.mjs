import cron from "node-cron";
import db from "../config/db.js";

// Run every day at midnight
cron.schedule("0 0 * * *", async () => {
  console.log("⏳ Cron: Checking for users ready for final deletion...");

  try {
    // 1. Find users whose deletion window has ended
    const [users] = await db.query(`
      SELECT * 
      FROM users
      WHERE status = 'on_deletion'
      AND final_deletion_at <= NOW()
    `);

    if (!users.length) {
      console.log("No users ready for deletion today.");
      return;
    }

    for (const user of users) {
      console.log(`📌 Archiving + deleting user ${user.user_id}`);

      const userId = user.user_id;

      // ============================
      // 2. ARCHIVE USER
      // ============================
      await db.query(
        `INSERT INTO archived_users 
        (user_id, role, full_name, email, password, status, created_at,
         deleted_at, restore_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL 30 DAY)`,
        [
          user.user_id,
          user.role,
          user.full_name,
          user.email,
          user.password,
          user.status,
          user.created_at
        ]
      );

      // ============================
      // 3. ARCHIVE ACCOUNT TYPES
      // ============================
      const [accounts] = await db.query(
        `SELECT * FROM account_type WHERE user_id = ?`,
        [userId]
      );

      for (const acc of accounts) {
        await db.query(
          `INSERT INTO archived_account_type
           (type_id, user_id, account_number, type_name, description, balance,
            interest_earned, account_status, created_at, last_interest_date,
            deleted_at, restore_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL 30 DAY)`,
          [
            acc.type_id,
            acc.user_id,
            acc.account_number,
            acc.type_name,
            acc.description,
            acc.balance,
            acc.interest_earned,
            acc.account_status,
            acc.created_at,
            acc.last_interest_date
          ]
        );

        // ARCHIVE subtypes
        const [subtypes] = await db.query(
          `SELECT * FROM account_subtype WHERE type_id = ?`,
          [acc.type_id]
        );

        for (const st of subtypes) {
          await db.query(
            `INSERT INTO archived_account_subtype
             (subtype_id, type_id, subtype_name, description, deleted_at, restore_until)
             VALUES (?, ?, ?, ?, NOW(), NOW() + INTERVAL 30 DAY)`,
            [
              st.subtype_id,
              st.type_id,
              st.subtype_name,
              st.description
            ]
          );
        }

        // ARCHIVE transactions
        const [txns] = await db.query(
          `SELECT * FROM transactions WHERE type_id = ?`,
          [acc.type_id]
        );

        for (const tx of txns) {
          await db.query(
            `INSERT INTO archived_transactions
             (transaction_id, type_id, transaction_type, amount, transaction_date,
              status, description, deleted_at, restore_until)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW() + INTERVAL 30 DAY)`,
            [
              tx.transaction_id,
              tx.type_id,
              tx.transaction_type,
              tx.amount,
              tx.transaction_date,
              tx.status,
              tx.description
            ]
          );
        }
      }

      // ============================
      // 4. DELETE USER FROM LIVE TABLES
      // (CASCADE deletes accounts, subtypes, txns)
      // ============================
      await db.query(`DELETE FROM users WHERE user_id = ?`, [userId]);

      console.log(`✅ User ${userId} archived + deleted.`);
    }

    console.log("🎉 Cron cleanup completed successfully.");
  } catch (err) {
    console.error("❌ Cron job failed:", err);
  }
});
